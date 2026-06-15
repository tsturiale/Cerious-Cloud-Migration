# 🛡️ FF Systematica — V3 Titanium (ATR Gated)
**Release:** V3.0 (Production QA Ready)

## 📌 Strategic Objective 
Building on the mathematical edge of **Ironclad V2** (Decoupled Stop Losses), this V3 Titanium branch adds a **Strict Volatility Gate** to ensure the algorithm rests during low-edge, flat-market environments.

When a market is flat, a Z-Stretch of > `2.2` might technically fire, but because the raw dollar movements are extremely small, the synthetic contract premiums often decay poorly, leading to slow bleeds. The Volatility Gate completely shuts down the system during these dead zones.

---

## 📐 The ATR Gating Mechanism

### 1. Variables
*   **`ATR_15`**: A rolling 15-period Average True Range of the 1-minute Close. (Calculates the localized 15-minute price expansion).
*   **`ATR_MA400`**: A 400-period Simple Moving Average of the `ATR_15`. (Calculates the macro baseline of recent volatility).

### 2. The Rule
**The agent will remain `IDLE` if `ATR_15 < ATR_MA400`.**

*   **When Volatility Expands:** The 15m ATR crosses above the 400m baseline. The agent "wakes up" and arms the Sniper & Finisher logic. 
*   **When Volatility Collapses:** The 15m ATR drops below the 400m baseline. The agent sits entirely out of the market, effectively filtering out thousands of "dead" 15-minute windows that traditionally drain continuous execution models.

---

## 🛠 Complete V3 Stack
1.  **Sniper (Bars 2-6):** $400 risk, `YES` at 10¢-40¢. (No Stop Loss).
2.  **Finisher (Bars 7-14):** $600 risk, `NO` at 60¢-85¢. (70% Retained Value Stop Loss).
3.  **Scale-Out:** Market sell 33% holding upon reaching +200% profit.
4.  **Commission:** 1.75% calculated precisely on all entries and exits.
5.  **Volatility Gate:** 15m ATR >= 400-period ATR SMA.
