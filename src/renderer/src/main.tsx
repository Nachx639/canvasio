import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/index.css'
import { initRendererLogging } from './lib/logger'

// Install structured renderer logging (console.warn/error forwarding, uncaught
// errors + unhandled rejections -> runtime log) before the app mounts.
initRendererLogging()

// NOTE: StrictMode is intentionally disabled — its double mount/unmount would
// spawn (and then orphan) two real PTY processes per terminal node.
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
