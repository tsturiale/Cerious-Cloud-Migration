import { useEffect, useRef, useMemo } from "react";
import { useStore } from "../store";

/**
 * Tape Chart — Visual representation of time and sales
 * X-axis: Time (left to right)
 * Y-axis: YES (top) / NO (bottom) — 0-100 scale
 * Each trade plotted as a colored dot at (time, probability)
 */
export function TapeChart() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const s = useStore();
  const activeKey = s.activeMarketKey;

  const fills = activeKey ? (s.fills[activeKey] ?? []) : [];

  const chartData = useMemo(() => {
    if (!fills.length)
      return { points: [], now: Date.now() / 1000, oldest: Date.now() / 1000, maxSize: 0 };

    const now = Date.now() / 1000; // Convert to seconds
    const oldestMs = Math.min(...fills.map((f) => f.timestamp * 1000)); // Convert back to ms for calc
    const oldest = oldestMs / 1000;
    const timeRange = Math.max(now - oldest, 1); // At least 1 second

    const maxSize = Math.max(...fills.map((f) => f.size ?? 1));

    const points = fills.map((fill) => ({
      x: (((fill.timestamp * 1000 - oldestMs) / 1000) / timeRange) * 0.95 + 0.025, // Normalize to [0.025, 0.975]
      y: Math.max(0.1, Math.min(0.9, ((fill.price || 50) / 100) * 0.8 + 0.1)), // Map 0–100 pct to 10%–90% range
      size: (fill.size ?? 1) / maxSize,
      side: fill.side,
    }));

    return { points, now, oldest, maxSize };
  }, [fills]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let animId: number;
    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const w = canvas.width;
      const h = canvas.height;

      // Background
      ctx.fillStyle = "#0f172a"; // slate-900
      ctx.fillRect(0, 0, w, h);

      // Grid lines
      ctx.strokeStyle = "#1e293b"; // slate-800
      ctx.lineWidth = 1;

      // Horizontal grid (YES at top, NO at bottom)
      ctx.beginPath();
      ctx.moveTo(0, h * 0.1);
      ctx.lineTo(w, h * 0.1);
      ctx.stroke();

      ctx.shadowColor = '#ff00ff'
      ctx.shadowBlur = 8
      ctx.strokeStyle = '#ff00ff'
      ctx.lineWidth = 1.5
      ctx.beginPath();
      ctx.moveTo(0, h * 0.5);
      ctx.lineTo(w, h * 0.5);
      ctx.stroke();
      ctx.shadowBlur = 0
      ctx.lineWidth = 1

      ctx.beginPath();
      ctx.moveTo(0, h * 0.9);
      ctx.lineTo(w, h * 0.9);
      ctx.stroke();

      // Vertical grid (every 10% of time)
      for (let i = 0; i <= 1; i += 0.1) {
        ctx.beginPath();
        ctx.moveTo(w * i, 0);
        ctx.lineTo(w * i, h);
        ctx.stroke();
      }

      // Labels
      ctx.fillStyle = "#94a3b8"; // slate-400
      ctx.font = "10px monospace";
      ctx.textAlign = "left";
      ctx.fillText("YES (100)", 4, 12);
      ctx.shadowColor = '#ff00ff'
      ctx.shadowBlur = 8
      ctx.fillStyle = "#ff00ff";
      ctx.font = "bold 10px monospace";
      ctx.fillText("50%", 4, h / 2 + 4);
      ctx.shadowBlur = 0
      ctx.fillStyle = "#94a3b8";
      ctx.font = "10px monospace";
      ctx.textAlign = "left";
      ctx.fillText("NO (0)", 4, h - 4);

      // Draw trades as dots (static, don't animate)
      chartData.points.forEach((point) => {
        const px = w * point.x;
        const py = h * point.y;
        const radius = Math.max(2, 4 * Math.sqrt(point.size));

        if (point.side === "yes") {
          ctx.fillStyle = "rgba(74, 222, 128, 0.7)"; // green-400 with alpha
        } else {
          ctx.fillStyle = "rgba(248, 113, 113, 0.7)"; // red-400 with alpha
        }

        ctx.beginPath();
        ctx.arc(px, py, radius, 0, Math.PI * 2);
        ctx.fill();

        // Border
        ctx.strokeStyle = point.side === "yes" ? "#22c55e" : "#f87171";
        ctx.lineWidth = 1;
        ctx.stroke();
      });

      // Border
      ctx.strokeStyle = "#475569"; // slate-600
      ctx.lineWidth = 1;
      ctx.strokeRect(0, 0, w, h);
    };

    // Schedule draw on next frame to batch updates (reduces animation jitter)
    animId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animId);
  }, [chartData]);

  return (
    <div className="flex flex-col h-full gap-2">
      {/* Chart title and info */}
      <div className="bg-slate-900 border border-slate-700 rounded px-3 py-2">
        <div className="text-xs text-slate-400">Tape Flow Chart</div>
        <div className="text-xs text-slate-500 mt-1">
          X: Time (left→right) | Y: YES (top) / NO (bottom) | Size: Trade volume
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 bg-slate-950 border border-slate-700 rounded overflow-hidden">
        {fills.length === 0 ? (
          <div className="w-full h-full flex items-center justify-center text-slate-500 text-xs">
            No trades yet
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            width={600}
            height={150}
            className="w-full h-full"
            style={{ imageRendering: "crisp-edges" }}
          />
        )}
      </div>

      {/* Summary */}
      {!activeKey ? (
        <div className="text-xs text-slate-500 p-2 border-t border-slate-700">
          No market selected
        </div>
      ) : (
        <div className="text-xs text-slate-500 p-2 border-t border-slate-700">
          <span className="font-mono">{activeKey}</span>
          <span className="ml-2 text-slate-400">
            {fills.length} trades — {((fills.filter((f) => f.side === "yes").length / fills.length) * 100).toFixed(0)}% YES
          </span>
        </div>
      )}
    </div>
  );
}
