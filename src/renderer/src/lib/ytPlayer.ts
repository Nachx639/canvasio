/* ================================================================== */
/* ytPlayer — minimal singleton wrapper around the YouTube IFrame API  */
/* ------------------------------------------------------------------ */
/* Why a singleton: the YT IFrame API attaches a single global object  */
/* (`window.YT`) and the loader script can only be injected once. Each  */
/* music node creates its OWN <div> target and gets its OWN YT.Player   */
/* instance bound to that div — but they all share the one global API   */
/* script loaded here. We expose a promise-based loader so callers can   */
/* `await ensureYouTubeApi()` regardless of load order, plus helpers to  */
/* parse a video id out of any common YouTube URL form.                 */
/* ================================================================== */

/* eslint-disable @typescript-eslint/no-explicit-any */

let scriptInjected = false
let apiReadyPromise: Promise<void> | null = null

/**
 * Extract the 11-char video id from any common YouTube URL/share form, or
 * accept a bare id directly. Returns null when nothing usable is found.
 *  - https://www.youtube.com/watch?v=ID
 *  - https://youtu.be/ID
 *  - https://www.youtube.com/embed/ID
 *  - https://www.youtube.com/shorts/ID
 *  - https://music.youtube.com/watch?v=ID
 *  - ID (bare)
 */
export function parseYouTubeUrl(input: string): string | null {
  if (!input) return null
  const raw = input.trim()
  // Bare id (11 chars of the YouTube id alphabet).
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`)
    const host = u.hostname.replace(/^www\./, '')
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0]
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null
    }
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const v = u.searchParams.get('v')
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v
      // /embed/ID, /shorts/ID, /live/ID
      const m = u.pathname.match(/\/(?:embed|shorts|live|v)\/([a-zA-Z0-9_-]{11})/)
      if (m) return m[1]
    }
  } catch {
    /* not a URL */
  }
  return null
}

/** Thumbnail URL for a video id (hqdefault is always present). */
export function youTubeThumbnail(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
}

/** Canonical watch URL we persist on the node (mirrors WebPreview's node.url). */
export function youTubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`
}

/**
 * Ensure the global YT IFrame API script is loaded and `window.YT.Player` is
 * available. Safe to call any number of times — the load happens once and all
 * callers share the same promise.
 */
export function ensureYouTubeApi(): Promise<void> {
  if (apiReadyPromise) return apiReadyPromise

  apiReadyPromise = new Promise<void>((resolve) => {
    const w = window as any
    if (w.YT && w.YT.Player) {
      resolve()
      return
    }

    // The IFrame API calls this global once it has finished initializing.
    const prev = w.onYouTubeIframeAPIReady
    w.onYouTubeIframeAPIReady = (): void => {
      if (typeof prev === 'function') {
        try {
          prev()
        } catch {
          /* ignore prior hook errors */
        }
      }
      resolve()
    }

    if (!scriptInjected) {
      scriptInjected = true
      const tag = document.createElement('script')
      tag.src = 'https://www.youtube.com/iframe_api'
      tag.async = true
      document.head.appendChild(tag)
    }
  })

  return apiReadyPromise
}

export interface YTPlayerEvents {
  onReady?: (player: any) => void
  /** YT.PlayerState: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued */
  onStateChange?: (state: number, player: any) => void
  onError?: (code: number) => void
}

/**
 * @deprecated The MusicPlayer no longer uses the YT IFrame JS API. In the
 * packaged app the renderer is served from file:// (opaque origin "null"), so
 * the API's origin-keyed postMessage handshake never completes and the player
 * is stuck loading. Playback now goes through an Electron <webview> embed
 * driven by webview.executeJavaScript() (see lib/ytWebview.ts +
 * components/MusicPlayer.tsx). Kept here only for reference / possible future
 * use; parseYouTubeUrl / youTubeThumbnail / youTubeWatchUrl above are still used.
 *
 * Create a YT.Player bound to `targetEl` for `videoId`. Resolves with the
 * player instance once it is ready. The caller OWNS the returned player and is
 * responsible for `.destroy()`-ing it on unmount.
 */
export async function createYouTubePlayer(
  targetEl: HTMLElement,
  videoId: string,
  events: YTPlayerEvents = {}
): Promise<any> {
  await ensureYouTubeApi()
  const w = window as any
  return new Promise((resolve) => {
    const player = new w.YT.Player(targetEl, {
      videoId,
      width: '100%',
      height: '100%',
      playerVars: {
        // enablejsapi is implied by using the JS API, but set explicitly.
        enablejsapi: 1,
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        origin: window.location.origin
      },
      events: {
        onReady: () => {
          events.onReady?.(player)
          resolve(player)
        },
        onStateChange: (e: any) => events.onStateChange?.(e.data, player),
        onError: (e: any) => events.onError?.(e.data)
      }
    })
  })
}
