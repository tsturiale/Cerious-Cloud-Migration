import { useEffect, useRef, useMemo, useState } from "react";
import { useStore } from "../store";
import type { PolyTradeTick } from "../types";

/**
 * AGR Flow (Aggressor Flow) — Cumulative session tape
 *
 * • Accumulates ALL poly_tick events for the session (not just the last 1 min).
 * • YES trades = BID aggressor (buyer lifted the ask) — green
 * • NO  trades = ASK aggressor (seller hit the bid)  — red
 * • Bubble size ∝ trade size relative to session average.
 * • Large blocks (≥ 5× avg) get a size label.
 * • Bottom bar shows cumulative YES vol vs NO vol with net delta.
 * • Resets on asset/market key change, NOT on period rotation (same key).
 */

// Composite dedup key — timestamp alone collapses multiple trades in the same second
const tickKey = (t: PolyTradeTick) => `${t.timestamp}-${t.price}-${t.size}-${t.side}`;

const BRIGHT_YES = "#00d4a4";
const BRIGHT_NO  = "#ff4757";
const DIM_YES    = "rgba(0, 212, 164, 0.55)";
const DIM_NO     = "rgba(255, 71, 87, 0.55)";

export function AGRFlow() {
  const containerRef  = useRef<HTMLDivElement>(null);
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState({ width: 400, height: 260 });

  const s         = useStore();
  const activeKey = s.activeMarketKey;

  // ── Cumulative local accumulator (persists across same-key rotations) ──────
  const accumRef    = useRef<PolyTradeTick[]>([]);
  const prevKeyRef  = useRef<string | null>(null);
  const [allTicks, setAllTicks] = useState<PolyTradeTick[]>([]);

  // Merge polyTicks (real-time) + fills (session-persistent) — same sources as TapeHistory
  // polyTicks is wiped on period rotation; fills persists. Using both keeps bubbles live.
  const storeTicks = activeKey ? (s.polyTicks[activeKey] ?? []) : [];
  const storeFills = activeKey ? (s.fills[activeKey]    ?? []) : [];

  // Reset only when the market KEY changes (not on same-key period rotation)
  useEffect(() => {
    if (activeKey !== prevKeyRef.current) {
      prevKeyRef.current = activeKey;
      accumRef.current   = [];
      setAllTicks([]);
    }
  }, [activeKey]);

  // Append genuinely new ticks from both polyTicks + fills into the local accumulator
  useEffect(() => {
    const combined = [...storeTicks, ...storeFills];
    if (!combined.length) return;
    const acc    = accumRef.current;
    const lastTs = acc.length ? acc[acc.length - 1].timestamp : 0;
    // Dedup by composite key — catches same-second trades that differ in price/size/side
    const seen   = new Set(acc.map(tickKey));
    const fresh  = combined
      .filter(t => t.timestamp > lastTs || !seen.has(tickKey(t)))
      .sort((a, b) => a.timestamp - b.timestamp);
    if (!fresh.length) return;
    const updated = [...acc, ...fresh]
      .sort((a, b) => a.timestamp - b.timestamp)
      .filter((t, i, arr) => i === 0 || tickKey(arr[i - 1]) !== tickKey(t)) // dedup by composite
      .slice(-5_000);
    accumRef.current = updated;
    setAllTicks([...updated]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeTicks, storeFills]);

  // ── Resize observer ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(entries => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        if (width > 10 && height > 10) setDims({ width, height });
      }
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // ── Derived chart data ─────────────────────────────────────────────────────
  const chart = useMemo(() => {
    if (!allTicks.length) return null;

    const avgSize = allTicks.reduce((s, t) => s + t.size, 0) / allTicks.length;

    // Normalise all timestamps to ms up-front so span and x are consistent
    const toMs = (ts: number) => ts > 1e10 ? ts : ts * 1000;
    const minTs = toMs(allTicks[0].timestamp);
    const maxTs = toMs(allTicks[allTicks.length - 1].timestamp);
    const span  = Math.max(maxTs - minTs, 1_000); // at least 1 s

    const yesTicks = allTicks.filter(t => t.side === "yes");
    const noTicks  = allTicks.filter(t => t.side === "no");
    const yesVol   = yesTicks.reduce((s, t) => s + t.size, 0);
    const noVol    = noTicks.reduce((s, t) => s + t.size,  0);
    const totalVol = yesVol + noVol || 1;

    const bubbles = allTicks.map(t => {
      const tsMs = toMs(t.timestamp);
      const x    = (tsMs - minTs) / span;               // 0–1 across time
      // Normalise price to 0–1 (prices may arrive as 0–100 or 0–1)
      const pn   = t.price > 1 ? t.price / 100 : t.price;
      const y    = 1 - Math.max(0, Math.min(1, pn));    // 0=top(100%), 1=bottom(0%)
      const r    = Math.max(2, Math.min(20, Math.sqrt(t.size / (avgSize || 1)) * 4));
      return { x, y, r, size: t.size, side: t.side, ts: tsMs, pct: pn * 100 };
    });

    return { bubbles, avgSize, yesVol, noVol, totalVol,
             yesPct: (yesVol / totalVol) * 100, minTs, maxTs, span };
  }, [allTicks]);

  // ── Canvas draw ────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = dims.width;
    const H = dims.height;
    canvas.width  = W;
    canvas.height = H;

    // Background
    ctx.fillStyle = "#020617";
    ctx.fillRect(0, 0, W, H);

    if (!chart) {
      ctx.strokeStyle = "#1e293b";
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#334155";
      ctx.font = "10px monospace";
      ctx.textAlign = "center";
      ctx.fillText("Awaiting session flow…", W / 2, H / 2 - 12);
      return;
    }

    // ── Layout ─────────────────────────────────────────────────────────────
    const PL      = 28;   // left margin for Y-axis labels
    const PR      = 4;    // right margin
    const TIME_H  = 14;   // X-axis time label row height
    const VOL_H   = 12;   // cumulative volume bar height
    const GAP     = 4;    // gap between sections
    const CHART_H = H - TIME_H - VOL_H - GAP * 3 - 2;  // plot area height
    const CHART_W = W - PL - PR;
    const TIME_Y  = CHART_H + GAP;
    const BAR_Y   = TIME_Y + TIME_H + GAP;
    const BAR_H   = VOL_H;

    // Helper: map a normalised x/y to canvas pixel
    const px = (nx: number) => PL + Math.max(0, Math.min(1, nx)) * CHART_W;
    const py = (ny: number) => Math.max(0, Math.min(CHART_H, ny * CHART_H));

    // ── Y-axis grid + labels ──────────────────────────────────────────────
    // Grid lines at 0%, 25%, 50%, 75%, 100%
    const pctLevels = [100, 75, 50, 25, 0];
    ctx.font = "8px monospace";
    for (const pct of pctLevels) {
      const ny  = 1 - pct / 100;      // normalised y (0=top=100%)
      const gy  = py(ny);
      const is50 = pct === 50;

      ctx.strokeStyle = is50 ? "#1e3a5f" : "#0f172a";
      ctx.lineWidth   = is50 ? 1 : 0.6;
      ctx.setLineDash(is50 ? [4, 4] : []);
      ctx.beginPath();
      ctx.moveTo(PL, gy);
      ctx.lineTo(PL + CHART_W, gy);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label on left margin — colour the 50% line slightly brighter
      ctx.fillStyle  = is50 ? "#64748b" : "#334155";
      ctx.textAlign  = "right";
      ctx.fillText(`${pct}%`, PL - 3, gy + 3);
    }

    // Thin left axis border
    ctx.strokeStyle = "#1e293b";
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(PL, 0);
    ctx.lineTo(PL, CHART_H);
    ctx.stroke();

    // ── Bubbles ────────────────────────────────────────────────────────────
    for (const b of chart.bubbles) {
      const bpx = Math.max(PL + b.r, Math.min(PL + CHART_W - b.r, px(b.x)));
      const bpy = Math.max(b.r,      Math.min(CHART_H - b.r,       py(b.y)));
      const isLarge = b.size >= chart.avgSize * 5;

      const col = b.side === "yes" ? BRIGHT_YES : BRIGHT_NO;
      const dim = b.side === "yes" ? DIM_YES    : DIM_NO;

      if (isLarge) {
        const g = ctx.createRadialGradient(bpx, bpy, 0, bpx, bpy, b.r * 2.5);
        g.addColorStop(0, b.side === "yes" ? "rgba(0,212,164,0.25)" : "rgba(255,71,87,0.25)");
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(bpx, bpy, b.r * 2.5, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle   = isLarge ? col : dim;
      ctx.strokeStyle = isLarge ? col : (b.side === "yes" ? "#065f46" : "#7f1d1d");
      ctx.lineWidth   = isLarge ? 1.5 : 0.8;
      ctx.beginPath();
      ctx.arc(bpx, bpy, b.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      if (isLarge) {
        const label     = b.side === "yes" ? "BID" : "ASK";
        const sizeLabel = b.size >= 1000 ? `${(b.size / 1000).toFixed(1)}K` : Math.round(b.size).toString();
        ctx.fillStyle = "#ffffff";
        ctx.font      = "bold 7px monospace";
        ctx.textAlign = "center";
        ctx.fillText(label, bpx, bpy - b.r - 3);
        ctx.fillStyle = col;
        ctx.font      = "7px monospace";
        ctx.fillText(sizeLabel, bpx, bpy + b.r + 8);
        // Probability % label on the left axis tick mark
        ctx.fillStyle  = col;
        ctx.textAlign  = "right";
        ctx.fillText(`${b.pct.toFixed(0)}%`, PL - 3, bpy + 3);
      }
    }

    // Last-price dashed guide
    if (chart.bubbles.length > 0) {
      const last = chart.bubbles[chart.bubbles.length - 1];
      const lpy  = py(last.y);
      ctx.strokeStyle = "rgba(148,163,184,0.15)";
      ctx.setLineDash([2, 5]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PL, lpy);
      ctx.lineTo(PL + CHART_W, lpy);
      ctx.stroke();
      ctx.setLineDash([]);
      // Live price label on right edge
      ctx.fillStyle  = "rgba(148,163,184,0.6)";
      ctx.font       = "7px monospace";
      ctx.textAlign  = "left";
      ctx.fillText(`${last.pct.toFixed(1)}%`, PL + CHART_W + 2, lpy + 3);
    }

    // ── X-axis time labels ─────────────────────────────────────────────────
    const nTicks = Math.max(2, Math.floor(CHART_W / 52));
    ctx.fillStyle = "#475569";
    ctx.font      = "7px monospace";
    ctx.textAlign = "center";
    for (let i = 0; i <= nTicks; i++) {
      const frac  = i / nTicks;
      const tsMs  = chart.minTs + frac * chart.span;
      const d     = new Date(tsMs);
      const hh    = d.getHours().toString().padStart(2, "0");
      const mm    = d.getMinutes().toString().padStart(2, "0");
      const ss    = d.getSeconds().toString().padStart(2, "0");
      const label = chart.span < 120_000 ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
      const lx    = px(frac);
      // Tick mark
      ctx.strokeStyle = "#1e293b";
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(lx, CHART_H);
      ctx.lineTo(lx, CHART_H + 3);
      ctx.stroke();
      ctx.fillText(label, lx, TIME_Y + 10);
    }

    // ── Cumulative volume bar ──────────────────────────────────────────────
    const innerW  = W - 4;
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(2, BAR_Y, innerW, BAR_H);

    const yesFrac = chart.yesVol / chart.totalVol;
    ctx.fillStyle = "rgba(0,212,164,0.7)";
    ctx.fillRect(2, BAR_Y, Math.floor(innerW * yesFrac), BAR_H);
    ctx.fillStyle = "rgba(255,71,87,0.7)";
    ctx.fillRect(2 + Math.ceil(innerW * yesFrac), BAR_Y, Math.floor(innerW * (1 - yesFrac)), BAR_H);

    const delta    = chart.yesVol - chart.noVol;
    const deltaStr = (delta >= 0 ? "+" : "") +
      (Math.abs(delta) >= 1000 ? `${(delta / 1000).toFixed(1)}K` : Math.round(delta).toString());
    ctx.font      = "bold 7px monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = delta >= 0 ? BRIGHT_YES : BRIGHT_NO;
    ctx.fillText(`Δ ${deltaStr}`, W / 2, BAR_Y + BAR_H - 1);

  }, [chart, dims]);

  // ── Summary stats ──────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    if (!allTicks.length) return null;
    const yes = allTicks.filter(t => t.side === "yes");
    const no  = allTicks.filter(t => t.side === "no");
    const yVol = yes.reduce((s, t) => s + t.size, 0);
    const nVol = no.reduce((s, t) => s + t.size, 0);
    const total = yVol + nVol || 1;
    return {
      count: allTicks.length,
      yCount: yes.length,
      nCount: no.length,
      yVol, nVol,
      yesPct: ((yVol / total) * 100).toFixed(1),
    };
  }, [allTicks]);

  return (
    <div className="flex flex-col h-full bg-surface-panel p-1.5 gap-1 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <h3 className="text-[10px] font-bold uppercase tracking-tighter text-accent flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
          AGR Flow · Session
        </h3>
        <div className="text-[9px] text-muted font-mono whitespace-nowrap">
          {activeKey ?? "—"} · {allTicks.length} trades
        </div>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        className="flex-1 bg-black rounded border border-surface-border relative overflow-hidden"
      >
        <canvas ref={canvasRef} className="block w-full h-full" />
        {allTicks.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-muted text-[10px]">
            <span className="animate-spin mb-1.5">◌</span>
            Waiting for flow on {activeKey}…
          </div>
        )}
      </div>

      {/* Stats row */}
      {stats ? (
        <div className="grid grid-cols-4 gap-1 shrink-0">
          <div className="bg-surface rounded px-1.5 py-1 border border-surface-border">
            <div className="text-[8px] text-muted uppercase">Trades</div>
            <div className="text-[10px] font-mono font-bold text-slate-200">{stats.count}</div>
          </div>
          <div className="bg-surface rounded px-1.5 py-1 border border-surface-border">
            <div className="text-[8px] uppercase" style={{ color: BRIGHT_YES }}>BID vol</div>
            <div className="text-[10px] font-mono font-bold" style={{ color: BRIGHT_YES }}>
              {stats.yVol >= 1000 ? `${(stats.yVol / 1000).toFixed(1)}K` : Math.round(stats.yVol)}
            </div>
          </div>
          <div className="bg-surface rounded px-1.5 py-1 border border-surface-border">
            <div className="text-[8px] uppercase" style={{ color: BRIGHT_NO }}>ASK vol</div>
            <div className="text-[10px] font-mono font-bold" style={{ color: BRIGHT_NO }}>
              {stats.nVol >= 1000 ? `${(stats.nVol / 1000).toFixed(1)}K` : Math.round(stats.nVol)}
            </div>
          </div>
          <div className="bg-surface rounded px-1.5 py-1 border border-surface-border">
            <div className="text-[8px] text-muted uppercase">YES%</div>
            <div
              className="text-[10px] font-mono font-bold"
              style={{ color: Number(stats.yesPct) >= 50 ? BRIGHT_YES : BRIGHT_NO }}
            >
              {stats.yesPct}%
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-1 shrink-0">
          {["Trades","BID vol","ASK vol","YES%"].map(l => (
            <div key={l} className="bg-surface rounded px-1.5 py-1 border border-surface-border">
              <div className="text-[8px] text-muted uppercase">{l}</div>
              <div className="text-[10px] font-mono font-bold text-muted/40">—</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
