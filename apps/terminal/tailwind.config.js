import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    join(__dirname, 'index.html'),
    join(__dirname, 'src/**/*.{js,ts,jsx,tsx}'),
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: 'rgb(var(--cn-surface) / <alpha-value>)',
          panel:   'rgb(var(--cn-surface-panel) / <alpha-value>)',
          card:    'rgb(var(--cn-surface-card) / <alpha-value>)',
          border:  'rgb(var(--cn-surface-border) / <alpha-value>)',
          hover:   'rgb(var(--cn-surface-hover) / <alpha-value>)',
        },
        up:     '#00d4a4',
        down:   '#ff4757',
        warn:   '#ffa502',
        accent: 'rgb(var(--cn-accent) / <alpha-value>)',
        muted:  'rgb(var(--cn-muted) / <alpha-value>)',
        dim:    '#2d3748',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        '2xs': ['0.65rem', { lineHeight: '1rem' }],
      },
    },
  },
  plugins: [require('@tailwindcss/forms')],
}
