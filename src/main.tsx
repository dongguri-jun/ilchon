// First: error handlers and the support log, before the engine and Marmot chunks are evaluated.
import './lib/support-log/browser'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './ui/tokens.css'
import { ToastProvider } from './ui'
import { bootEngine } from './engine/browser'
import App from './App'
import { CrashBoundary } from './screens/shell/CrashBoundary'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CrashBoundary>
      <ToastProvider>
        <App />
      </ToastProvider>
    </CrashBoundary>
  </StrictMode>,
)

// Boot failures surface through state.boot === 'error'; never let one escape as
// an unhandled rejection.
void Promise.resolve()
  .then(() => bootEngine())
  .catch(() => undefined)
