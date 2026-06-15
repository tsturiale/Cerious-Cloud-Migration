import numpy as np
import pandas as pd
from hmmlearn import hmm
from sklearn.decomposition import PCA
from scipy.spatial.distance import jensenshannon
import os
import warnings
from dataclasses import dataclass
from typing import Tuple, Optional, List

warnings.filterwarnings('ignore')

# ============================================================
# 1. THE TRIPLE-ENGINE CLASS
# ============================================================
class TriEngineSystem:
    def __init__(self, timeframe='5min', n_regimes=6):
        self.timeframe = timeframe
        self.n_regimes = n_regimes
        self.pca = PCA(n_components=3)
        # Use 'diag' covariance for better stability across all symbols
        self.hmm = hmm.GaussianHMM(n_components=n_regimes, covariance_type="diag", n_iter=50)
        
        # JSD Config
        self.bin_edges = np.linspace(-0.02, 0.02, 21)
        
    def prepare_data(self, df_1m: pd.DataFrame):
        """Resample and feature engineer for the specific timeframe."""
        df = df_1m.resample(self.timeframe).agg({
            'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last', 'volume': 'sum'
        }).dropna()
        
        # Features for HMM
        df['returns'] = df['close'].pct_change()
        df['log_ret'] = np.log(df['close'] / df['close'].shift(1))
        df['volatility'] = df['log_ret'].rolling(20).std()
        df['range'] = (df['high'] - df['low']) / df['close']
        
        # Features for Execution (Z-Score)
        typ_p = (df['high'] + df['low'] + df['close']) / 3
        tpv = (typ_p * df['volume']).rolling(60).sum()
        cum_v = df['volume'].rolling(60).sum()
        df['vwap'] = tpv / cum_v
        df['vwap_std'] = df['close'].rolling(60).std()
        df['z_score'] = (df['close'] - df['vwap']) / (df['vwap_std'] + 1e-8)
        
        return df.dropna()

    def calculate_jsd(self, returns_series: pd.Series, window_s=15, window_l=100):
        """Vectorized JSD computation approximation."""
        jsd_values = np.zeros(len(returns_series))
        rets = returns_series.values
        
        for i in range(window_l, len(rets)):
            # Probability distribution calculation
            s_dist, _ = np.histogram(rets[i-window_s:i], bins=self.bin_edges, density=True)
            l_dist, _ = np.histogram(rets[i-window_l:i], bins=self.bin_edges, density=True)
            # Ensure distributions sum to 1
            s_dist = s_dist / (s_dist.sum() + 1e-10)
            l_dist = l_dist / (l_dist.sum() + 1e-10)
            jsd_values[i] = jensenshannon(s_dist, l_dist)
        return jsd_values

    def calculate_persistence(self, regimes: np.ndarray, lookback=30):
        """Vectorized rolling persistence based on state matches."""
        persistence = np.zeros(len(regimes))
        for i in range(lookback, len(regimes)):
            window = regimes[i-lookback:i]
            matches = (window == regimes[i-1]).sum()
            persistence[i] = matches / lookback
        return persistence

    def run_backtest(self, csv_path: str, symbol="BTC"):
        if not os.path.exists(csv_path):
            print(f"File not found: {csv_path}")
            return None, 10000.0
            
        print(f"\n🚀 LAUNCHING TRI-ENGINE HYBRID [{self.timeframe}]: {symbol}")
        
        # Load and Resample (Limit to last 1 year of minutes for speed if needed)
        # 500k bars is roughly 1 year of data
        raw_df = pd.read_csv(csv_path).iloc[-500000:]
        raw_df['timestamp'] = pd.to_datetime(raw_df['timestamp'])
        raw_df.set_index('timestamp', inplace=True)
        df = self.prepare_data(raw_df)
        
        # 1. HMM REGIME LAYER
        features = df[['log_ret', 'volatility', 'range']].replace([np.inf, -np.inf], 0).fillna(0).values
        if len(features) < 100:
             print(f"   Skipping {symbol}: Insufficient data.")
             return None, 10000.0

        try:
            pca_features = self.pca.fit_transform(features)
            
            # Causal HMM Inference (Expanding Window) to prevent look-ahead bias
            regimes = np.zeros(len(pca_features), dtype=int)
            warmup = min(500, len(pca_features) // 10) # 500 bars warmup
            
            # Fit on warmup data
            self.hmm.fit(pca_features[:warmup])
            regimes[:warmup] = self.hmm.predict(pca_features[:warmup])
            
            # Refit every N bars, predict one by one
            refit_interval = 24 * (60 // int(self.timeframe.replace('min', ''))) # Daily refit
            
            for i in range(warmup, len(pca_features)):
                if i % refit_interval == 0:
                    # Expanding window fit
                    self.hmm.fit(pca_features[:i])
                # Predict only the current bar using data up to this point
                regimes[i] = self.hmm.predict(pca_features[i:i+1])[0]
                
            df['regime'] = regimes
        except Exception as e:
            print(f"   HMM Fit failed for {symbol}: {e}")
            return None, 10000.0
        
        # Smooth regimes causally using rolling mode (already causal since it looks backward)
        df['regime_stable'] = df['regime'].rolling(3).apply(lambda x: pd.Series(x).mode()[0]).fillna(df['regime'])
        
        # 2. PERSISTENCE LAYER
        df['persistence'] = self.calculate_persistence(df['regime_stable'].values)
        
        # 3. JSD VELOCITY LAYER
        df['jsd'] = self.calculate_jsd(df['returns'])
        
        # SIMULATE TRADING
        bankroll = 10000.0
        pos = 0
        entry_p = 0.0
        trades = []
        
        for i in range(150, len(df)):
            curr_p = df['close'].iloc[i]
            z = df['z_score'].iloc[i]
            jsd = df['jsd'].iloc[i]
            pers = df['persistence'].iloc[i]
            
            # --- THE FUSION RULE ---
            if pers > 0.7 and jsd < 0.3:
                if z < -2.5 and pos == 0:
                    pos = 1
                    entry_p = curr_p
                    trades.append({'entry_time': df.index[i], 'type': 'LONG', 'entry_p': curr_p, 'jsd': jsd, 'pers': pers})
                elif z > 2.5 and pos == 0:
                    pos = -1
                    entry_p = curr_p
                    trades.append({'entry_time': df.index[i], 'type': 'SHORT', 'entry_p': curr_p, 'jsd': jsd, 'pers': pers})
            
            # EXIT LOGIC
            exit_flag = False
            pnl = 0
            if pos == 1 and curr_p > df['vwap'].iloc[i]:
                pnl = (curr_p - entry_p) * 50
                exit_flag = True
            elif pos == -1 and curr_p < df['vwap'].iloc[i]:
                pnl = (entry_p - curr_p) * 50
                exit_flag = True
            elif pos != 0 and pers < 0.4: # Stop out on regime break
                pnl = (curr_p - entry_p) * 50 if pos == 1 else (entry_p - curr_p) * 50
                exit_flag = True
                
            if exit_flag:
                bankroll += pnl
                if len(trades) > 0:
                    trades[-1].update({
                        'exit_time': df.index[i],
                        'exit_p': curr_p,
                        'pnl': pnl,
                        'outcome': 'WIN' if pnl > 0 else 'LOSS',
                        'bankroll': bankroll
                    })
                pos = 0

        df_trades = pd.DataFrame(trades).dropna(subset=['exit_time'])
        df_trades.to_csv(f"{symbol}_tri_engine_trades_{self.timeframe}.csv", index=False)
        print(f"   Final Bankroll: ${bankroll:,.2f} | Total Trades: {len(df_trades)}")
        return df_trades, bankroll

if __name__ == "__main__":
    symbols = ["BTC", "SOL", "XRP"]
    paths = {
        "BTC": "BTC_USD_1m_3y.csv",
        "SOL": "SOL_USD_1m_3y.csv",
        "XRP": "XRP_USD_1m_3y.csv"
    }
    
    overall_results = []
    
    system = TriEngineSystem(timeframe='5min')
    
    for sym in symbols:
        df_t, br = system.run_backtest(paths[sym], sym)
        if df_t is not None:
            overall_results.append({
                'Symbol': sym, 'Profit': br - 10000, 'Trades': len(df_t)
            })
            
    pd.DataFrame(overall_results).to_csv("tri_engine_all_markets.csv", index=False)
