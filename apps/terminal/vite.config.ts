import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const tailwindcss = require('tailwindcss')
const autoprefixer = require('autoprefixer')
const tailwindConfig = require('./tailwind.config.cjs')
const devHost = process.env.CERIOUS_FRONTEND_HOST || '127.0.0.1'
const devPort = Number(process.env.CERIOUS_FRONTEND_PORT || '5173')
const gatewayHttp = process.env.CERIOUS_GATEWAY_HTTP || 'http://127.0.0.1:8000'
const gatewayWs = process.env.CERIOUS_GATEWAY_WS || gatewayHttp.replace(/^http/, 'ws')

export default defineConfig({
  plugins: [react()],
  css: {
    postcss: {
      plugins: [tailwindcss(tailwindConfig), autoprefixer()],
    },
  },
  server: {
    port: devPort,
    host: devHost,
    proxy: {
      '/api': {
        target: gatewayHttp,
        changeOrigin: true,
      },
      '/ws': {
        target: gatewayWs,
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
