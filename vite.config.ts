import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return
          if (id.includes('/@internet-privacy/marmot-ts/') || id.includes('/ts-mls/')) return 'vendor-marmot'
          if (/\/node_modules\/(applesauce-[^/]+|rxjs)\//.test(id)) return 'vendor-applesauce'
          if (/\/node_modules\/@(noble|scure)\//.test(id)) return 'vendor-crypto'
          if (/\/node_modules\/(qr-scanner|qrcode)\//.test(id)) return 'vendor-qr'
          if (/\/node_modules\/(react|react-dom|scheduler|zustand)\//.test(id)) return 'vendor-react'
        },
      },
    },
  },
})
