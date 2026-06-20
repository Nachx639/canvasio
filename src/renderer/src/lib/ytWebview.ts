/* ================================================================== */
/* ytWebview — drive a YouTube embed through an Electron <webview>     */
/* via the privileged canvasio-yt:// scheme that serves a player page. */
/* ------------------------------------------------------------------ */
/* Why the canvasio-yt:// scheme instead of loading youtube.com/embed  */
/* directly:                                                            */
/*   YouTube's IFrame API completes a postMessage handshake keyed on    */
/*   window.location.origin. In the packaged app the renderer (and a    */
/*   <webview> that loads youtube.com/embed straight from a file://     */
/*   host) has the OPAQUE origin "null", so the handshake never         */
/*   completes: onReady never fires, the player sits on "Cargando…"     */
/*   forever, and YouTube returns error 150 because the embed has no    */
/*   legitimate referrer/origin.                                        */
/*                                                                      */
/*   The main process now serves a tiny player page at                  */
/*   canvasio-yt://player?v=<id>. That page runs at a REAL secure       */
/*   origin (canvasio-yt://…, registered as secure+standard), so the    */
/*   IFrame API handshake completes, the YT.Player exposes its full     */
/*   API, and the embed sees a valid referrer. We drive playback by     */
/*   calling window.yt*() functions (defined inside the player page)    */
/*   through webview.executeJavaScript(). This works identically in     */
/*   dev (http://localhost) and in the packaged file:// app.            */
/*                                                                      */
/*   The player page also catches non-embeddable errors (150 = embed    */
/*   blocked, 101 = owner disallows embedding) and surfaces them via    */
/*   ytGetState().error, so the host can show an "Abrir en YouTube"     */
/*   fallback instead of a perpetual spinner.                           */
/* ================================================================== */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Build the URL we load inside the <webview>: the privileged player page,
 * parameterized with the video id. The page itself constructs the YouTube
 * embed at a real secure origin so the IFrame API works (see file header).
 */
export function initializeYouTubeWebviewUrl(videoId: string): string {
  return `canvasio-yt://player?v=${encodeURIComponent(videoId)}`
}

/* ------------------------------------------------------------------ */
/* In-page control helpers                                             */
/* ------------------------------------------------------------------ */
/* These run INSIDE the player page via executeJavaScript(). The page  */
/* exposes window.ytPlay / ytPause / ytSeek / ytSetVolume / ytLoad() and    */
/* window.ytGetState() which returns {currentTime, duration, paused,        */
/* playerState, ended, error, title}. Error 150/101 are non-embeddable.     */
/* We directly call these functions; no intermediate bridge wrapper needed.  */
/* ------------------------------------------------------------------ */

/**
 * Execute a playback command inside the webview guest by calling the player
 * page's exposed window.yt* functions. `setVolume`'s arg is 0..1; we convert
 * to YouTube's 0..100 range (ytSetVolume itself unMutes + clamps).
 */
export async function executeYouTubeWebviewCommand(
  webviewRef: React.RefObject<any>,
  command: 'play' | 'pause' | 'seekTo' | 'setVolume',
  arg?: number
): Promise<void> {
  const wv = webviewRef.current
  if (!wv || typeof wv.executeJavaScript !== 'function') return

  const n = Number(arg) || 0
  const vol01 = Math.max(0, Math.min(1, n))
  const volYT = Math.round(vol01 * 100)

  let js = ''
  switch (command) {
    case 'play':
      js = 'window.ytPlay&&window.ytPlay();'
      break
    case 'pause':
      js = 'window.ytPause&&window.ytPause();'
      break
    case 'seekTo':
      js = `window.ytSeek&&window.ytSeek(${n});`
      break
    case 'setVolume':
      js = `window.ytSetVolume&&window.ytSetVolume(${volYT});`
      break
  }

  try {
    await wv.executeJavaScript(js, true)
  } catch {
    /* guest not ready / navigated away — ignore */
  }
}

export interface YouTubeWebviewState {
  currentTime: number
  duration: number
  paused: boolean
  title: string
  /** Player state from YT API: -1=unstarted, 0=ended, 1=playing, 2=paused, 3=buffering, 5=cued */
  playerState?: number
  /** True if the video has ended (playerState === 0). Used to auto-advance the queue. */
  ended?: boolean
  /** Non-embeddable error code from the player page (150 / 101), else null. */
  error?: number | null
}

/**
 * Read the current playback state out of the guest in a single round-trip via
 * the player page's window.ytGetState() function. Returns null when the guest
 * (or the function) isn't ready yet.
 */
export async function readYouTubeWebviewState(
  webviewRef: React.RefObject<any>
): Promise<YouTubeWebviewState | null> {
  const wv = webviewRef.current
  if (!wv || typeof wv.executeJavaScript !== 'function') return null

  // The player page exposes window.ytGetState() which returns the current state
  // or null if the player isn't ready yet. Direct call avoids any wrapper overhead.
  const js = 'window.ytGetState&&window.ytGetState();'

  try {
    const res = await wv.executeJavaScript(js, true)
    if (!res || typeof res !== 'object') return null
    return {
      currentTime: Number(res.currentTime) || 0,
      duration: Number(res.duration) || 0,
      paused: !!res.paused,
      playerState: typeof res.playerState === 'number' ? res.playerState : 1,
      ended: !!res.ended,
      error: typeof res.error === 'number' ? res.error : null,
      title: typeof res.title === 'string' ? res.title : ''
    }
  } catch {
    return null
  }
}

/**
 * Poll the guest player on an interval, pushing state to `onState`.
 * Returns a cleanup function that stops the interval. The caller owns the
 * lifetime; call the returned cleanup on unmount / videoId change.
 */
export function pollYouTubeWebviewPlayer(
  webviewRef: React.RefObject<any>,
  onState: (s: YouTubeWebviewState) => void,
  intervalMs = 250
): () => void {
  let stopped = false
  const id = window.setInterval(() => {
    if (stopped) return
    void readYouTubeWebviewState(webviewRef).then((s) => {
      if (!stopped && s) onState(s)
    })
  }, intervalMs)
  return () => {
    stopped = true
    window.clearInterval(id)
  }
}
