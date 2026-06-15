"""
shared/models.py — Four signal models ported from the poly.md framework.

Each model is a pure function:
    generate_signal(features: Features) -> Signal | None

None = no trade this bar.  Signal includes direction, strength (0–3), and
the originating model name.

Model roster (matches poly.md spec):
  1. KC_REVERSION     — Keltner Channel Mean Reversion + OFI confirmation
  2. FLOW_TOXICITY    — Spot Order Flow Toxicity (VPIN + pressure + depth)
  3. LOW_VOL_ACCUM    — Low Volatility Accumulation (volume surge)
  4. HIGH_VOL_MOMENTUM — High Volatility Momentum (5-min price change)
"""

from __future__ import annotations

from typing import Optional

from shared.types import Direction, Features, ModelName, Regime, Signal


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _make_signal(
    features: Features,
    model: ModelName,
    direction: Direction,
    strength: float,
) -> Signal:
    return Signal(
        timestamp=features.timestamp,
        asset=features.asset,
        model=model,
        direction=direction,
        strength=min(strength, 3.0),
        regime=features.regime,
        features=features,
    )


def _safe_float(value, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# Model 1 — KC Mean Reversion
# ---------------------------------------------------------------------------
# Entry conditions (from poly.md):
#   LONG (UP):   price < KC_lower  AND  ofi_zscore < -1.5
#   SHORT (DOWN): price > KC_upper  AND  ofi_zscore > +1.5
#
# Signal strength = min(|price - KC_limit| / ATR, 3.0)
# Rationale: The further price is stretched beyond the band, combined with
# order-flow confirming exhaustion, the higher the mean-reversion edge.
# ---------------------------------------------------------------------------

KC_OFI_THRESHOLD = 1.5   # OFI z-score magnitude required for confirmation


def model_kc_reversion(features: Features, params: Optional[dict] = None) -> Optional[Signal]:
    params = params or {}
    close = features.close
    kc_upper = features.kc_upper
    kc_lower = features.kc_lower
    atr = features.atr
    ofi_z = features.ofi_zscore
    z = features.zscore

    ofi_threshold = _safe_float(params.get("ofi_threshold"), KC_OFI_THRESHOLD)
    zscore_min = _safe_float(params.get("zscore_min"), 0.9)

    if features.regime == Regime.HIGH:
        ofi_threshold *= 1.15
        zscore_min *= 1.20
    elif features.regime == Regime.LOW:
        ofi_threshold *= 0.90
        zscore_min *= 0.90

    if atr < 1e-12:
        return None

    if close < kc_lower and ofi_z < -ofi_threshold and z < -zscore_min:
        # Price compressed below lower band, selling exhausted → expect UP
        base = abs(close - kc_lower) / atr
        flow_bonus = min(abs(ofi_z) / max(ofi_threshold, 1e-9), 2.0) * 0.35
        z_bonus = min(abs(z) / max(zscore_min, 1e-9), 2.0) * 0.25
        strength = min(base + flow_bonus + z_bonus, 3.0)
        return _make_signal(features, ModelName.KC_REVERSION, Direction.UP, strength)

    if close > kc_upper and ofi_z > ofi_threshold and z > zscore_min:
        # Price stretched above upper band, buying exhausted → expect DOWN
        base = abs(close - kc_upper) / atr
        flow_bonus = min(abs(ofi_z) / max(ofi_threshold, 1e-9), 2.0) * 0.35
        z_bonus = min(abs(z) / max(zscore_min, 1e-9), 2.0) * 0.25
        strength = min(base + flow_bonus + z_bonus, 3.0)
        return _make_signal(features, ModelName.KC_REVERSION, Direction.DOWN, strength)

    return None


# ---------------------------------------------------------------------------
# Model 2 — Order Flow Toxicity  (VPIN)
# ---------------------------------------------------------------------------
# Triggers on (from poly.md):
#   HIGH VPIN (> 0.7) + buy pressure (imbalance > 0.3) + low depth (< 0.6) → UP
#   HIGH VPIN (> 0.7) + sell pressure (imbalance < -0.3) + low depth (< 0.6) → DOWN
#
# Strength = VPIN * 2.0  (high conviction)
# Rationale: Informed traders are moving the book; follow their direction
# before it resolves against uninformed flow.
# ---------------------------------------------------------------------------

VPIN_THRESHOLD = 0.70
IMBALANCE_THRESHOLD = 0.30
DEPTH_RATIO_LOW = 0.60


def model_flow_toxicity(features: Features, params: Optional[dict] = None) -> Optional[Signal]:
    params = params or {}
    vpin = features.vpin
    imbalance = features.bid_ask_imbalance
    depth_ratio = features.depth_ratio
    ofi_z = features.ofi_zscore

    vpin_threshold = _safe_float(params.get("vpin_threshold"), VPIN_THRESHOLD)
    imbalance_threshold = _safe_float(params.get("imbalance_threshold"), IMBALANCE_THRESHOLD)
    depth_ratio_low = _safe_float(params.get("depth_ratio_low"), DEPTH_RATIO_LOW)
    ofi_confirm = _safe_float(params.get("ofi_confirm"), 0.40)

    if features.regime == Regime.HIGH:
        vpin_threshold += 0.03
        imbalance_threshold += 0.03
    elif features.regime == Regime.LOW:
        return None

    if vpin < vpin_threshold:
        return None

    depth_low = depth_ratio < depth_ratio_low

    if depth_low and imbalance > imbalance_threshold and ofi_z > ofi_confirm:
        if features.htf_trend < 0:
            return None
        tox = max(0.0, vpin - vpin_threshold)
        imbalance_scale = min(abs(imbalance) / max(imbalance_threshold, 1e-9), 2.5)
        strength = min(1.1 + tox * 6.0 + 0.45 * imbalance_scale, 3.0)
        return _make_signal(features, ModelName.FLOW_TOXICITY, Direction.UP, strength)

    if depth_low and imbalance < -imbalance_threshold and ofi_z < -ofi_confirm:
        if features.htf_trend > 0:
            return None
        tox = max(0.0, vpin - vpin_threshold)
        imbalance_scale = min(abs(imbalance) / max(imbalance_threshold, 1e-9), 2.5)
        strength = min(1.1 + tox * 6.0 + 0.45 * imbalance_scale, 3.0)
        return _make_signal(features, ModelName.FLOW_TOXICITY, Direction.DOWN, strength)

    return None


# ---------------------------------------------------------------------------
# Model 3 — Low Volatility Accumulation
# ---------------------------------------------------------------------------
# Conditions (from poly.md):
#   LOW vol regime + recent volume > 1.2× average volume
#   Direction determined by 20-bar (kc_mid) price change
#
# Strength = 0.8 (lower conviction — broad condition)
# Rationale: Quiet compression with a volume surge is a classic accumulation
# or distribution signal before a directional break.
# ---------------------------------------------------------------------------

VOLUME_SURGE_MULTIPLE = 1.2
LOW_VOL_STRENGTH = 0.8

# We carry a rolling average volume via module-level state per asset.
# For the stateless function signature we accept avg_volume as a parameter.


def model_low_vol_accum(
    features: Features,
    current_volume: float,
    avg_volume: float,
    params: Optional[dict] = None,
) -> Optional[Signal]:
    params = params or {}
    vol_surge_multiple = _safe_float(params.get("vol_surge_mult"), VOLUME_SURGE_MULTIPLE)
    atr_percentile_max = _safe_float(params.get("atr_percentile_max"), 0.45)
    zscore_min = _safe_float(params.get("zscore_min"), 0.25)

    if features.regime != Regime.LOW:
        return None
    if features.atr_percentile > atr_percentile_max:
        return None

    if avg_volume < 1e-12:
        return None

    if current_volume < vol_surge_multiple * avg_volume:
        return None

    # Prefer higher-timeframe trend when available; otherwise fall back to z-score.
    if features.htf_trend > 0:
        direction = Direction.UP
    elif features.htf_trend < 0:
        direction = Direction.DOWN
    else:
        if abs(features.zscore) < zscore_min:
            return None
        direction = Direction.UP if features.zscore > 0 else Direction.DOWN

    vol_surge = current_volume / max(avg_volume, 1e-9)
    surge_score = min((vol_surge / max(vol_surge_multiple, 1e-9)) - 1.0, 1.5)
    trend_score = min(abs(features.zscore), 2.0) / 2.0
    strength = min(LOW_VOL_STRENGTH + 0.55 * max(0.0, surge_score) + 0.40 * trend_score, 2.4)
    return _make_signal(features, ModelName.LOW_VOL_ACCUM, direction, strength)


# ---------------------------------------------------------------------------
# Model 4 — High Volatility Momentum
# ---------------------------------------------------------------------------
# Triggers on (from poly.md):
#   HIGH vol regime + 5-min momentum move > 0.5%
#
# Strength = min(|price_change_5m| * 100 * 2.5, 3.0)   (scaled from %)
# Rationale: In high-vol regimes, momentum is more likely to persist within
# a 15-minute window; fade the mean-reversion bias.
# ---------------------------------------------------------------------------

HIGH_VOL_MOMENTUM_THRESHOLD_PCT = 0.9   # % (was 0.5) - tighter impulse gate
HIGH_VOL_STRENGTH_SCALE = 2.5
HIGH_VOL_ZSCORE_MIN = 0.9               # require displacement in momentum direction
HIGH_VOL_OFI_Z_MIN = 0.6                # require order-flow confirmation
HIGH_VOL_IMBALANCE_MIN = 0.08           # require book imbalance in direction
HIGH_VOL_VPIN_MIN = 0.62                # avoid low-information breakouts


def model_high_vol_momentum(features: Features) -> Optional[Signal]:
    if features.regime != Regime.HIGH:
        return None

    pct = features.price_change_5m
    if abs(pct) < HIGH_VOL_MOMENTUM_THRESHOLD_PCT:
        return None

    direction = Direction.UP if pct > 0 else Direction.DOWN

    # In high-vol windows, only take continuation when trend and microstructure agree.
    if direction == Direction.UP:
        if features.htf_trend < 0:
            return None
        if features.zscore < HIGH_VOL_ZSCORE_MIN:
            return None
        if features.ofi_zscore < HIGH_VOL_OFI_Z_MIN:
            return None
        if features.bid_ask_imbalance < HIGH_VOL_IMBALANCE_MIN:
            return None
    else:
        if features.htf_trend > 0:
            return None
        if features.zscore > -HIGH_VOL_ZSCORE_MIN:
            return None
        if features.ofi_zscore > -HIGH_VOL_OFI_Z_MIN:
            return None
        if features.bid_ask_imbalance > -HIGH_VOL_IMBALANCE_MIN:
            return None

    if features.vpin < HIGH_VOL_VPIN_MIN:
        return None

    flow_score = min(abs(features.ofi_zscore) / max(HIGH_VOL_OFI_Z_MIN, 1e-9), 2.0)
    trend_score = min(abs(features.zscore) / max(HIGH_VOL_ZSCORE_MIN, 1e-9), 2.0)
    strength = min(abs(pct) * HIGH_VOL_STRENGTH_SCALE + 0.25 * flow_score + 0.20 * trend_score, 3.0)
    return _make_signal(features, ModelName.HIGH_VOL_MOMENTUM, direction, strength)


# ---------------------------------------------------------------------------
# Model 5 — Tri-Engine Composite
# ---------------------------------------------------------------------------
# Three independent engines must all agree before firing:
#   Engine 1 (Trend): Z-score magnitude above threshold
#   Engine 2 (Flow):  OFI z-score confirms the same direction
#   Engine 3 (Momentum): 5-min price change confirms the same direction
#
# Only fires in MEDIUM or HIGH regime (not LOW — no momentum edge in chop).
# Strength = average of |zscore| and |ofi_zscore|, capped at 3.0.
# ---------------------------------------------------------------------------

TRI_ZSCORE_THRESHOLD = 1.0
TRI_OFI_THRESHOLD = 0.8


def model_tri_engine(features: Features) -> Optional[Signal]:
    if features.regime == Regime.LOW:
        return None

    z = features.zscore
    ofi_z = features.ofi_zscore
    mom = features.price_change_5m

    if z > TRI_ZSCORE_THRESHOLD and ofi_z > TRI_OFI_THRESHOLD and mom > 0:
        strength = min((abs(z) + abs(ofi_z)) / 2.0, 3.0)
        return _make_signal(features, ModelName.TRI_ENGINE, Direction.UP, strength)

    if z < -TRI_ZSCORE_THRESHOLD and ofi_z < -TRI_OFI_THRESHOLD and mom < 0:
        strength = min((abs(z) + abs(ofi_z)) / 2.0, 3.0)
        return _make_signal(features, ModelName.TRI_ENGINE, Direction.DOWN, strength)

    return None


# ---------------------------------------------------------------------------
# Model 6 — V3 Titanium ATR Gate
# ---------------------------------------------------------------------------
# Inspired by the FF Systematica V3 Titanium Walk-Forward Audit.
#
# Entry conditions:
#   ATR gate (proxy): regime is not LOW  → market has sufficient volatility
#   Z-score stretch:  |zscore| >= 2.0
#   Power zone:       bar falls in an active session hour
#   Cycle phase:
#     SNIPER  (bars 2–6  of 15m window): mean reversion — z < 0 → UP, z > 0 → DOWN
#     FINISHER (bars 7–14 of 15m window): trend decay   — z < 0 → DOWN, z > 0 → UP
#
# Strength = |zscore| / threshold, capped at 3.0.
# ---------------------------------------------------------------------------

V3_TITANIUM_Z_THRESH = 2.0
V3_TITANIUM_POWER_ZONES = frozenset({3, 4, 8, 9, 13, 14, 16, 17, 18})


def model_v3_titanium(features: Features) -> Optional[Signal]:
    # ATR gate proxy: skip in low-volatility regime
    if features.regime == Regime.LOW:
        return None

    z = features.zscore
    if abs(z) < V3_TITANIUM_Z_THRESH:
        return None

    # Power-zone filter (UTC hour)
    hour = features.timestamp.hour
    if hour not in V3_TITANIUM_POWER_ZONES:
        return None

    # Cycle phase: which minute (1–15) within the 15-minute bar window?
    bar_ts_s = int(features.timestamp.timestamp())
    b_idx = (bar_ts_s % 900) // 60 + 1  # 1–15

    if 2 <= b_idx <= 6:
        # SNIPER: mean reversion — price stretched DOWN → expect UP
        direction = Direction.UP if z < 0 else Direction.DOWN
    elif 7 <= b_idx <= 14:
        # FINISHER: trend decay — price stretched DOWN → stays DOWN
        direction = Direction.DOWN if z < 0 else Direction.UP
    else:
        return None

    strength = min(abs(z) / V3_TITANIUM_Z_THRESH, 3.0)
    return _make_signal(features, ModelName.V3_TITANIUM, direction, strength)


# ---------------------------------------------------------------------------
# Model 6b — V5 Titanium Probability Engine
# ---------------------------------------------------------------------------
# Wraps the standalone V5 probability engine (shared/v5_titanium_engine.py).
#
# Feature mapping to V5 inputs:
#   current_min        ← features.timestamp.minute
#   price              ← features.close
#   strike             ← features.kc_mid
#   atr_60m            ← features.atr
#   ewma_vol_1m        ← features.atr * 0.1 (proxy)
#   is_high_vol_gate   ← features.regime != Regime.LOW
#   trend_bias         ← clip(ofi_zscore / 3.0, -1, 1)
#
# Strength scales by probability excess over the hurdle.
# ---------------------------------------------------------------------------

def model_v5_titanium(features: Features) -> Optional[Signal]:
    from shared.v5_titanium_engine import evaluate_v5_signal

    trend_bias = max(-1.0, min(1.0, features.ofi_zscore / 3.0))

    decision = evaluate_v5_signal(
        current_min=features.timestamp.minute,
        price=features.close,
        strike=features.kc_mid,
        atr_60m=features.atr,
        ewma_vol_1m=features.atr * 0.1,
        is_high_vol_gate=(features.regime != Regime.LOW),
        trend_bias=trend_bias,
    )

    if not decision.get("triggered", False):
        return None

    direction = Direction.UP if decision.get("side") == "YES" else Direction.DOWN
    prob = float(decision.get("prob", 0.0))

    minute = features.timestamp.minute
    if minute <= 30:
        threshold = 65.0
    elif minute <= 45:
        threshold = 72.0
    elif minute <= 55:
        threshold = 80.0
    else:
        threshold = 85.0

    headroom = 100.0 - threshold
    excess = max(prob - threshold, 0.0)
    strength = min((excess / headroom) * 3.0, 3.0) if headroom > 0 else 1.0

    return _make_signal(features, ModelName.V5_TITANIUM, direction, strength)


# ---------------------------------------------------------------------------
# Model 7 — Multi-TF Rubber Band / Asymmetric Reversion
# ---------------------------------------------------------------------------
# "Late Trader Trap Detector"
#
# Detects price stretched across multiple timeframes vs Keltner midline,
# then requires spot OFI to flip against the stretch (confirming reversal)
# plus volume expansion (confirming real participation).
#
# Three KC z-scores are combined with decay weights (fast TF weighted highest):
#   A = 0.50 * z_20s  +  0.30 * z_1m  +  0.20 * z_5m
#
# Trigger: |A| > BAND_ASYM_THRESHOLD  AND
#          |z_20s| > BAND_Z_FAST_MIN  AND
#          at least one of |z_1m|, |z_5m| > BAND_Z_SLOW_MIN
#
# OFI confirmation: OFI must oppose the stretch direction
#   (negative stretch → OFI must turn positive → buyers absorbing sellers)
#
# Volume expansion: vol_zscore > BAND_VOL_Z_MIN
# ---------------------------------------------------------------------------

BAND_ASYM_THRESHOLD = 1.2    # weighted composite z-score to trigger
BAND_Z_FAST_MIN     = 1.0    # 20s frame must be stretched at least this much
BAND_Z_SLOW_MIN     = 0.7    # at least one slower frame must also be stretched
BAND_OFI_FLIP       = 0.0    # OFI must be strictly positive (long) / negative (short)
BAND_VOL_Z_MIN      = 0.3    # volume z-score floor (weak filter — resets on any expansion)
BAND_KC_MULT        = 2.5    # KC ATR multiplier (must match FeatureEngine default)


def _kc_zscore_raw(features: "Features") -> float:
    """Normalised distance from KC midline: (close - mid) / (ATR * mult)."""
    denom = features.atr * BAND_KC_MULT
    if denom < 1e-10:
        return 0.0
    return (features.close - features.kc_mid) / denom


def compute_rubber_band(
    feats_1m:  "Features",
    feats_20s: "Optional[Features]" = None,
    feats_5m:  "Optional[Features]" = None,
    vol_zscore: float = 0.0,
) -> dict:
    """
    Compute multi-TF rubber band scores and return a raw dict suitable for
    both signal generation and the /api/rubber-band/{asset} REST endpoint.

    Returns keys:
        z_20s, z_1m, z_5m      — per-frame KC z-scores
        asymmetry              — weighted composite score (−3..+3)
        ofi                    — spot OFI from 1m features
        ofi_zscore             — normalised OFI
        vol_zscore             — volume expansion score (passed in)
        long_signal            — bool: reversal UP triggered
        short_signal           — bool: reversal DOWN triggered
        strength               — signal strength 0–3
        state                  — 'LONG_TRAP' | 'SHORT_TRAP' | 'NEUTRAL'
    """
    z_1m  = _kc_zscore_raw(feats_1m)
    z_20s = _kc_zscore_raw(feats_20s) if feats_20s else z_1m  # fallback to 1m
    z_5m  = _kc_zscore_raw(feats_5m)  if feats_5m  else z_1m * 0.6  # scaled proxy

    asymmetry = 0.50 * z_20s + 0.30 * z_1m + 0.20 * z_5m

    ofi     = feats_1m.ofi
    ofi_z   = feats_1m.ofi_zscore

    stretched_down = (
        abs(asymmetry) > BAND_ASYM_THRESHOLD
        and asymmetry < 0
        and abs(z_20s) > BAND_Z_FAST_MIN
        and (abs(z_1m) > BAND_Z_SLOW_MIN or abs(z_5m) > BAND_Z_SLOW_MIN)
    )
    stretched_up = (
        abs(asymmetry) > BAND_ASYM_THRESHOLD
        and asymmetry > 0
        and abs(z_20s) > BAND_Z_FAST_MIN
        and (abs(z_1m) > BAND_Z_SLOW_MIN or abs(z_5m) > BAND_Z_SLOW_MIN)
    )

    # OFI flip: buyers absorb stretched sells → long reversal
    long_signal  = stretched_down and ofi > BAND_OFI_FLIP and vol_zscore > BAND_VOL_Z_MIN
    # OFI flip: sellers absorb stretched buys → short reversal
    short_signal = stretched_up   and ofi < -BAND_OFI_FLIP and vol_zscore > BAND_VOL_Z_MIN

    # Strength: proportional to composite stretch and OFI magnitude
    strength = 0.0
    if long_signal or short_signal:
        stretch_mag = min(abs(asymmetry) / BAND_ASYM_THRESHOLD, 2.0)
        ofi_mag     = min(abs(ofi_z), 1.5) / 1.5
        strength    = min(stretch_mag * (0.6 + 0.4 * ofi_mag), 3.0)

    if long_signal:
        state = "LONG_TRAP"
    elif short_signal:
        state = "SHORT_TRAP"
    elif stretched_down:
        state = "STRETCHED_LOW"
    elif stretched_up:
        state = "STRETCHED_HIGH"
    else:
        state = "NEUTRAL"

    return {
        "z_20s":        round(z_20s, 4),
        "z_1m":         round(z_1m, 4),
        "z_5m":         round(z_5m, 4),
        "asymmetry":    round(asymmetry, 4),
        "ofi":          round(ofi, 4),
        "ofi_zscore":   round(ofi_z, 4),
        "vol_zscore":   round(vol_zscore, 4),
        "long_signal":  long_signal,
        "short_signal": short_signal,
        "strength":     round(strength, 3),
        "state":        state,
    }


def model_rubber_band(
    feats_1m:   "Features",
    feats_20s:  "Optional[Features]" = None,
    feats_5m:   "Optional[Features]" = None,
    vol_zscore: float = 0.0,
) -> "Optional[Signal]":
    """
    Multi-TF Rubber Band asymmetric reversion model.
    Only fires when OFI confirms the stretch reversal AND volume expands.
    Does not fire in LOW regime (no mean-reversion edge in chop).
    """
    from shared.types import Regime  # local to avoid circular at module level
    if feats_1m.regime == Regime.LOW:
        return None

    rb = compute_rubber_band(feats_1m, feats_20s, feats_5m, vol_zscore)
    if rb["long_signal"]:
        return _make_signal(feats_1m, ModelName.RUBBER_BAND, Direction.UP, rb["strength"])
    if rb["short_signal"]:
        return _make_signal(feats_1m, ModelName.RUBBER_BAND, Direction.DOWN, rb["strength"])
    return None


# ---------------------------------------------------------------------------
# Ensemble — run all models and return highest-conviction non-conflicting signal
# ---------------------------------------------------------------------------

def run_all_models(
    features: Features,
    current_volume: float = 0.0,
    avg_volume: float = 0.0,
    feats_20s: "Optional[Features]" = None,
    feats_5m:  "Optional[Features]" = None,
    vol_zscore: float = 0.0,
    model_params: Optional[dict] = None,
) -> list[Signal]:
    """
    Run all signal models against the given feature vector.
    Returns a list of fired signals (may be empty, may have multiple).

    feats_20s / feats_5m: optional high-res features for rubber_band model.
    The caller (risk gate / order engine) is responsible for de-duplication
    and direction conflict resolution.
    """
    candidates: list[Signal] = []
    model_params = model_params or {}

    kc_params = model_params.get("KC_REVERSION")
    flow_params = model_params.get("FLOW_TOXICITY")
    low_vol_params = model_params.get("LOW_VOL_ACCUM")

    if isinstance(kc_params, dict) and kc_params.get("enabled") is False:
        s1 = None
    else:
        s1 = model_kc_reversion(features, params=kc_params)

    if s1:
        candidates.append(s1)

    if isinstance(flow_params, dict) and flow_params.get("enabled") is False:
        s2 = None
    else:
        s2 = model_flow_toxicity(features, params=flow_params)
    if s2:
        candidates.append(s2)

    if isinstance(low_vol_params, dict) and low_vol_params.get("enabled") is False:
        s3 = None
    else:
        s3 = model_low_vol_accum(features, current_volume, avg_volume, params=low_vol_params)
    if s3:
        candidates.append(s3)

    s4 = model_high_vol_momentum(features)
    if s4:
        candidates.append(s4)

    s5 = model_tri_engine(features)
    if s5:
        candidates.append(s5)

    s6 = model_v3_titanium(features)
    if s6:
        candidates.append(s6)

    s7 = model_v5_titanium(features)
    if s7:
        candidates.append(s7)

    s8 = model_rubber_band(features, feats_20s, feats_5m, vol_zscore)
    if s8:
        candidates.append(s8)

    return candidates


def best_signal(signals: list[Signal]) -> Optional[Signal]:
    """
    From a list of signals, return the one with the highest strength.
    If there are conflicting directions among top signals, return None
    (no trade — the market is ambiguous).
    """
    if not signals:
        return None
    model_weights = {
        ModelName.KC_REVERSION: 1.05,
        ModelName.FLOW_TOXICITY: 0.85,
        ModelName.LOW_VOL_ACCUM: 0.90,
        ModelName.HIGH_VOL_MOMENTUM: 1.08,
        ModelName.TRI_ENGINE: 1.30,
        ModelName.V3_TITANIUM: 1.10,
        ModelName.V5_TITANIUM: 1.15,
        ModelName.RUBBER_BAND: 1.00,
    }

    weighted_up = 0.0
    weighted_down = 0.0
    for sig in signals:
        weight = model_weights.get(sig.model, 1.0)
        score = sig.strength * weight
        if sig.direction == Direction.UP:
            weighted_up += score
        else:
            weighted_down += score

    margin = abs(weighted_up - weighted_down)
    total_weight = weighted_up + weighted_down
    min_margin = max(0.35, total_weight * 0.12)
    if margin < min_margin:
        return None

    dominant = Direction.UP if weighted_up > weighted_down else Direction.DOWN
    aligned = [s for s in signals if s.direction == dominant]
    if not aligned:
        return None

    # Pick strongest among dominant side after weight adjustment.
    top = max(aligned, key=lambda s: s.strength * model_weights.get(s.model, 1.0))
    if top.strength * model_weights.get(top.model, 1.0) < 1.10:
        return None
    return top

