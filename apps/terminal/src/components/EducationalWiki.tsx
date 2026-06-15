export function EducationalWiki() {
  return (
    <div className="p-4 mx-4 mb-8 mt-4 bg-surface-panel border border-surface-border rounded-lg shadow-lg">
      <div className="flex items-center gap-3 mb-6 border-b border-surface-border pb-3">
        <h2 className="text-xl font-bold text-accent tracking-wide uppercase">ArbiTek Educational Wiki</h2>
        <span className="bg-accent/20 text-accent px-2 py-0.5 rounded text-[10px] font-bold uppercase">Reference</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 text-sm text-slate-300 leading-relaxed">
        {/* Part 1: Microstructure */}
        <div className="space-y-6">
          <div>
            <h3 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
              <span className="text-accent">1.</span> Microstructure & Trapped Trader Metrics
            </h3>
            <p className="text-xs text-muted mb-4 italic">
              These numbers measure real-time spot market dynamics to find exhaustion setups.
            </p>

            <div className="space-y-4">
              <div className="bg-surface/30 p-3 rounded border border-surface-border">
                <div className="font-bold text-accent mb-1">Z-Scores (z_20s, z_1m, z_5m)</div>
                <div className="text-xs mb-2"><span className="text-muted font-semibold">Formula:</span> <code className="bg-surface px-1 text-slate-400 rounded">(Close - EMA) / (ATR * Multiplier)</code></div>
                <p className="text-xs">
                  A statistical measure of how many standard deviations the current price is away from its moving average (EMA), normalized by Average True Range (ATR).
                  <br /><br />
                  <span className="text-emerald-400 font-semibold">+1.5 to +2.0</span>: Over-extended upside.<br />
                  <span className="text-red-400 font-semibold">-1.5 to -2.0</span>: Over-extended downside.
                </p>
              </div>

              <div className="bg-surface/30 p-3 rounded border border-surface-border">
                <div className="font-bold text-accent mb-1">Asymmetry Score</div>
                <div className="text-xs mb-2"><span className="text-muted font-semibold">Formula:</span> <code className="bg-surface px-1 text-slate-400 rounded">(z_20s + z_1m + (z_1m * 0.8)) / 3.0</code></div>
                <p className="text-xs">
                  A composite score blending the Z-scores across multiple timeframes. If this pushes past ±1.5, the market structure is universally stretched, triggering a STRETCHED_HIGH or STRETCHED_LOW state.
                </p>
              </div>

              <div className="bg-surface/30 p-3 rounded border border-surface-border">
                <div className="font-bold text-accent mb-1">Order Flow Imbalance (OFI)</div>
                <div className="text-xs mb-2"><span className="text-muted font-semibold">Formula:</span> <code className="bg-surface px-1 text-slate-400 rounded">Rolling Sum(Bid Vol - Ask Vol)</code></div>
                <p className="text-xs">
                  Measures the aggressiveness of market orders hitting the bid vs. the ask. If price is deeply oversold but OFI turns wildly positive, aggressive buyers are absorbing the panic selling.
                </p>
              </div>

              <div className="bg-surface/30 p-3 rounded border border-surface-border">
                <div className="font-bold text-accent mb-1">DIDI Index (HTF Bull/Bear)</div>
                <div className="text-xs mb-2"><span className="text-muted font-semibold">Formula:</span> <code className="bg-surface px-1 text-slate-400 rounded">Spread = (EMA3-8) + (EMA3-20) + (EMA8-20)</code></div>
                <p className="text-xs">
                  A momentum indicator that compares three different Exponential Moving Averages to find inflection points. We use this as a strict permission filter (e.g. only taking long trades when DIDI is bullish).
                </p>
              </div>

              <div className="bg-surface/30 p-3 rounded border border-surface-border">
                <div className="font-bold text-accent mb-1">Keltner Channel (Volatility Envelopes)</div>
                <div className="text-xs mb-2"><span className="text-muted font-semibold">Formula:</span> <code className="bg-surface px-1 text-slate-400 rounded">EMA ± (Multiplier * ATR)</code></div>
                <p className="text-xs">
                  Volatility-based envelopes that use Average True Range (ATR) to measure market stretch. While Bollinger Bands use Standard Deviation, Keltner Channels provide a smoother "causal" envelope that accounts for price jumps. We use the Z-Score of the Keltner width to identify Trapped Trader zones.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Part 2: Options Greeks */}
        <div className="space-y-6">
          <div>
            <h3 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
              <span className="text-accent">2.</span> The Options Greeks (Prediction Markets)
            </h3>
            <p className="text-xs text-muted mb-4 italic">
              Because prediction markets settle at $1 (YES) or $0 (NO), they are mathematically equivalent to European Binary Options.
            </p>

            <div className="space-y-4">
              <div className="bg-surface/30 p-3 rounded border border-surface-border">
                <div className="font-bold text-accent mb-1">Delta (Δ)</div>
                <p className="text-xs">
                  The rate of change of the option's price relative to a $1 change in the underlying asset's price. In prediction markets, Delta basically equals the raw probability of the event occurring. A Delta of 0.50 means the market is a pure coin flip.
                </p>
              </div>

              <div className="bg-surface/30 p-3 rounded border border-surface-border">
                <div className="font-bold text-accent mb-1">Gamma (Γ)</div>
                <p className="text-xs">
                  The rate of change of Delta. It measures how fast your Delta (directional exposure) will change as the underlying asset moves. For binary options, Gamma spikes massively when you are very close to expiration and the price is hovering right at the strike price.
                </p>
              </div>

              <div className="bg-surface/30 p-3 rounded border border-surface-border">
                <div className="font-bold text-accent mb-1">Theta (Θ)</div>
                <p className="text-xs">
                  Time decay. It measures how much value the option loses (or gains) simply because time is passing. In Binary Options, Theta is non-linear!
                  <br /><br />
                  <span className="text-emerald-400 font-semibold">In The Money (e.g. $0.80)</span>: Passage of time increases value to $1.00 (+Theta).<br />
                  <span className="text-red-400 font-semibold">Out of The Money (e.g. $0.20)</span>: Passage of time drains value to $0.00 (-Theta).
                </p>
              </div>

              <div className="bg-surface/30 p-3 rounded border border-surface-border">
                <div className="font-bold text-accent mb-1">Vega (ν) & Rho (ρ)</div>
                <p className="text-xs mb-2">
                  <strong className="text-slate-200">Vega:</strong> The sensitivity of the option's price to changes in Implied Volatility (IV). Binary options have the highest Vega when they are At-The-Money (50 cents).
                </p>
                <p className="text-xs">
                  <strong className="text-slate-200">Rho:</strong> Sensitivity to interest rates. In crypto prediction markets, Rho is almost completely negligible due to short durations.
                </p>
              </div>

              <div className="bg-surface/30 p-3 rounded border border-surface-border">
                <div className="font-bold text-accent mb-1">Vanna & Charm (Second-Order Greeks)</div>
                <p className="text-xs mb-2">
                  <strong className="text-slate-200">Vanna:</strong> Sensitivity of Delta to changes in IV. High Vanna means the market's probability (Delta) will swing violently if volatility spikes, even if the price stays the same.
                </p>
                <p className="text-xs">
                  <strong className="text-slate-200">Charm:</strong> Delta decay over time. As settlement approaches, Charm pulls the probability of OTM contracts toward 0 and ITM contracts toward 1. This "probability drift" is the engine behind our Theta Sniper model.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Part 3: The Truth Engine */}
        <div className="space-y-6">
          <div>
            <h3 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
              <span className="text-accent">3.</span> The Truth Engine & Merton Consensus
            </h3>
            <p className="text-xs text-muted mb-4 italic">
              A high-fidelity probability engine that resolves the "fair value" of binary outcomes by blending microstructure with option math.
            </p>

            <div className="space-y-4">
              <div className="bg-surface/30 p-3 rounded border border-surface-border">
                <div className="font-bold text-accent mb-1">Merton Jump-Diffusion (MJD)</div>
                <div className="text-xs mb-2"><span className="text-muted font-semibold">Model:</span> <code className="bg-surface px-1 text-slate-400 rounded">Normal Diffusion + Poisson Jumps</code></div>
                <p className="text-xs">
                  Standard Black-Scholes assumes smooth price movement. MJD accounts for "jumps" (liquidations, news spikes) which are critical in prediction markets. 
                  <br /><br />
                  <strong className="text-slate-200">Adaptive Tails:</strong> The engine uses a <span className="text-emerald-400">Standard Normal</span> distribution for stable regimes and switches to <span className="text-amber-400">Student-t (df=4.2)</span> during high-volatility events to account for "fat tails" and extreme outlier risk.
                </p>
              </div>

              <div className="bg-surface/30 p-3 rounded border border-surface-border">
                <div className="font-bold text-accent mb-1">The Micro-Drift Equation</div>
                <div className="text-xs mb-2"><span className="text-muted font-semibold">Formula:</span> <code className="bg-surface px-1 text-slate-400 rounded">Drift (μ) = OFI + VPIN + Z + Trend</code></div>
                <p className="text-xs">
                  Instead of guessing directional bias, the engine computes a weighted "Micro-Drift" using spot market signals:
                  <br /><br />
                  • <strong className="text-slate-200">OFI (35%):</strong> Aggregate market order aggression.<br />
                  • <strong className="text-slate-200">VPIN (150%):</strong> Information asymmetry and toxic flow.<br />
                  • <strong className="text-slate-200">Z-Score (-25%):</strong> Statistical mean-reversion pressure.<br />
                  • <strong className="text-slate-200">HTF Trend (300%):</strong> Multi-hour macro momentum.
                </p>
              </div>

              <div className="bg-surface/30 p-3 rounded border border-surface-border">
                <div className="font-bold text-accent mb-1">Regime-Aware Jump Risk (λ)</div>
                <p className="text-xs">
                  The intensity of price jumps (λ) is dynamically scaled by the current market regime:
                  <br /><br />
                  • <strong className="text-emerald-400">Low Vol:</strong> 10 jumps/year (stable consolidation).<br />
                  • <strong className="text-amber-400">Medium Vol:</strong> 120 jumps/year (normal trend).<br />
                  • <strong className="text-red-400">Unstable:</strong> 1,200 jumps/year (liquidation cascades).
                </p>
              </div>

              <div className="bg-surface/30 p-3 rounded border border-surface-border">
                <div className="font-bold text-accent mb-1">Bayesian Edge Detection</div>
                <div className="text-xs mb-2"><span className="text-muted font-semibold">Goal:</span> <code className="bg-surface px-1 text-slate-400 rounded">Truth Prob (TP) vs Market Price</code></div>
                <p className="text-xs">
                  The final output is the <strong className="text-accent">Truth Probability (TP)</strong>. We compare this against the Polymarket/Kalshi market price. If the Engine says an event has a 75% chance (TP=75) but the market is trading at 60¢, we have a <span className="text-emerald-400 font-bold">+15% Edge</span>.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
