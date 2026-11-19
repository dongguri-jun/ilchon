import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

/**
 * Screen tests: two profiles on the dev server, over the real relays.
 * The dev server gets its own port so a running `pnpm dev` (5173) is left alone.
 * Not part of `pnpm check`: it needs the network. Run with `pnpm e2e:ui`.
 */
const PORT = 5183
// An address, not `localhost`, so the server and the readiness check agree on IPv4.
const HOST = '127.0.0.1'

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: '../../test-results/ui',
  // Real relays are slow and sometimes drop a message: generous waits, one retry, one worker.
  timeout: 5 * 60_000,
  expect: { timeout: 60_000 },
  retries: 1,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    ...devices['Pixel 7'],
    // Phone-sized screen.
    viewport: { width: 390, height: 844 },
    baseURL: `http://${HOST}:${PORT}`,
    locale: 'ko-KR',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `pnpm exec vite --host ${HOST} --port ${PORT} --strictPort`,
    // The command runs from this folder by default; Vite must start at the repository root.
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    url: `http://${HOST}:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
