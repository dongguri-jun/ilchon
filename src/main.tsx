import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './ui/tokens.css'
import { ToastProvider } from './ui'
import { bootEngine } from './engine/browser'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
)

// Boot failures surface through state.boot === 'error'; never let one escape as
// an unhandled rejection.
void Promise.resolve()
  .then(() => bootEngine())
  .catch(() => undefined)
