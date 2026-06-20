import { useEffect, useRef, useState } from 'react'
import { CanvasNode, useCanvas } from '../store/canvas'
import { log as rlog } from '../lib/logger'
import { useT } from '../store/i18n'

// Electron's <webview> custom element isn't in React's JSX types; alias it.
const Webview = 'webview' as unknown as React.FC<
  React.HTMLAttributes<HTMLElement> & {
    ref?: React.Ref<unknown>
    src?: string
    partition?: string
  }
>

// Only http(s) navigations are permitted inside the preview. Anything else
// (file:, about:, javascript:, data:, custom app schemes, etc.) is denied so a
// page can't escape the sandbox or hand a hostile URL to the host shell.
function isAllowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// Coerce free-form user input into a candidate http(s) URL (defaulting bare
// hosts/ports like "localhost:3000" to http://). Returns null when the result
// is not an allowed http(s) URL.
function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : 'http://' + trimmed
  return isAllowedUrl(candidate) ? candidate : null
}

export function WebPreview({ node }: { node: CanvasNode }): JSX.Element {
  const t = useT()
  const initial = normalizeUrl(node.url || 'http://localhost:3000') || 'http://localhost:3000'
  const [url, setUrl] = useState(initial)
  const [input, setInput] = useState(initial)
  const [loading, setLoading] = useState(false)
  const webviewRef = useRef<any>(null)

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const onStart = (): void => setLoading(true)
    const onStop = (): void => setLoading(false)
    // Deny in-page navigations to non-http(s) targets.
    const onWillNavigate = (e: { preventDefault: () => void; url: string }): void => {
      if (!isAllowedUrl(e.url)) e.preventDefault()
    }
    // NOTE: the <webview> 'new-window' DOM event was removed (deprecated v12,
    // removed v22) and never fires on Electron 33+. Popups are now handled in the
    // main process via guestWebContents.setWindowOpenHandler (src/main/index.ts):
    // allowed http(s) popups open in the OS browser and are denied in-app. The
    // previous renderer-side 'new-window' listener was dead code and is removed.
    // Persist the CURRENT url onto the node so a web preview KEEPS its page across
    // canvas switches / app restarts (otherwise a restored node reloads the original
    // node.url — e.g. localhost:3000 — losing wherever you had navigated).
    const onDidNavigate = (e: { url: string }): void => {
      if (e.url && isAllowedUrl(e.url)) {
        setUrl(e.url)
        setInput(e.url)
        useCanvas.getState().updateNode(node.id, { url: e.url })
      }
    }
    // Surface failed loads to the runtime log (the Doctor watches did-fail-load).
    const onFailLoad = (e: {
      errorCode?: number
      errorDescription?: string
      validatedURL?: string
      isMainFrame?: boolean
    }): void => {
      // Ignore aborts (errorCode -3) from user-initiated navigations.
      if (e.errorCode === -3) return
      if (e.isMainFrame === false) return
      rlog.error('web.did-fail-load', {
        errorCode: e.errorCode,
        errorDescription: e.errorDescription,
        url: e.validatedURL
      })
    }
    // Bring the node to front when the user clicks INTO the guest page. Clicks
    // inside an Electron <webview> happen in a separate render process and never
    // bubble to the host React tree, so the node root's onPointerDown (which does
    // select + bringToFront) never fires for in-page clicks — the web node would
    // stay behind other windows. The embedder DOES focus the <webview> element
    // when its guest is clicked, so we hook that focus to raise + select the node.
    // Reads the store fresh (the effect closure's node.z would be stale).
    const onGuestFocus = (): void => {
      const s = useCanvas.getState()
      s.select(node.id)
      const n = s.nodes.find((x) => x.id === node.id)
      if (n && n.z < s.topZ) s.bringToFront(node.id)
    }
    // Recover from a dead guest: when the preview's render process crashes the
    // pane goes permanently blank, so log it and reload the current url in place.
    const onRenderGone = (e?: { reason?: string; exitCode?: number }): void => {
      const current = wv.getURL?.() || url
      rlog.error('web.render-process-gone', {
        reason: e?.reason,
        exitCode: e?.exitCode,
        url: current
      })
      if (wv.loadURL) wv.loadURL(current)
      else wv.reload?.()
    }
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('will-navigate', onWillNavigate)
    wv.addEventListener('did-navigate', onDidNavigate)
    wv.addEventListener('did-navigate-in-page', onDidNavigate)
    wv.addEventListener('did-fail-load', onFailLoad)
    wv.addEventListener('crashed', onRenderGone)
    wv.addEventListener('render-process-gone', onRenderGone)
    wv.addEventListener('focus', onGuestFocus)
    return () => {
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('will-navigate', onWillNavigate)
      wv.removeEventListener('did-navigate', onDidNavigate)
      wv.removeEventListener('did-navigate-in-page', onDidNavigate)
      wv.removeEventListener('did-fail-load', onFailLoad)
      wv.removeEventListener('crashed', onRenderGone)
      wv.removeEventListener('render-process-gone', onRenderGone)
      wv.removeEventListener('focus', onGuestFocus)
    }
  }, [])

  const go = (target?: string): void => {
    const full = normalizeUrl(target ?? input)
    if (!full) return
    setUrl(full)
    setInput(full)
    webviewRef.current?.loadURL?.(full)
  }

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 8px',
          borderBottom: '1px solid rgba(120,150,220,0.12)'
        }}
      >
        <button onClick={() => webviewRef.current?.reload?.()} title={t('webPreview.reload')} style={navBtn}>
          ⟳
        </button>
        <button onClick={() => webviewRef.current?.goBack?.()} title={t('webPreview.back')} style={navBtn}>
          ‹
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
          spellCheck={false}
          style={{
            flex: 1,
            background: 'rgba(8,12,26,0.7)',
            border: '1px solid rgba(120,150,220,0.16)',
            borderRadius: 7,
            padding: '5px 10px',
            color: '#dbe6ff',
            fontSize: 12,
            outline: 'none',
            fontFamily: 'monospace'
          }}
        />
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: loading ? '#f2c84b' : '#48d597' }} />
      </div>
      <div style={{ flex: 1, position: 'relative', background: '#fff' }}>
        <Webview
          ref={webviewRef}
          src={url}
          partition={`persist:webpreview-${node.id}`}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        />
      </div>
    </div>
  )
}

const navBtn: React.CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 6,
  border: '1px solid rgba(120,150,220,0.16)',
  background: 'rgba(255,255,255,0.04)',
  color: '#aebbd6',
  fontSize: 14,
  display: 'grid',
  placeItems: 'center'
}
