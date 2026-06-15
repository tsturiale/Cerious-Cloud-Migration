import React, { useId, useMemo } from 'react'
import {
  AreaChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts'

export interface ChartDataPoint {
  time: string
  yesPrice: number
  volume?: number
}

interface PredictionChartProps {
  data: ChartDataPoint[]
  height?: number | string
}

function clampProbability(value: number) {
  return Math.max(0, Math.min(100, value))
}

export const PredictionChart: React.FC<PredictionChartProps> = ({ data, height = 400 }) => {
  const gradientId = useId().replace(/:/g, '')
  const noGradientId = `${gradientId}-no`
  const BUY_BLUE = '#2563eb'
  const SELL_RED = '#ff3045'
  const normalized = data.map(point => ({
    ...point,
    yesPrice: clampProbability(point.yesPrice),
    noPrice: clampProbability(100 - point.yesPrice),
    ceiling: 100,
  }))
  const profile = useMemo(() => {
    const buckets = new Map<number, number>()
    normalized.forEach(point => {
      const price = Math.round(point.yesPrice)
      const volume = Math.max(0.25, Number(point.volume ?? 1))
      buckets.set(price, (buckets.get(price) ?? 0) + volume)
    })
    const rows = Array.from(buckets.entries()).map(([price, volume]) => ({ price, volume }))
    const maxVolume = Math.max(1, ...rows.map(row => row.volume))
    return rows
      .sort((a, b) => a.price - b.price)
      .map(row => ({ ...row, widthPct: Math.max(3, (row.volume / maxVolume) * 30) }))
  }, [normalized])

  return (
    <div
      style={{
        width: '100%',
        height,
        minWidth: 0,
        minHeight: 0,
        position: 'relative',
        overflow: 'hidden',
        background: '#eef2f7',
        padding: '14px',
        borderRadius: '8px',
        border: '1px solid rgba(148, 163, 184, 0.75)',
      }}
    >
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 14,
          width: 'calc(100% - 28px)',
          height: 'calc(100% - 28px)',
          pointerEvents: 'none',
          zIndex: 0,
        }}
      >
        {profile.map(row => (
          <g key={row.price}>
            <rect
              x={100 - row.widthPct}
              y={100 - row.price - 0.32}
              width={row.widthPct}
              height={0.64}
              rx={0.25}
              fill={BUY_BLUE}
              opacity={0.075}
            />
            <rect
              x={100 - row.widthPct * 0.55}
              y={100 - row.price - 0.32}
              width={row.widthPct * 0.55}
              height={0.64}
              rx={0.25}
              fill={SELL_RED}
              opacity={0.045}
            />
          </g>
        ))}
      </svg>
      <div style={{ position: 'relative', zIndex: 1, width: '100%', height: '100%' }}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <AreaChart data={normalized} margin={{ top: 10, right: 14, left: -16, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={BUY_BLUE} stopOpacity={0.16} />
              <stop offset="95%" stopColor={BUY_BLUE} stopOpacity={0} />
            </linearGradient>
            <linearGradient id={noGradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={SELL_RED} stopOpacity={0.12} />
              <stop offset="95%" stopColor={SELL_RED} stopOpacity={0} />
            </linearGradient>
          </defs>

          <CartesianGrid strokeDasharray="3 3" stroke="#cbd5e1" vertical={false} />

          <XAxis
            dataKey="time"
            stroke="#64748b"
            tick={{ fill: '#475569', fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: '#cbd5e1' }}
            minTickGap={22}
          />

          <YAxis
            yAxisId="yes"
            domain={[0, 100]}
            stroke={BUY_BLUE}
            tick={{ fill: '#1d4ed8', fontSize: 10 }}
            tickFormatter={value => `${value}%`}
            tickLine={false}
            axisLine={{ stroke: '#93c5fd' }}
            width={48}
          />

          <YAxis
            yAxisId="no"
            orientation="right"
            domain={[0, 100]}
            stroke={SELL_RED}
            tick={{ fill: SELL_RED, fontSize: 10 }}
            tickFormatter={value => `${value}%`}
            tickLine={false}
            axisLine={{ stroke: '#fda4af' }}
            width={44}
          />

          <Tooltip
            contentStyle={{
              backgroundColor: '#ffffff',
              borderColor: '#cbd5e1',
              borderRadius: 8,
              color: '#0f172a',
              fontSize: 12,
            }}
            labelStyle={{ color: '#475569' }}
            formatter={(value, name) => {
              const parsed = typeof value === 'number' ? value : Number(value)
              if (name === 'noPrice') return [`NO: ${parsed.toFixed(1)}%`, 'NO Probability']
              if (name === 'yesPrice') return [`YES: ${parsed.toFixed(1)}%`, 'YES Probability']
              return [`${parsed.toFixed(1)}%`, 'Probability']
            }}
          />

          <ReferenceLine yAxisId="yes" y={50} stroke="#94a3b8" strokeDasharray="3 3" />

          <Area
            yAxisId="yes"
            type="monotone"
            dataKey="ceiling"
            stroke="none"
            fill="#ffffff"
            fillOpacity={0.1}
            activeDot={false}
            isAnimationActive={false}
          />

          <Area
            yAxisId="yes"
            type="monotone"
            dataKey="yesPrice"
            stroke={BUY_BLUE}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            dot={false}
            activeDot={{ r: 4, fill: BUY_BLUE, stroke: '#dbeafe' }}
            isAnimationActive={false}
          />

          <Area
            yAxisId="no"
            type="monotone"
            dataKey="noPrice"
            stroke="none"
            fill={`url(#${noGradientId})`}
            dot={false}
            activeDot={false}
            isAnimationActive={false}
          />

          <Line
            yAxisId="no"
            type="monotone"
            dataKey="noPrice"
            stroke={SELL_RED}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: SELL_RED, stroke: '#fecdd3' }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
      </div>
    </div>
  )
}
