import pandas as pd
import numpy as np

def ema(s, n):
    return s.ewm(span=n, adjust=False).mean()

def atr(df, n=14):
    h, l, c = df['high'], df['low'], df['close']
    prev_c = c.shift(1)
    tr = pd.concat([(h-l), (h-prev_c).abs(), (l-prev_c).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1/n, adjust=False).mean()

def keltner_z(df, ema_n=20, atr_n=14, mult=1.5):
    mid = ema(df['close'], ema_n)
    a = atr(df, atr_n)
    return (df['close'] - mid) / (a * mult)

def rolling_z(s, n=100):
    m = s.rolling(n).mean()
    sd = s.rolling(n).std(ddof=0)
    return (s - m) / sd.replace(0, np.nan)

def didi_state(df, fast=3, mid=8, slow=20):
    e1 = ema(df['close'], fast)
    e2 = ema(df['close'], mid)
    e3 = ema(df['close'], slow)
    spread = (e1 - e2) + (e1 - e3) + (e2 - e3)
    slope = spread.diff()
    return pd.DataFrame({'e1': e1, 'e2': e2, 'e3': e3, 'spread': spread, 'slope': slope})

def spot_ofi(bid_vol, ask_vol, n=20):
    raw = bid_vol - ask_vol
    return raw.rolling(n).sum()

def build_signals(df20s, df1m, df5m, htf, ofi_df):
    z20 = keltner_z(df20s)
    z1 = keltner_z(df1m)
    z5 = keltner_z(df5m)

    z20n = rolling_z(z20)
    z1n = rolling_z(z1)
    z5n = rolling_z(z5)

    h = didi_state(htf)
    htf_bull = (h['e1'] > h['e2']) & (h['e2'] > h['e3'])
    htf_bear = (h['e1'] < h['e2']) & (h['e2'] < h['e3'])

    htf_special_long = htf_bull & (h['spread'].diff() > 0)
    htf_special_short = htf_bear & (h['spread'].diff() < 0)

    ofi = spot_ofi(ofi_df['bid_vol'], ofi_df['ask_vol'])
    ofi_z = rolling_z(ofi)
    vol_z = rolling_z(df20s['volume'])

    standard_long = (
        (z20n < -1.5) &
        ((z1n < -1.0) | (z5n < -1.0)) &
        (ofi_z > 0.5) &
        (vol_z > 1.0)
    )

    standard_short = (
        (z20n > 1.5) &
        ((z1n > 1.0) | (z5n > 1.0)) &
        (ofi_z < -0.5) &
        (vol_z > 1.0)
    )

    htf_long = htf_special_long.reindex(df20s.index, method='ffill') & standard_long
    htf_short = htf_special_short.reindex(df20s.index, method='ffill') & standard_short

    out = pd.DataFrame({
        'z20': z20,
        'z1': z1.reindex(df20s.index, method='ffill'),
        'z5': z5.reindex(df20s.index, method='ffill'),
        'z20n': z20n,
        'z1n': z1n.reindex(df20s.index, method='ffill'),
        'z5n': z5n.reindex(df20s.index, method='ffill'),
        'ofi_z': ofi_z.reindex(df20s.index, method='ffill'),
        'vol_z': vol_z,
        'standard_long': standard_long,
        'standard_short': standard_short,
        'htf_long': htf_long,
        'htf_short': htf_short
    })
    return out

# How to trade it
# Use the standard trade for the actual trigger on 20s/1m/5m.
# Use the HTF DIDI trade as a permission filter for only taking the stronger directional setup.
# If HTF DIDI is bullish, only take long reversals or pullback continuations.
# If HTF DIDI is bearish, only take short reversals or pullback continuations.
