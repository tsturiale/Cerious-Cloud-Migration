const path = require('path')
const dir = __dirname

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    path.join(dir, 'index.html'),
    path.join(dir, 'src/**/*.{js,ts,jsx,tsx}'),
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: 'rgb(var(--cn-surface) / <alpha-value>)',
          panel: 'rgb(var(--cn-surface-panel) / <alpha-value>)',
          card: 'rgb(var(--cn-surface-card) / <alpha-value>)',
          border: 'rgb(var(--cn-surface-border) / <alpha-value>)',
          hover: 'rgb(var(--cn-surface-hover) / <alpha-value>)',
        },
        up: '#1cb38b',
        down: '#d94b57',
        warn: '#d9a321',
        accent: 'rgb(var(--cn-accent) / <alpha-value>)',
        muted: 'rgb(var(--cn-muted) / <alpha-value>)',
        dim: '#2d3748',
      },
      fontFamily: {
        mono: ['Cascadia Mono', 'Cascadia Code', 'Consolas', 'Roboto Mono', 'monospace'],
        sans: ['Helvetica Neue', 'Helvetica', 'Arial', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        '2xs': ['0.65rem', { lineHeight: '1rem' }],
      },
    },
  },
  plugins: [require('@tailwindcss/forms')],
}
