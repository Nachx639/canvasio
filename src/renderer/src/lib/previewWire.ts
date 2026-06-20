// Live preview auto-wiring.
//
// Watches coalesced terminal output for local dev-server URLs (vite, next,
// astro, plain http servers, etc.) and opens a single web-preview node per
// distinct URL, positioned to the right of the terminal that printed it.
//
// Design goals:
//  - magical: a preview just appears when a dev server boots.
//  - NOT spammy: at most one preview per distinct URL, ever. URLs printed on
//    every keystroke / hot-reload never spawn a second node.

import { stripAnsi } from './agentStatus'
import { useCanvas } from '../store/canvas'

// --- URL detection ----------------------------------------------------------

// Bare host:port URLs we care about. Captures protocol-prefixed and bare forms.
// We deliberately scope to loopback / wildcard hosts so we don't auto-open
// arbitrary external links an agent might print.
const LOCAL_HOST_RE = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{2,5})?(?:\/[^\s'"`)>\]]*)?/gi

// Hosts we treat as "local dev server" for normalization.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0'])

/**
 * Normalize a candidate match into a canonical `http(s)://host[:port][/path]`
 * URL, or return null if it isn't a usable local dev-server URL.
 *
 * - 0.0.0.0 is rewritten to localhost (0.0.0.0 isn't browsable).
 * - a missing protocol becomes http://.
 * - trailing punctuation that commonly clings to URLs in prose is trimmed.
 */
function normalizeUrl(raw: string): string | null {
  let s = raw.trim()
  if (!s) return null

  // Trim trailing punctuation/brackets that aren't part of the URL.
  s = s.replace(/[).,;:!?'"`>\]]+$/g, '')

  // Ensure a protocol so the URL constructor can parse it.
  const withProto = /^https?:\/\//i.test(s) ? s : `http://${s}`

  let u: URL
  try {
    u = new URL(withProto)
  } catch {
    return null
  }

  const host = u.hostname.toLowerCase()
  if (!LOCAL_HOSTS.has(host)) return null

  // 0.0.0.0 is a bind-all address, not browsable; localhost is.
  if (host === '0.0.0.0') u.hostname = 'localhost'

  // Drop a lone trailing slash so `…:3000/` and `…:3000` dedupe to one URL.
  let out = u.toString()
  if (out.endsWith('/') && u.pathname === '/') out = out.slice(0, -1)
  return out
}

/**
 * Find local dev-server URLs in (possibly ANSI-laden) terminal output.
 *
 * Recognizes both raw URLs and the common framework "announcement" lines
 * (Vite `Local:`, Next `ready on`, generic `Listening on`, etc.) — in practice
 * those lines all contain a localhost URL, so a single host:port scan covers
 * them, while the labelled forms below catch host:port spelled without a
 * scheme right after the label.
 *
 * Returns de-duplicated, normalized full URLs in first-seen order.
 */
export function detectUrls(text: string): string[] {
  if (!text) return []
  const clean = stripAnsi(text)

  const found = new Map<string, true>()
  const add = (raw: string): void => {
    const url = normalizeUrl(raw)
    if (url && !found.has(url)) found.set(url, true)
  }

  // 1) Direct host:port scan (covers most framework banners too).
  for (const m of clean.matchAll(LOCAL_HOST_RE)) add(m[0])

  // 2) Labelled lines where the host might be written without a port or where
  //    the value sits after a label like "Local:" / "ready on" / "Listening on".
  //    We grab the token after the label and let normalizeUrl validate it.
  const LABEL_RE =
    /(?:local|on your network|network|ready on|listening on|listening at|server running at|app running at|preview)\s*:?\s+(\S+)/gi
  for (const m of clean.matchAll(LABEL_RE)) add(m[1])

  return [...found.keys()]
}

// --- preview controller -----------------------------------------------------

// Module-level guard: every URL we've ever opened a preview for, so repeated
// prints (hot reloads, re-runs) never spawn duplicates or spam the canvas.
const openedUrls = new Set<string>()

/**
 * Open a web-preview node for `url` exactly once.
 *
 * If a web node already shows the URL (or we've opened it before), this is a
 * no-op. Otherwise a new `kind:'web'` node is created just to the right of the
 * source terminal node, so the preview visually "belongs" to it.
 */
export function maybeOpenPreview(sourceNodeId: string, url: string): void {
  const normalized = normalizeUrl(url)
  if (!normalized) return

  // Already handled this URL — never open twice.
  if (openedUrls.has(normalized)) return

  const store = useCanvas.getState()
  const nodes = store.nodes

  // If a web node already shows this URL, just remember it and bail.
  const existing = nodes.find((n) => n.kind === 'web' && n.url === normalized)
  if (existing) {
    openedUrls.add(normalized)
    return
  }

  // Claim the URL up-front so concurrent flushes can't double-open it.
  openedUrls.add(normalized)

  const source = nodes.find((n) => n.id === sourceNodeId)
  const gap = 28
  // Place to the right of the source node; fall back to a sensible default
  // position if the source has vanished.
  const x = source ? source.x + source.w + gap : 120
  const y = source ? source.y : 120

  store.addNode({ kind: 'web', url: normalized, title: 'Preview', x, y })
}

/**
 * Test/escape hatch: forget which URLs have been opened. Not used in the app
 * runtime but handy for resets.
 */
export function resetPreviewWire(): void {
  openedUrls.clear()
}
