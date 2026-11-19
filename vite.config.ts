import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The app version shown at the bottom of settings and on top of the support log:
 * commit date, short hash, `+` when tracked files were changed,
 * ` dev` on the dev server. `unknown` without git.
 */
function appVersion(command: 'build' | 'serve'): string {
  let v = 'unknown'
  try {
    const git = (args: string) => execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const date = git('show -s --format=%cs HEAD')
    const hash = git('rev-parse --short=7 HEAD')
    const dirty = git('status --porcelain --untracked-files=no') !== ''
    v = `${date} ${hash}${dirty ? '+' : ''}`
  } catch {
    v = 'unknown'
  }
  return command === 'serve' ? `${v} dev` : v
}

/** Extra dev server host names from DEV_ALLOWED_HOSTS, e.g. `.example.net,phone.example.org`. */
function devAllowedHosts(): string[] {
  return (process.env.DEV_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '')
}

export default defineConfig(({ command }) => ({
  base: '/',
  plugins: [react()],
  // DEV_ALLOWED_HOSTS (comma-separated) lists extra host names the dev server answers to,
  // for opening it from another device through an https proxy; empty means localhost only.
  // Port 5173 is fixed so such a proxy keeps pointing at the right place: a busy port
  // fails instead of quietly moving to 5174.
  server: { port: 5173, strictPort: true, allowedHosts: devAllowedHosts() },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion(command)),
  },
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
}))
