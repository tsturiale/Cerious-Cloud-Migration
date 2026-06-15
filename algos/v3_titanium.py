""""
╔═══════════════════════════════════════════════════════════════════╗
║  FF Systematica — V3 TITANIUM ATR GATE (PRODUCTION)               ║
║  Objective: Dev Team QA Baseline with Volatility Filtering        ║
║  Capital: $10,000 Starting Account Structure                      ║
║  Risk: $400 Sniper / $600 Finisher | 70% Finisher SL Only         ║
║  New Element: ATR Gate (15-period ATR >= 400-period ATR SMA)      ║
╚═══════════════════════════════════════════════════════════════════╝
"""

import ccxt
import pandas as pd
import numpy as np
from datetime import timedelta

# ── Production Configuration ──────────────────────────────────────
LOOKBACK_DAYS     = 60
STARTING_BAL      = 10000.0
INVESTMENT_S      = 400.0  # Sniper Mode (Deep Value Dips)
INVESTMENT_F      = 600.0  # Finisher Mode (Trend Decay Continuation)
STOP_LOSS_PCT     = 0.70   # Finisher ONLY (30% Drawdown Hard Stop => 70% Retained)
CALIB_WINDOW      = 3      # Days to look back for Walk-Forward
COMMISSION_RATE   = 0.0175 # 1.75% Exchange Commission
POWER_ZONES       = [3, 4, 8, 9, 13, 14, 16, 17, 18] # Asian, London, US Open/Close

def generate_titanium_audit():
    print(f"\n" + "═"*75 + f"\n  V3 TITANIUM ATR GATE AUDIT (60-DAY WALK-FORWARD)\n" + "═"*75)
    
    ex = ccxt.coinbase()
    since = ex.milliseconds() - (LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    all_bars = []
    for _ in range(250):
        try:
            bars = ex.fetch_ohlcv("BTC-USD", timeframe='1m', since=since, limit=300)
            if not bars: break
            all_bars.extend(bars)
            since = bars[-1][0] + 60000
        except: break
    
    df = pd.DataFrame(all_bars, columns=['ts', 'open', 'high', 'low', 'close', 'volume'])
    df['ts'] = pd.to_datetime(df['ts'], unit='ms', utc=True)
    df.set_index('ts', inplace=True)
    df = df[~df.index.duplicated(keep='first')]
    
    # Core Indicators
    df['ma_20']  = df['close'].rolling(20).mean()
    df['std_20'] = df['close'].rolling(20).std()
    df['z']      = (df['close'] - df['ma_20']) / (df['std_20'] + 1e-10)

    # V3 Volatility Gate Indicators (15-period ATR and 400-period ATR MA)
    df['prev_c'] = df['close'].shift(1)
    df['tr'] = np.maximum(
        df['high'] - df['low'],
        np.maximum(
            abs(df['high'] - df['prev_c']),
            abs(df['low'] - df['prev_c'])
        )
    )
    df['atr_15'] = df['tr'].rolling(15).mean()
    df['atr_ma400'] = df['atr_15'].rolling(400).mean()

    start_ts = df.index[0] + timedelta(days=CALIB_WINDOW)
    end_ts   = df.index[-1]
    
    current_z_thresh = 2.2 
    total_pnl = 0.0
    trades = []
    cal_log = []

    current_day = start_ts
    while current_day <= end_ts:
        # --- ZERO LOOK-AHEAD RECALIBRATION ---
        if (current_day - start_ts).days % CALIB_WINDOW == 0:
            best_z, max_pnl = 2.2, -999999
            calib_start = current_day - timedelta(days=CALIB_WINDOW)
            cal_df = df.loc[(df.index > calib_start) & (df.index <= current_day)].copy()
            
            if len(cal_df) > 100:
                for test_z in np.arange(1.5, 3.6, 0.1):
                    pnl = simulate_core(cal_df, test_z)
                    if pnl > max_pnl:
                        max_pnl = pnl
                        best_z = test_z
            
            current_z_thresh = round(best_z, 1)
            cal_log.append({"z": current_z_thresh})

        # --- BLIND EXECUTION ---
        exec_end = current_day + timedelta(days=1)
        exec_df = df.loc[(df.index > current_day) & (df.index <= exec_end)].copy()
        
        if len(exec_df) > 0:
            day_pnl, day_trades = simulate_core(exec_df, current_z_thresh, return_trades=True)
            total_pnl += day_pnl
            trades.extend(day_trades)
            
        current_day = exec_end

    print("\n" + "═"*75)
    print(f"  V3 TITANIUM READOUT: $10k BASELINE | VOLATILITY GATED")
    print("═"*75)
    print(f"    Final Bankroll    : ${(STARTING_BAL + total_pnl):+,.0f}")
    print(f"    Total Net Return  : ${total_pnl:+,.0f} (Net of Commish)")
    print(f"    Total Trades      : {len(trades)}")
    print(f"    Avg Z-Aggression  : {np.mean([x['z'] for x in cal_log]):.2f}")
    
    if trades:
        t_df = pd.DataFrame(trades)
        wins = t_df[t_df['pnl'] > 0]
        sl_hits = t_df[t_df['exit_type'] == 'SL']
        sc_outs = t_df[t_df['scaled_out'] == True]
        
        print(f"    Total Win Rate    : {(len(wins) / len(t_df)) * 100:.1f}%")
        print(f"    Stop Loss Trigger : {len(sl_hits)} times (-30% Drawdown on Finisher)")
        print(f"    Scale-Out Trigger : {len(sc_outs)} times (+200% Profit secured)")
        print(f"    Max Loss Streak   : {calc_streak(t_df['pnl']):.0f}")

def simulate_core(df, z_thresh, return_trades=False):
    bankroll_pnl = 0.0
    trades = []
    active_pos = None
    
    for ts, row in df.iterrows():
        b_idx = ts.minute % 15 + 1
        z = row['z']
        hour = ts.hour
        
        if active_pos:
            active_pos['bars'] += 1
            current_c = 50 + (z * 15) if active_pos['side'] == "YES" else 50 - (z * 15)
            
            # 1. --- 70% HARD STOP LOSS (FINISHER ONLY) ---
            if active_pos['mode'] == 'FINISHER' and current_c <= active_pos['entry_c'] * STOP_LOSS_PCT:
                shares_sold = active_pos['shares']
                gross_sale = shares_sold * (current_c / 100.0)
                fee = gross_sale * COMMISSION_RATE
                profit = gross_sale - fee - (shares_sold * (active_pos['entry_c'] / 100.0))
                
                entry_fee = active_pos['risk'] * COMMISSION_RATE
                total_trade_pnl = active_pos['running_pnl'] + profit - entry_fee
                
                bankroll_pnl += total_trade_pnl
                trades.append({
                    "pnl": total_trade_pnl, "exit_type": "SL", "scaled_out": active_pos['scaled_out'],
                    "mode": active_pos['mode']
                })
                active_pos = None
                continue
            
            # 2. --- 33% @ 200% PROFIT SCALE-OUT ---
            if not active_pos['scaled_out']:
                target_p = active_pos['entry_c'] * 3.0
                if current_c >= target_p:
                    shares_sold = active_pos['shares'] * 0.33
                    gross_sale = shares_sold * (current_c / 100.0)
                    fee = gross_sale * COMMISSION_RATE
                    profit = gross_sale - fee - (shares_sold * (active_pos['entry_c'] / 100.0))
                    
                    active_pos['running_pnl'] += profit
                    active_pos['shares'] -= shares_sold
                    active_pos['scaled_out'] = True

            # 3. --- STRICT MINUTE 15 SETTLEMENT (67% REMAINDER) ---
            if b_idx == 15:
                is_win = False
                if active_pos['side'] == "YES" and z >= 0: is_win = True
                elif active_pos['side'] == "NO" and z <= 0: is_win = True
                
                gross_payout = active_pos['shares'] * 1.0 if is_win else 0.0
                fee = gross_payout * COMMISSION_RATE if is_win else 0.0
                final_leg_pnl = (gross_payout - fee) - (active_pos['shares'] * (active_pos['entry_c']/100.0))
                
                entry_fee = active_pos['risk'] * COMMISSION_RATE
                total_trade_pnl = active_pos['running_pnl'] + final_leg_pnl - entry_fee
                
                bankroll_pnl += total_trade_pnl
                trades.append({
                    "pnl": total_trade_pnl, "exit_type": "EXPIRE", "scaled_out": active_pos['scaled_out'],
                    "mode": active_pos['mode']
                })
                active_pos = None
                
        else:
            if hour not in POWER_ZONES: continue
            
            # >>> V3: THE VOLATILITY GATE <<<
            # The agent will remain IDLE if the current 15m ATR is below the MA400
            atr_15 = row['atr_15']
            atr_ma400 = row['atr_ma400']
            if pd.isna(atr_15) or pd.isna(atr_ma400) or atr_15 < atr_ma400:
                continue
            
            side, risk, min_e, max_e, mode = None, 0, 0, 0, None
            
            # --- SNIPER ($400 | Dips) ---
            if 2 <= b_idx <= 6:
                mode = 'SNIPER'
                if z < -z_thresh: side, risk, min_e, max_e = "YES", INVESTMENT_S, 10.0, 40.0
                elif z > z_thresh: side, risk, min_e, max_e = "NO", INVESTMENT_S, 10.0, 40.0
            # --- FINISHER ($600 | Trend Decay) ---
            elif 7 <= b_idx <= 14:
                mode = 'FINISHER'
                if z < -z_thresh: side, risk, min_e, max_e = "NO", INVESTMENT_F, 60.0, 85.0
                elif z > z_thresh: side, risk, min_e, max_e = "YES", INVESTMENT_F, 60.0, 85.0
            
            if side:
                bars_left = 16 - b_idx
                decay_mult = np.sqrt(bars_left / 15.0)
                yes_price = 50 + (z * 15 * decay_mult)
                entry_c = yes_price if side == "YES" else (100 - yes_price)
                entry_c = np.clip(entry_c, min_e, max_e)
                
                if min_e <= entry_c <= max_e:
                    shares = risk / (entry_c / 100.0)
                    active_pos = {
                        "side": side, "shares": shares, "entry_c": entry_c, "mode": mode,
                        "risk": risk, "bars": 0, "scaled_out": False, "running_pnl": 0.0
                    }

    return (bankroll_pnl, trades) if return_trades else bankroll_pnl

def calc_streak(pnl_series):
    streak = 0; max_ls = 0
    for p in pnl_series:
        if p < 0: streak += 1; max_ls = max(max_ls, streak)
        else: streak = 0
    return max_ls

if __name__ == "__main__":
    generate_titanium_audit()
