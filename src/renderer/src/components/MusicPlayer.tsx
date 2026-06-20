import { useCallback, useEffect, useRef, useState } from 'react'
import { CanvasNode, useCanvas } from '../store/canvas'
import { useT } from '../store/i18n'
import { logAction, log as rlog } from '../lib/logger'
import { parseYouTubeUrl, youTubeThumbnail, youTubeWatchUrl } from '../lib/ytPlayer'
import {
  executeYouTubeWebviewCommand,
  initializeYouTubeWebviewUrl,
  pollYouTubeWebviewPlayer
} from '../lib/ytWebview'

// Electron's <webview> custom element isn't in React's JSX types; alias it.
// Same pattern WebPreview.tsx uses to embed arbitrary https pages reliably.
const Webview = 'webview' as unknown as React.FC<
  React.HTMLAttributes<HTMLElement> & {
    ref?: React.Ref<unknown>
    src?: string
    partition?: string
    allowpopups?: string
  }
>

/* eslint-disable @typescript-eslint/no-explicit-any */

/* ------------------------------------------------------------------ */
/* SomaFM live radio stations (secondary "Estaciones" tab fallback)    */
/* ------------------------------------------------------------------ */

const STATIONS: { tag: string; label: string; url: string }[] = [
  { tag: 'lofi', label: 'Groove Salad', url: 'https://ice1.somafm.com/groovesalad-128-mp3' },
  { tag: 'jazz', label: 'Secret Agent', url: 'https://ice1.somafm.com/secretagent-128-mp3' },
  { tag: 'ambient', label: 'Drone Zone', url: 'https://ice1.somafm.com/dronezone-128-mp3' },
  { tag: 'beats', label: 'Beat Blender', url: 'https://ice1.somafm.com/beatblender-128-mp3' },
  { tag: 'indie', label: 'Indie Pop Rocks', url: 'https://ice1.somafm.com/indiepop-128-mp3' },
  { tag: 'lush', label: 'Lush', url: 'https://ice1.somafm.com/lush-128-mp3' }
]

const ACCENT = '#ff6633'
type Tab = 'youtube' | 'stations'

function fmtTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) secs = 0
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/* ================================================================== */
/* Component — hybrid YouTube (primary) + SomaFM (fallback) player     */
/* ================================================================== */

export function MusicPlayer({ node }: { node: CanvasNode }): JSX.Element {
  const tr = useT()
  /* ---- app-level master volume (primitive selectors, no #185 risk) ---- */
  const appVolume = useCanvas((s) => s.appVolume)
  const setAppVolume = useCanvas((s) => s.setAppVolume)
  const musicRequest = useCanvas((s) => s.musicRequest)

  /* ---- active tab (persisted via node.musicMode) ---- */
  const [tab, setTab] = useState<Tab>(node.musicMode === 'somafm' ? 'stations' : 'youtube')

  /* ---- YouTube state ---- */
  const initialId = parseYouTubeUrl(node.url || '')
  const [videoId, setVideoId] = useState<string | null>(initialId)
  const [videoTitle, setVideoTitle] = useState(node.musicTitle || '')
  const [ytPlaying, setYtPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [inputValue, setInputValue] = useState('')
  const [scrubbing, setScrubbing] = useState(false)
  const [thumbBroken, setThumbBroken] = useState(false)
  // Non-embeddable error surfaced by the player page (150 = embed blocked,
  // 101 = owner disallows embedding). When set we show an "Abrir en YouTube"
  // fallback over the video square instead of a perpetual spinner.
  const [ytError, setYtError] = useState<number | null>(null)

  /* ---- YouTube queue state (persisted via node.musicQueue / musicQueueIndex) ---- */
  type QueueItem = NonNullable<CanvasNode['musicQueue']>[number]
  const [queueItems, setQueueItems] = useState<QueueItem[]>(node.musicQueue ?? [])
  const [queueIndex, setQueueIndex] = useState<number>(node.musicQueueIndex ?? 0)
  const [showQueuePanel, setShowQueuePanel] = useState(false)

  // Electron <webview> hosting the YouTube embed. Playback is driven by
  // executeJavaScript() against the guest's <video> element — see ytWebview.ts.
  const ytWebviewRef = useRef<any>(null)
  const stopPollRef = useRef<(() => void) | null>(null)
  // Embed URL to load; recomputed when the video id changes.
  const [ytWebviewUrl, setYtWebviewUrl] = useState<string | null>(
    initialId ? initializeYouTubeWebviewUrl(initialId) : null
  )

  /* ---- yt-dlp resolved stream (primary playback path) ---- */
  // When yt-dlp resolves a direct media URL we play it in a native <video>
  // (full audio + video, bypassing the embed-restriction error 150/153). When
  // resolution fails (binary missing or yt-dlp error) we leave this null and
  // fall back to the canvasio-yt webview embed below, fully unchanged.
  const [resolvedStream, setResolvedStream] = useState<string | null>(null)
  const [ytdlpResolveFailed, setYtdlpResolveFailed] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  /* ---- SomaFM state (secondary tab) ---- */
  const [stationIdx, setStationIdx] = useState(0)
  const [stationPlaying, setStationPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const stationPlayingRef = useRef(stationPlaying)
  stationPlayingRef.current = stationPlaying

  /* ---- procedural visualizer ---- */
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const barsRef = useRef<number[]>([])

  /* ---- Web Audio analyser wiring (real FFT when a native media el is tappable) ---- */
  // ONE shared AudioContext for the whole component. Created lazily on first
  // successful tap (needs a user gesture to leave "suspended").
  const audioCtxRef = useRef<AudioContext | null>(null)
  // MediaElementSourceNodes are cached per element — createMediaElementSource()
  // THROWS if called twice on the same element, so we key by the element identity.
  const srcNodeRef = useRef<Map<HTMLMediaElement, MediaElementAudioSourceNode>>(new Map())
  // The single AnalyserNode all tapped sources fan into.
  const analyserRef = useRef<AnalyserNode | null>(null)
  // Scratch buffer for getByteFrequencyData (sized to analyser.frequencyBinCount).
  // Typed with an explicit ArrayBuffer backing so getByteFrequencyData accepts it
  // under the strict lib's Uint8Array<ArrayBuffer> signature.
  const freqDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  // Which element is currently routed into the analyser (so we don't re-tap).
  const tappedElRef = useRef<HTMLMediaElement | null>(null)
  // Peak-decay state per rendered bar (separate from barsRef, which the
  // procedural path uses; we reuse barsRef for the smoothed magnitudes and add a
  // peaks ref for the falling peak caps).
  const peaksRef = useRef<number[]>([])
  // True when the analyser produced real data on the last frame (drives whether
  // the EQ shows the polished spectrum or the procedural fallback).
  const analyserLiveRef = useRef(false)

  /* ---- Responsive density: measure the player's own height so it can shed
     non-essential rows and shrink the media area to fit a very small node.
     Two thresholds: `compact` collapses the video/EQ (kept MOUNTED at height 0 so
     audio never stops / no #185 remount) + hides the queue list; `tiny` also
     hides the paste row + now-playing card, leaving just tabs + transport +
     volume. Driven by a ResizeObserver (primitive boolean states → #185-safe). */
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [compact, setCompact] = useState(false)
  const [tiny, setTiny] = useState(false)
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const hgt = entries[0]?.contentRect.height ?? el.clientHeight
      setCompact(hgt < 340)
      setTiny(hgt < 208)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /* a single "is anything playing" signal drives the visualizer */
  const anyPlaying = ytPlaying || stationPlaying
  const anyPlayingRef = useRef(anyPlaying)
  anyPlayingRef.current = anyPlaying

  // The native media element we can tap for real FFT, if any. The cross-origin
  // <webview> embed is NOT tappable → null → procedural fallback. Recomputed each
  // render; the draw loop reads it from a ref so it never needs the loop rebuilt.
  // Computed from `tab` directly (onYouTubeTab is derived later) to avoid a TDZ.
  const tappableEl: HTMLMediaElement | null =
    tab === 'youtube'
      ? (resolvedStream ? videoRef.current : null)
      : tab === 'stations'
        ? (stationPlaying ? audioRef.current : null)
        : null
  const tappableElRef = useRef<HTMLMediaElement | null>(tappableEl)
  tappableElRef.current = tappableEl

  const lastReqToken = useRef(0)

  /* ---------------------------------------------------------------- */
  /* SomaFM <audio> lifecycle                                         */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const audio = new Audio()
    audio.preload = 'none'
    audio.crossOrigin = 'anonymous'
    audio.volume = appVolume
    audioRef.current = audio
    return () => {
      audio.pause()
      audio.src = ''
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* master volume → SomaFM audio + native <video> + YouTube embed (0..1) */
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = appVolume
    if (videoRef.current) videoRef.current.volume = appVolume
    void executeYouTubeWebviewCommand(ytWebviewRef, 'setVolume', appVolume)
  }, [appVolume])

  /* ---------------------------------------------------------------- */
  /* YouTube webview lifecycle — load embed + poll guest <video>      */
  /* ---------------------------------------------------------------- */
  /* The embed is loaded in an Electron <webview> (privileged Chromium  */
  /* guest). We DON'T use the cross-origin postMessage IFrame API —     */
  /* instead we read/write the guest <video> element directly through    */
  /* webview.executeJavaScript(), which works from a file:// host too.   */
  /* A 250ms poll mirrors the guest's currentTime/duration/paused into   */
  /* our state, driving the orange controller below.                     */
  /* ---------------------------------------------------------------- */

  // Keep a ref to the latest `scrubbing` flag so the poll callback (set up
  // once per video) doesn't clobber the scrubber while the user drags it.
  const scrubbingRef = useRef(scrubbing)
  scrubbingRef.current = scrubbing
  const videoTitleRef = useRef(videoTitle)
  videoTitleRef.current = videoTitle
  // Keep refs to the latest queue + index so the poll callback (wired once per
  // video) reads CURRENT values when it detects the song ended, instead of the
  // stale values captured when the effect ran.
  const queueItemsRef = useRef(queueItems)
  queueItemsRef.current = queueItems
  const queueIndexRef = useRef(queueIndex)
  queueIndexRef.current = queueIndex
  // Guard so the auto-advance fires only once per "ended" edge, not on every
  // poll tick while the guest sits in the ended (state 0) state.
  const advancedForRef = useRef<string | null>(null)

  // Mirror master volume into the resolution effect's <video> wiring without
  // re-subscribing event listeners on every volume change.
  const appVolumeRef = useRef(appVolume)
  appVolumeRef.current = appVolume

  /* ---------------------------------------------------------------- */
  /* yt-dlp resolution — runs FIRST on every videoId change           */
  /* ------------------------------------------------------------------*/
  /* Ask the main process to resolve a direct media URL via yt-dlp. On  */
  /* success we play it in the native <video> below (real video+audio,  */
  /* no embed restriction). On failure we clear resolvedStream and let   */
  /* the webview embed effect take over as the fallback path.            */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    if (!videoId) {
      setResolvedStream(null)
      setYtdlpResolveFailed(false)
      return
    }

    let cancelled = false
    // Drop any previous stream immediately so the old <video> tears down while
    // the new id resolves (avoids briefly playing the wrong song).
    setResolvedStream(null)
    setYtdlpResolveFailed(false)

    void (async () => {
      try {
        const result = await window.canvasio.ytdlp.resolve(videoId)
        if (cancelled) return

        if (result.ok && result.url) {
          setResolvedStream(result.url)
          setYtdlpResolveFailed(false)
          if (result.title && result.title !== videoTitleRef.current) {
            setVideoTitle(result.title)
            // Backfill the resolved title onto the matching queue item so the
            // queue list shows proper names (mirrors the webview poll path).
            const q = queueItemsRef.current
            const idx = queueIndexRef.current
            if (
              q.length > 0 &&
              idx >= 0 &&
              idx < q.length &&
              q[idx].videoId === videoId &&
              q[idx].title !== result.title
            ) {
              const updatedQueue = q.map((it, i) =>
                i === idx ? { ...it, title: result.title } : it
              )
              setQueueItems(updatedQueue)
              persist({ musicTitle: result.title, musicQueue: updatedQueue })
            } else {
              persist({ musicTitle: result.title })
            }
          }
          if (typeof result.duration === 'number' && result.duration > 0) {
            setDuration(result.duration)
          }
        } else {
          setResolvedStream(null)
          setYtdlpResolveFailed(true)
          rlog.warn('music.ytdlp.resolve-failed', { videoId, reason: result.reason })
        }
      } catch (err) {
        if (cancelled) return
        setResolvedStream(null)
        setYtdlpResolveFailed(true)
        rlog.warn('music.ytdlp.resolve-error', {
          videoId,
          error: String((err as Error)?.message || err)
        })
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId])

  /* ---------------------------------------------------------------- */
  /* Native <video> transport — wired only when yt-dlp resolved a URL  */
  /* ------------------------------------------------------------------*/
  /* The <video> is a DOM element (kept stable, only its src/listeners   */
  /* change), so it never unmount/remount-trips React #185. Events       */
  /* (timeupdate / durationchange / ended / play / pause) drive the same  */
  /* controller + queue auto-advance the webview poll used to drive.      */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    const video = videoRef.current
    if (!resolvedStream || !video) {
      if (video) {
        video.pause()
        video.removeAttribute('src')
        video.load()
      }
      return
    }

    video.src = resolvedStream
    video.volume = appVolumeRef.current
    // New stream for this id: reset the per-video auto-advance guard so the
    // ended-edge can fire once for this song.
    advancedForRef.current = null
    video.play().catch(() => {
      // Autoplay can be blocked; the user can hit the play button. Keep state in
      // sync via the play/pause listeners below.
    })

    const onTimeUpdate = (): void => {
      if (!scrubbingRef.current) setCurrentTime(video.currentTime)
    }
    const onDurationChange = (): void => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        setDuration(video.duration)
      }
    }
    const onEnded = (): void => {
      // AUTO-ADVANCE: jump to the next queue item when the song ends. Reads
      // CURRENT queue/index from refs and fires once per ended-edge.
      const q = queueItemsRef.current
      const idx = queueIndexRef.current
      if (q.length > 0 && idx < q.length - 1 && advancedForRef.current !== videoId) {
        advancedForRef.current = videoId
        const nextIdx = idx + 1
        const nextItem = q[nextIdx]
        setQueueIndex(nextIdx)
        setVideoTitle(nextItem.title || '')
        setCurrentTime(0)
        setDuration(0)
        setThumbBroken(false)
        setYtError(null)
        setVideoId(nextItem.videoId)
        setYtWebviewUrl(initializeYouTubeWebviewUrl(nextItem.videoId))
        persist({ url: nextItem.url, musicMode: 'youtube', musicQueueIndex: nextIdx })
        logAction('music.queue.advance', { videoId: nextItem.videoId, index: nextIdx })
      } else {
        setYtPlaying(false)
      }
    }
    const onPlay = (): void => setYtPlaying(true)
    const onPause = (): void => setYtPlaying(false)
    // If yt-dlp resolved a URL the <video> can't actually play, DON'T get stuck:
    // drop the stream and flip to the embed fallback (which shows the player or the
    // "Abrir en YouTube" message).
    const onError = (): void => {
      setResolvedStream(null)
      setYtdlpResolveFailed(true)
    }

    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('durationchange', onDurationChange)
    video.addEventListener('ended', onEnded)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('error', onError)

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('durationchange', onDurationChange)
      video.removeEventListener('ended', onEnded)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('error', onError)
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedStream, videoId])

  useEffect(() => {
    // Tear down any previous poll before (re)starting.
    if (stopPollRef.current) {
      stopPollRef.current()
      stopPollRef.current = null
    }
    if (!videoId) {
      setYtPlaying(false)
      return
    }

    // yt-dlp is the PRIMARY path. Only fall back to the YouTube embed webview
    // AFTER resolution has FAILED — otherwise the embed would load in parallel and
    // briefly flash the "este vídeo no permite reproducirse" restriction error
    // before the native <video> (from yt-dlp) takes over.
    if (!ytdlpResolveFailed) {
      setYtWebviewUrl(null)
      return
    }

    const wv = ytWebviewRef.current

    // Load the embed for this id in place (mirrors WebPreview's loadURL flow).
    const embed = initializeYouTubeWebviewUrl(videoId)
    setYtWebviewUrl(embed)
    if (wv && typeof wv.loadURL === 'function') {
      try {
        wv.loadURL(embed)
      } catch {
        /* webview may not be attached yet; the src attr handles first load */
      }
    }

    const onFinishLoad = (): void => {
      // Apply current master volume to the freshly-loaded guest.
      void executeYouTubeWebviewCommand(ytWebviewRef, 'setVolume', useCanvas.getState().appVolume)
    }
    const onFailLoad = (e: { errorCode?: number; isMainFrame?: boolean }): void => {
      if (e.errorCode === -3) return // user-initiated abort
      if (e.isMainFrame === false) return
      rlog.warn('music.yt.webview.fail', { code: e.errorCode, videoId })
    }
    if (wv && typeof wv.addEventListener === 'function') {
      wv.addEventListener('did-finish-load', onFinishLoad)
      wv.addEventListener('did-fail-load', onFailLoad)
    }

    // Reset the per-video auto-advance guard + any prior embed error for this
    // newly-loaded id.
    advancedForRef.current = null
    setYtError(null)

    // Poll the guest for transport state and push it into React state.
    stopPollRef.current = pollYouTubeWebviewPlayer(ytWebviewRef, (s) => {
      // Surface (or clear) a genuine non-embeddable error so the render can show
      // the "Abrir en YouTube" fallback. Only 150/101 mean "can't embed".
      if (s.error === 150 || s.error === 101) {
        setYtError((prev) => (prev === s.error ? prev : s.error!))
      } else if (s.error === null) {
        setYtError((prev) => (prev === null ? prev : null))
      }
      setYtPlaying(!s.paused)
      if (!scrubbingRef.current) setCurrentTime(s.currentTime)
      if (s.duration) setDuration(s.duration)
      if (s.title && s.title !== videoTitleRef.current) {
        setVideoTitle(s.title)
        // Also backfill the real title onto the matching queue item so the queue
        // list shows proper names instead of "Vídeo N". Persist the updated queue
        // only when the current item actually lacked/changed its title.
        const q = queueItemsRef.current
        const idx = queueIndexRef.current
        if (q.length > 0 && idx >= 0 && idx < q.length && q[idx].videoId === videoId && q[idx].title !== s.title) {
          const updatedQueue = q.map((it, i) => (i === idx ? { ...it, title: s.title } : it))
          setQueueItems(updatedQueue)
          persist({ musicTitle: s.title, musicQueue: updatedQueue })
        } else {
          persist({ musicTitle: s.title })
        }
      }

      // AUTO-ADVANCE: when the current song ENDS, jump to the next queue item.
      // Read CURRENT queue/index from refs (the poll closure was built for the
      // previous video). Fire once per ended-edge via advancedForRef so we don't
      // skip several items while the guest lingers in the ended state.
      if (s.ended) {
        const q = queueItemsRef.current
        const idx = queueIndexRef.current
        if (q.length > 0 && idx < q.length - 1 && advancedForRef.current !== videoId) {
          advancedForRef.current = videoId
          const nextIdx = idx + 1
          const nextItem = q[nextIdx]
          setQueueIndex(nextIdx)
          setVideoTitle(nextItem.title || '')
          setCurrentTime(0)
          setDuration(0)
          setThumbBroken(false)
          setYtError(null)
          setVideoId(nextItem.videoId)
          setYtWebviewUrl(initializeYouTubeWebviewUrl(nextItem.videoId))
          persist({ url: nextItem.url, musicMode: 'youtube', musicQueueIndex: nextIdx })
          logAction('music.queue.advance', { videoId: nextItem.videoId, index: nextIdx })
        }
      }
    })

    return () => {
      if (stopPollRef.current) {
        stopPollRef.current()
        stopPollRef.current = null
      }
      if (wv && typeof wv.removeEventListener === 'function') {
        wv.removeEventListener('did-finish-load', onFinishLoad)
        wv.removeEventListener('did-fail-load', onFailLoad)
      }
      setYtPlaying(false)
    }
    // Re-run when the video id changes OR when yt-dlp resolution fails (so the
    // embed fallback loads only then, never flashing the restriction error first).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, ytdlpResolveFailed])

  // Final safety net: stop polling on full unmount (the per-video cleanup
  // above already handles id changes; this catches the component going away).
  useEffect(() => {
    return () => {
      if (stopPollRef.current) {
        stopPollRef.current()
        stopPollRef.current = null
      }
    }
  }, [])

  // Final safety net for the native <video>: pause + drop the src on full
  // unmount so resolved-stream audio never keeps playing in the background.
  useEffect(() => {
    return () => {
      const video = videoRef.current
      if (video) {
        video.pause()
        video.removeAttribute('src')
        video.load()
      }
    }
  }, [])

  // Final safety net for the Web Audio analyser graph: disconnect every cached
  // source + the analyser and close the AudioContext so we don't leak nodes.
  useEffect(() => {
    return () => {
      try {
        srcNodeRef.current.forEach((s) => { try { s.disconnect() } catch { /* noop */ } })
        srcNodeRef.current.clear()
        analyserRef.current?.disconnect()
        analyserRef.current = null
        void audioCtxRef.current?.close().catch(() => {})
        audioCtxRef.current = null
      } catch { /* never throw on teardown */ }
    }
  }, [])

  /* ---------------------------------------------------------------- */
  /* Audio-reactive visualizer — real FFT EQ + procedural fallback    */
  /* ------------------------------------------------------------------*/
  /* When a NATIVE media element is the active source (the yt-dlp        */
  /* resolved <video>, or the SomaFM <audio>) we tap it through the Web  */
  /* Audio API for a REAL frequency spectrum. The cross-origin YouTube   */
  /* IFrame/<webview> embed never exposes its decoded audio, so for that */
  /* path (and any time the tap fails) we degrade gracefully to a        */
  /* synthesized procedural animation gated on `anyPlaying`.             */
  /* ---------------------------------------------------------------- */

  /* Ensure `el` is routed source→analyser→destination through the shared
   * AudioContext, returning the analyser when live, or null to signal "fall back
   * to procedural". NEVER throws (all failure paths caught → null). NEVER breaks
   * playback: every tapped source is also connected straight to destination, and
   * we only ever create ONE source per element (cached), reconnecting the analyser
   * fan-in without recreating the source. */
  const ensureAnalyser = useCallback((el: HTMLMediaElement | null): AnalyserNode | null => {
    if (!el) return null
    try {
      // Lazily create the single AudioContext.
      let ctx = audioCtxRef.current
      if (!ctx) {
        const Ctor: typeof AudioContext =
          window.AudioContext || (window as any).webkitAudioContext
        if (!Ctor) return null
        ctx = new Ctor()
        audioCtxRef.current = ctx
      }
      // Resume if suspended (needs a gesture; this is called from play handlers
      // and the draw loop, both of which run post-gesture in practice).
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {})

      // Lazily create the shared analyser.
      let analyser = analyserRef.current
      if (!analyser) {
        analyser = ctx.createAnalyser()
        analyser.fftSize = 512            // → 256 frequency bins (smoother log spread)
        analyser.smoothingTimeConstant = 0.8
        analyser.minDecibels = -85
        analyser.maxDecibels = -20
        analyser.connect(ctx.destination) // analyser → speakers
        analyserRef.current = analyser
        freqDataRef.current = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
      }

      // Create the source for THIS element exactly once (throws if repeated).
      let src = srcNodeRef.current.get(el)
      if (!src) {
        src = ctx.createMediaElementSource(el)
        // Cache IMMEDIATELY — createMediaElementSource has already rerouted the
        // element off the default output, so even if the connect below throws we
        // must remember this source (a retry would throw "already has a source"
        // and leave the element permanently muted). Cleanup disconnects it later.
        srcNodeRef.current.set(el, src)
        // source → analyser (which is already → destination). Single hop, audio
        // still reaches the speakers.
        src.connect(analyser)
      } else if (tappedElRef.current !== el) {
        // Element already has a source but a DIFFERENT element was previously
        // routed; make sure this one is connected to the analyser.
        try { src.connect(analyser) } catch { /* already connected */ }
      }
      tappedElRef.current = el
      return analyser
    } catch (err) {
      // Tap failed (autoplay policy, CORS taint, double-source race, etc.) →
      // graceful degradation: forget the analyser path for this element.
      rlog.warn('music.viz.tap-failed', { error: String((err as Error)?.message || err) })
      return null
    }
  }, [])

  const drawLoop = useCallback((): void => {
    const canvas = canvasRef.current
    if (!canvas) {
      rafRef.current = null
      return
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      rafRef.current = null
      return
    }

    // --- DPR sizing (unchanged) ---
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const playing = anyPlayingRef.current

    // --- Responsive bar count: ~one bar per 10px, clamped 16..40 ---
    const NUM = Math.max(16, Math.min(40, Math.floor(w / 10)))
    if (barsRef.current.length !== NUM) barsRef.current = new Array(NUM).fill(0.02)
    if (peaksRef.current.length !== NUM) peaksRef.current = new Array(NUM).fill(0.02)
    const bars = barsRef.current
    const peaks = peaksRef.current

    // --- Try the real analyser; null → procedural this frame ---
    let analyser: AnalyserNode | null = null
    if (playing) analyser = ensureAnalyser(tappableElRef.current)
    let live = false

    if (analyser && freqDataRef.current) {
      // Re-alloc buffer if fftSize ever changed (defensive).
      if (freqDataRef.current.length !== analyser.frequencyBinCount) {
        freqDataRef.current = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
      }
      const bins = freqDataRef.current
      // Guard the read: if it ever throws (context closed mid-frame, etc.) fall
      // through to the procedural path instead of freezing the canvas loop.
      try {
        analyser.getByteFrequencyData(bins)
      } catch {
        analyser = null
      }
    }

    if (analyser && freqDataRef.current) {
      const bins = freqDataRef.current
      const binCount = bins.length
      let energy = 0
      // TRUE log-frequency axis: each bar covers an equal-RATIO slice of the
      // spectrum (≈equal octaves), so musical energy spreads across the whole
      // width instead of bunching in the leftmost few bars. minBin skips DC; the
      // top ~6% of bins (mostly empty) is dropped.
      const minBin = 1
      const maxBin = Math.max(minBin + 1, Math.floor(binCount * 0.94))
      const ratio = maxBin / minBin
      for (let i = 0; i < NUM; i++) {
        const lo = Math.floor(minBin * Math.pow(ratio, i / NUM))
        const hi = Math.max(lo + 1, Math.floor(minBin * Math.pow(ratio, (i + 1) / NUM)))
        // MAX within the bucket reads punchier than an average (and a wide
        // high-frequency bucket isn't washed out by its many quiet bins).
        let peak = 0
        for (let b = lo; b < hi && b < binCount; b++) if (bins[b] > peak) peak = bins[b]
        let mag = peak / 255 // 0..1
        // Perceptual lift (quiet bins become visible) + a rising high-frequency
        // tilt that compensates the natural spectral roll-off, so the right side
        // dances too instead of flat-lining.
        mag = Math.pow(mag, 0.65)
        const tilt = 0.6 + 1.3 * (i / Math.max(1, NUM - 1))
        mag = Math.min(1, mag * tilt)
        energy += mag
        // Smooth toward the measured magnitude (analyser already smooths, this
        // adds a touch more so bar motion reads as musical not jittery).
        bars[i] += (mag - bars[i]) * 0.5
      }
      live = energy > 0.001 // real signal present (not a silent/just-started el)
    }

    if (!live) {
      // --- PROCEDURAL FALLBACK (webview embed, or analyser not ready) ---
      for (let i = 0; i < NUM; i++) {
        const center = 1 - Math.abs(i - NUM / 2) / (NUM / 2)
        const target = playing ? 0.12 + Math.random() * (0.35 + center * 0.45) : 0.03
        bars[i] += (target - bars[i]) * (playing ? 0.35 : 0.12)
      }
    }
    analyserLiveRef.current = live

    // --- Render: rounded gradient bars + glow + falling peak caps ---
    const gap = Math.max(2, Math.min(5, w / NUM / 4))
    const barW = (w - gap * (NUM - 1)) / NUM
    const r = Math.min(barW / 2, 3)
    ctx.shadowColor = 'rgba(255,102,51,0.55)'
    ctx.shadowBlur = playing ? 8 : 0
    for (let i = 0; i < NUM; i++) {
      const v = Math.max(0.015, Math.min(1, bars[i]))
      const bh = Math.max(2, v * (h - 4))
      const x = i * (barW + gap)
      const y = h - bh

      const grad = ctx.createLinearGradient(0, y, 0, h)
      grad.addColorStop(0, '#ffd9a0')
      grad.addColorStop(0.45, '#ffb066')
      grad.addColorStop(0.78, ACCENT)
      grad.addColorStop(1, '#cc3d12')
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.moveTo(x, h)
      ctx.lineTo(x, y + r)
      ctx.quadraticCurveTo(x, y, x + r, y)
      ctx.lineTo(x + barW - r, y)
      ctx.quadraticCurveTo(x + barW, y, x + barW, y + r)
      ctx.lineTo(x + barW, h)
      ctx.closePath()
      ctx.fill()

      // Peak-decay cap: rises instantly, falls slowly.
      if (v >= peaks[i]) peaks[i] = v
      else peaks[i] = Math.max(v, peaks[i] - 0.018)
      const py = h - Math.max(2, peaks[i] * (h - 4))
      ctx.shadowBlur = 0
      ctx.fillStyle = 'rgba(255,222,200,0.9)'
      ctx.fillRect(x, Math.max(0, py - 2), barW, 2)
      ctx.shadowBlur = playing ? 8 : 0
    }
    ctx.shadowBlur = 0

    // --- Idle state: when fully settled and nothing playing, stop the loop
    // rather than spinning rAF forever on a static frame. ---
    const settled = !playing && bars.every((b) => b <= 0.04) && peaks.every((p) => p <= 0.04)
    if (playing || !settled) {
      rafRef.current = requestAnimationFrame(drawLoop)
    } else {
      rafRef.current = null
    }
  }, [ensureAnalyser])

  /* kick the loop on mount + when playback starts */
  useEffect(() => {
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(drawLoop)
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [drawLoop])

  useEffect(() => {
    if (anyPlaying && rafRef.current == null) {
      rafRef.current = requestAnimationFrame(drawLoop)
    }
  }, [anyPlaying, drawLoop])

  /* ---------------------------------------------------------------- */
  /* Persistence — mirror WebPreview (useCanvas.getState().updateNode) */
  /* ---------------------------------------------------------------- */

  const persist = useCallback(
    (patch: Partial<CanvasNode>): void => {
      useCanvas.getState().updateNode(node.id, patch)
    },
    [node.id]
  )

  /* ---------------------------------------------------------------- */
  /* YouTube controls                                                 */
  /* ---------------------------------------------------------------- */

  // Load a specific video id into the (single, always-mounted) webview. Used by
  // direct play, queue jump and auto-advance. Does NOT touch the queue array.
  const playVideoId = useCallback(
    (id: string, url: string, title?: string): void => {
      setThumbBroken(false)
      setYtError(null)
      setVideoTitle(title || '')
      setCurrentTime(0)
      setDuration(0)
      setVideoId(id)
      setYtWebviewUrl(initializeYouTubeWebviewUrl(id))
      persist({ url, musicMode: 'youtube', musicTitle: title || undefined })
    },
    [persist]
  )

  // Paste-a-link handler. Always appends to the ordered queue (persisted). If
  // nothing is currently playing, the freshly-added item also starts playing now
  // and becomes the current index; otherwise it just waits its turn in the queue.
  const loadFromInput = useCallback((): void => {
    const id = parseYouTubeUrl(inputValue)
    if (!id) {
      rlog.warn('music.yt.parse.fail', { input: inputValue.slice(0, 80) })
      return
    }
    const url = youTubeWatchUrl(id)
    const newItem: QueueItem = { videoId: id, url, title: undefined }
    const updated = [...queueItems, newItem]
    const nothingPlaying = !videoId
    const newIndex = nothingPlaying ? updated.length - 1 : queueIndex

    setQueueItems(updated)
    setInputValue('')

    if (nothingPlaying) {
      logAction('music.yt.load', { videoId: id })
      setQueueIndex(newIndex)
      playVideoId(id, url)
      persist({ musicQueue: updated, musicQueueIndex: newIndex })
    } else {
      logAction('music.queue.add', { videoId: id })
      persist({ musicQueue: updated })
    }
  }, [inputValue, queueItems, queueIndex, videoId, playVideoId, persist])

  const toggleYouTube = useCallback((): void => {
    if (!videoId) return
    // Nudge the analyser's AudioContext alive on this user gesture.
    if (audioCtxRef.current?.state === 'suspended') void audioCtxRef.current.resume().catch(() => {})

    // Native <video> path (yt-dlp resolved): drive the real element; the
    // play/pause listeners reconcile ytPlaying.
    if (resolvedStream && videoRef.current) {
      const video = videoRef.current
      if (video.paused) {
        logAction('music.play', { videoId })
        video.play().catch(() => {})
      } else {
        logAction('music.pause')
        video.pause()
      }
      return
    }

    // Fallback webview path. Optimistic UI; the poll reconciles shortly.
    if (ytPlaying) {
      logAction('music.pause')
      setYtPlaying(false)
      void executeYouTubeWebviewCommand(ytWebviewRef, 'pause')
    } else {
      logAction('music.play', { videoId })
      setYtPlaying(true)
      void executeYouTubeWebviewCommand(ytWebviewRef, 'play')
    }
  }, [ytPlaying, videoId, resolvedStream])

  const seekTo = useCallback(
    (t: number): void => {
      if (resolvedStream && videoRef.current) {
        videoRef.current.currentTime = t
        return
      }
      void executeYouTubeWebviewCommand(ytWebviewRef, 'seekTo', t)
    },
    [resolvedStream]
  )

  const clearVideo = useCallback((): void => {
    void executeYouTubeWebviewCommand(ytWebviewRef, 'pause')
    if (videoRef.current) videoRef.current.pause()
    setVideoId(null)
    setYtWebviewUrl(null)
    setResolvedStream(null)
    setYtdlpResolveFailed(false)
    setYtError(null)
    setVideoTitle('')
    setCurrentTime(0)
    setDuration(0)
    setYtPlaying(false)
    setQueueItems([])
    setQueueIndex(0)
    setShowQueuePanel(false)
    persist({ url: undefined, musicTitle: undefined, musicQueue: undefined, musicQueueIndex: undefined })
  }, [persist])

  /* ---- queue management ---- */

  // Jump playback to a specific queue position and make it the current index.
  const jumpToQueueItem = useCallback(
    (idx: number): void => {
      if (idx < 0 || idx >= queueItems.length) return
      const item = queueItems[idx]
      setQueueIndex(idx)
      playVideoId(item.videoId, item.url, item.title)
      persist({ musicQueueIndex: idx })
      logAction('music.queue.jump', { videoId: item.videoId, index: idx })
    },
    [queueItems, playVideoId, persist]
  )

  // Remove a queue item, keeping the current index pointing at the same song
  // when possible (shift it down if an earlier item was removed) and clamping it
  // into the new bounds.
  const removeFromQueue = useCallback(
    (idx: number): void => {
      if (idx < 0 || idx >= queueItems.length) return
      const updated = queueItems.filter((_, i) => i !== idx)
      let newIndex = queueIndex
      if (idx < queueIndex) newIndex = queueIndex - 1
      newIndex = Math.max(0, Math.min(newIndex, Math.max(0, updated.length - 1)))
      setQueueItems(updated)
      setQueueIndex(newIndex)
      persist({
        musicQueue: updated.length > 0 ? updated : undefined,
        musicQueueIndex: updated.length > 0 ? newIndex : undefined
      })
      logAction('music.queue.remove', { index: idx })
    },
    [queueItems, queueIndex, persist]
  )

  const nextInQueue = useCallback((): void => {
    if (queueIndex + 1 < queueItems.length) jumpToQueueItem(queueIndex + 1)
  }, [queueIndex, queueItems.length, jumpToQueueItem])

  const prevInQueue = useCallback((): void => {
    if (queueIndex > 0) jumpToQueueItem(queueIndex - 1)
  }, [queueIndex, jumpToQueueItem])

  /* ---------------------------------------------------------------- */
  /* SomaFM controls (secondary tab)                                  */
  /* ---------------------------------------------------------------- */

  const playStation = useCallback(async (i: number): Promise<void> => {
    const audio = audioRef.current
    if (!audio) return
    // Nudge the analyser's AudioContext alive on this user gesture.
    if (audioCtxRef.current?.state === 'suspended') void audioCtxRef.current.resume().catch(() => {})
    const url = STATIONS[i].url
    if (audio.src !== url) audio.src = url
    try {
      logAction('music.play', { station: i })
      await audio.play()
      setStationPlaying(true)
    } catch (err) {
      rlog.warn('music.play.error', { station: i, message: String((err as Error)?.message || err) })
      setStationPlaying(false)
    }
  }, [])

  const pauseStation = useCallback((): void => {
    audioRef.current?.pause()
    logAction('music.pause')
    setStationPlaying(false)
  }, [])

  const toggleStation = useCallback((): void => {
    if (stationPlaying) pauseStation()
    else void playStation(stationIdx)
  }, [stationPlaying, stationIdx, playStation, pauseStation])

  const pickStation = useCallback(
    (i: number): void => {
      setStationIdx(i)
      persist({ musicMode: 'somafm' })
      void playStation(i)
    },
    [playStation, persist]
  )

  /* ---------------------------------------------------------------- */
  /* Global voice / store music requests                              */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!musicRequest) return
    if (musicRequest.token === lastReqToken.current) return
    lastReqToken.current = musicRequest.token
    const action = musicRequest.action
    const useYt = tab === 'youtube' && !!videoId

    if (action === 'pause') {
      if (useYt) {
        if (resolvedStream && videoRef.current) {
          videoRef.current.pause()
        } else {
          setYtPlaying(false)
          void executeYouTubeWebviewCommand(ytWebviewRef, 'pause')
        }
      } else pauseStation()
    } else if (action === 'play') {
      if (useYt) {
        if (resolvedStream && videoRef.current) {
          videoRef.current.play().catch(() => {})
        } else {
          setYtPlaying(true)
          void executeYouTubeWebviewCommand(ytWebviewRef, 'play')
        }
      } else void playStation(stationIdx)
    } else if (action === 'toggle') {
      if (useYt) toggleYouTube()
      else toggleStation()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [musicRequest])

  /* ---------------------------------------------------------------- */
  /* Tab switching persists musicMode                                 */
  /* ---------------------------------------------------------------- */

  const switchTab = useCallback(
    (next: Tab): void => {
      setTab(next)
      if (next === 'youtube') persist({ musicMode: 'youtube' })
      else if (next === 'stations') persist({ musicMode: 'somafm' })
    },
    [persist]
  )

  /* ================================================================ */
  /* Render                                                           */
  /* ================================================================ */

  const onYouTubeTab = tab === 'youtube'
  const isPlayingForUi = onYouTubeTab ? ytPlaying : stationPlaying
  const station = STATIONS[stationIdx]

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        inset: 0,
        // Sit above the bottom-layer NodeFrost canvas (zIndex:0) so the blurred
        // wallpaper reads THROUGH this now-translucent glass tint.
        zIndex: 1,
        display: 'flex',
        flexDirection: 'column',
        padding: tiny ? '8px 10px' : 'clamp(8px, 2%, 14px) clamp(10px, 3%, 16px)',
        gap: tiny ? 6 : 'clamp(6px, 1.5%, 12px)',
        minHeight: 0,
        overflow: 'hidden',
        // IDENTICAL terminal liquid glass: a single neutral translucent tint
        // (--glass-term-tint @ --glass-term-alpha = rgba(8,13,26,0.48)) layered
        // over the in-body NodeFrost (zIndex:0) so the frosted wallpaper bleeds
        // through while text stays legible (dark wallpaper + this tint keep
        // ~4.5:1). Dropped the old opaque blue gradient + orange radial wash that
        // read as a non-glass surface and hid the frost. A faint top specular
        // sheen (same shape as the terminal header) keeps the soft glass edge.
        // Media (<video>/<webview>) + the EQ <canvas> stay opaque on their own.
        background:
          'linear-gradient(180deg, rgba(var(--glass-spec), 0.05) 0%, rgba(var(--glass-spec), 0) 42%), rgba(var(--glass-term-tint), var(--glass-term-alpha))'
      }}
    >
      {/* ---- tabs header ---- */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', minWidth: 0 }}>
          <button onClick={() => switchTab('youtube')} style={tabBtn(tab === 'youtube')}>
            YouTube
          </button>
          <button onClick={() => switchTab('stations')} style={tabBtn(tab === 'stations')}>
            {tr('files.music_stations')}
          </button>
        </div>
        <span
          style={{
            marginLeft: 'auto',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: isPlayingForUi ? '#48d597' : 'rgba(139,160,200,0.4)',
            boxShadow: isPlayingForUi ? '0 0 8px rgba(72,213,151,0.8)' : 'none',
            transition: 'all 0.2s'
          }}
          title={isPlayingForUi ? tr('files.playing') : tr('files.stopped')}
        />
      </div>

      {/* ============================== YOUTUBE TAB ============================== */}
      {onYouTubeTab && (
        <>
          {/* paste-a-link input — añade a la cola (y reproduce si nada suena).
              Hidden in `tiny` mode to keep the transport controls on-screen. */}
          {!tiny && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', minWidth: 0 }}>
              <input
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') loadFromInput()
                }}
                placeholder={tr('files.paste_youtube_link')}
                aria-label={tr('files.youtube_link')}
                style={{ ...ytInput, flexBasis: '120px' }}
              />
              <button
                onClick={loadFromInput}
                style={loadBtn}
                title={videoId ? tr('files.add_to_queue') : tr('files.play_video')}
                aria-label={videoId ? tr('files.add_to_queue') : tr('files.play_video')}
              >
                {videoId ? tr('files.add_queue_short') : tr('files.play')}
              </button>
            </div>
          )}

          {/* now-playing card: thumbnail + title/subtitle. Hidden in `tiny` mode. */}
          {!tiny && (
          <div style={nowPlayingCard}>
            <div style={thumbWrap}>
              {videoId && !thumbBroken ? (
                <img
                  src={youTubeThumbnail(videoId)}
                  alt=""
                  onError={() => setThumbBroken(true)}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              ) : (
                <div style={{ display: 'grid', placeItems: 'center', width: '100%', height: '100%', fontSize: 22 }}>
                  🎵
                </div>
              )}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={titleTextClamp} title={videoTitle || undefined}>
                {videoTitle || (videoId ? tr('files.loading') : tr('files.no_video'))}
              </div>
              <div style={subtitleText}>
                {videoId
                  ? ytPlaying
                    ? tr('files.youtube_now_playing')
                    : tr('files.youtube_paused')
                  : tr('files.paste_link_to_start')}
              </div>
            </div>
            {videoId && (
              <button onClick={clearVideo} style={clearBtn} title={tr('files.remove_video')} aria-label={tr('files.remove_video')}>
                ✕
              </button>
            )}
          </div>
          )}

          {/* ---- Horizontal row: [video square] [waves visualizer] ----
              The visible YouTube embed host (Electron <webview>) sits on the
              LEFT at a tasteful fixed square so the user actually SEES the video
              play, with the procedural waves stretching to the RIGHT.

              The webview stays ALWAYS mounted while a video is loaded and we swap
              the source in place with loadURL() — it is never detached/
              re-attached, avoiding the React #185 trap.

              NO backdrop-filter anywhere near the square so the frame stays as
              crisp as Chromium allows. (Residual softness at zoom != 100% is a
              Chromium GPU limitation: any layer inside the CSS-transform-scaled
              .canvas-world is bilinearly resampled. Full crispness would require
              hoisting to a screen-space overlay, which we deliberately avoid.)

              The webview always renders so we never tear it down; when a video is
              genuinely non-embeddable (error 150/101) we overlay an "Abrir en
              YouTube" fallback on top of it instead of detaching it. */}
          {(resolvedStream || ytWebviewUrl) && (
            <div
              style={
                compact
                  ? // COMPACT: collapse the video+EQ to 0 height but keep it MOUNTED
                    // (audio keeps playing; no unmount → no React #185) so the
                    // transport controls always fit a very small node.
                    { flex: '0 0 0px', height: 0, minHeight: 0, overflow: 'hidden' }
                  : {
                      display: 'flex',
                      gap: 'clamp(8px, 1.5%, 12px)',
                      flex: '1 1 0%', // the ONLY growing child of the column
                      minHeight: 0, // shrinks fully under pressure so controls never clip
                      overflow: 'hidden',
                      flexWrap: 'nowrap', // never wrap the square onto its own row (it stole vertical space → overlap)
                      alignItems: 'stretch' // both children fill the row height
                    }
              }
            >
              {/* Video square (left side; height-bounded so it can never push the controls) */}
              <div style={videoSquareWrap}>
                {/* PRIMARY: native <video> playing the yt-dlp-resolved stream
                    (real video + audio, no embed restriction). FALLBACK: the
                    canvasio-yt webview embed when resolution failed. Both stay
                    DOM-stable (we only swap src / attach listeners), so neither
                    unmount/remount-trips React #185. */}
                {resolvedStream ? (
                  <video
                    ref={videoRef}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      width: '100%',
                      height: '100%',
                      // `cover` fills the square frame edge-to-edge (no black
                      // letterbox bars); a wide 16:9 stream is cropped L/R rather
                      // than pillar/letterboxed.
                      objectFit: 'cover',
                      backgroundColor: '#0a0c14',
                      border: 'none'
                    }}
                    playsInline
                    controls={false}
                  />
                ) : (
                  <Webview
                    ref={ytWebviewRef}
                    src={ytWebviewUrl || ''}
                    partition={`persist:music-${node.id}`}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      width: '100%',
                      height: '100%',
                      opacity: ytError ? 0 : 1,
                      pointerEvents: ytError ? 'none' : 'auto',
                      border: 'none'
                    }}
                  />
                )}
                {/* "Abrir en YouTube" only when resolution failed AND the embed
                    itself reports it can't be inserted (error 150/101). */}
                {!resolvedStream && ytdlpResolveFailed && ytError && (
                  <div style={ytErrorOverlay}>
                    <div style={{ marginBottom: 8 }}>{tr('files.cannot_embed_video')}</div>
                    {videoId && (
                      <a
                        href={youTubeWatchUrl(videoId)}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={ytErrorLink}
                      >
                        {tr('files.open_in_youtube')}
                      </a>
                    )}
                  </div>
                )}
              </div>

              {/* Waves visualizer (grows beside the square; yields width to it first) */}
              <div style={{ ...vizBox, flex: '1 1 0%', minWidth: 0 }}>
                <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
              </div>
            </div>
          )}

          {/* When no video is loaded yet, still show the waves on their own row.
              Dropped in compact mode so the controls fit. */}
          {!resolvedStream && !ytWebviewUrl && !compact && (
            <div style={vizBox}>
              <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
            </div>
          )}

          {/* mini controller: play/pause + scrubber + time */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 'clamp(8px, 1.5%, 12px)', minWidth: 0, flex: '0 0 auto' }}>
            <button
              onClick={toggleYouTube}
              disabled={!videoId}
              style={{ ...playBtn, opacity: videoId ? 1 : 0.4, cursor: videoId ? 'pointer' : 'default' }}
              title={ytPlaying ? tr('files.pause') : tr('files.play')}
              aria-label={ytPlaying ? tr('files.pause') : tr('files.play')}
              aria-pressed={ytPlaying}
            >
              {ytPlaying ? '❚❚' : '▶'}
            </button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <input
                type="range"
                min={0}
                max={duration || 0}
                step={0.1}
                value={Math.min(currentTime, duration || 0)}
                disabled={!videoId || !duration}
                onPointerDown={() => setScrubbing(true)}
                onChange={(e) => setCurrentTime(parseFloat(e.target.value))}
                onPointerUp={(e) => {
                  const t = parseFloat((e.target as HTMLInputElement).value)
                  seekTo(t)
                  setScrubbing(false)
                }}
                // Keyboard (arrows/Home/End/PageUp-Down) + touch also commit the
                // seek, not only mouse release (audit #14).
                onKeyUp={(e) => {
                  seekTo(parseFloat((e.target as HTMLInputElement).value))
                  setScrubbing(false)
                }}
                aria-label={tr('files.playback_progress')}
                style={{ width: '100%', accentColor: ACCENT }}
              />
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 11,
                  color: 'var(--canvasio-subtext)',
                  marginTop: 2,
                  gap: 4,
                  minWidth: 0
                }}
              >
                <span style={{ flex: '0 0 auto', whiteSpace: 'nowrap' }}>{fmtTime(currentTime)}</span>
                <span style={{ flex: '0 0 auto', whiteSpace: 'nowrap' }}>{fmtTime(duration)}</span>
              </div>
            </div>
          </div>

          {/* queue header: toggle panel + prev/next */}
          {queueItems.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0, flex: '0 0 auto' }}>
              <button
                onClick={() => setShowQueuePanel((v) => !v)}
                style={queueToggleBtn(showQueuePanel)}
                title={tr('files.toggle_queue')}
                aria-pressed={showQueuePanel}
              >
                {tr('files.queue_count', { count: queueItems.length })}
              </button>
              <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                <button
                  onClick={prevInQueue}
                  disabled={queueIndex <= 0}
                  style={{ ...queueNavBtn, opacity: queueIndex <= 0 ? 0.4 : 1 }}
                  title={tr('files.previous')}
                  aria-label={tr('files.previous')}
                >
                  ◀
                </button>
                <button
                  onClick={nextInQueue}
                  disabled={queueIndex >= queueItems.length - 1}
                  style={{ ...queueNavBtn, opacity: queueIndex >= queueItems.length - 1 ? 0.4 : 1 }}
                  title={tr('files.next')}
                  aria-label={tr('files.next')}
                >
                  ▶
                </button>
              </div>
            </div>
          )}

          {/* queue list (collapsible): current highlighted, click-to-jump, remove.
              Suppressed in compact mode so it can't push the controls off-screen. */}
          {showQueuePanel && queueItems.length > 0 && !compact && (
            <div style={queueListBox} data-canvas-scroll="true">
              {queueItems.map((item, idx) => (
                <div
                  key={`${item.videoId}-${idx}`}
                  onClick={() => jumpToQueueItem(idx)}
                  style={queueRow(idx === queueIndex)}
                  title={item.title || item.videoId}
                >
                  <span style={queueRowText}>
                    {idx + 1}. {item.title || tr('files.video_n', { n: idx + 1 })}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      removeFromQueue(idx)
                    }}
                    style={queueRemoveBtn}
                    title={tr('files.remove_from_queue')}
                    aria-label={tr('files.remove_from_queue')}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ============================== STATIONS (SomaFM) ============================== */}
      {tab === 'stations' && (
        <>
          <div style={nowPlayingCard}>
            <button
              onClick={toggleStation}
              style={playBtn}
              title={stationPlaying ? tr('files.pause') : tr('files.play')}
              aria-label={stationPlaying ? tr('files.pause_radio') : tr('files.play_radio')}
              aria-pressed={stationPlaying}
            >
              {stationPlaying ? '❚❚' : '▶'}
            </button>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={titleText}>{station.label}</div>
              <div style={subtitleText}>
                SomaFM · {stationPlaying ? tr('files.live') : tr('files.live_radio')}
              </div>
            </div>
          </div>

          {!compact && (
            <div style={vizBox}>
              <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
            </div>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, minWidth: 0 }}>
            {STATIONS.map((s, i) => (
              <button
                key={s.tag}
                onClick={() => pickStation(i)}
                style={chip(i === stationIdx)}
                aria-pressed={i === stationIdx}
                title={tr('files.tune_station', { station: s.label })}
              >
                {s.label}
              </button>
            ))}
          </div>
        </>
      )}

      {/* ---- master volume (shared) ---- */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 'auto', minWidth: 0, flex: '0 0 auto' }}>
        <button
          onClick={() => setAppVolume(appVolume <= 0 ? 0.7 : 0)}
          style={muteBtn}
          title={appVolume <= 0 ? tr('files.unmute') : tr('files.mute')}
          aria-label={appVolume <= 0 ? tr('files.unmute') : tr('files.mute')}
          aria-pressed={appVolume <= 0}
        >
          {appVolume <= 0 ? '🔇' : '🔈'}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={appVolume}
          onChange={(e) => setAppVolume(parseFloat(e.target.value))}
          aria-label={tr('files.master_volume')}
          style={{ flex: 1, minWidth: 0, accentColor: ACCENT }}
        />
        <span style={{ color: 'var(--canvasio-subtext)', fontSize: 11, width: 26, textAlign: 'right', flex: '0 0 auto', whiteSpace: 'nowrap' }}>
          {Math.round(appVolume * 100)}
        </span>
      </div>
    </div>
  )
}

/* ================================================================== */
/* Styles                                                              */
/* ================================================================== */

function tabBtn(active: boolean): React.CSSProperties {
  return {
    border: '1px solid ' + (active ? 'rgba(255,102,51,0.55)' : 'rgba(120,150,220,0.16)'),
    background: active ? 'rgba(255,102,51,0.16)' : 'rgba(255,255,255,0.03)',
    color: active ? '#ffd0b8' : '#9fb0d2',
    borderRadius: 9,
    padding: '5px 11px',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 0.15s'
  }
}

const ytInput: React.CSSProperties = {
  flex: '1 1 120px',
  minWidth: 0,
  border: '1px solid rgba(120,150,220,0.18)',
  background: 'rgba(8,12,26,0.6)',
  color: '#e7eeff',
  borderRadius: 10,
  padding: 'clamp(6px, 1%, 8px) clamp(9px, 1.5%, 11px)',
  fontSize: 12.5,
  fontFamily: 'inherit',
  outline: 'none'
}

const loadBtn: React.CSSProperties = {
  flex: '0 0 auto',
  border: '1px solid rgba(255,102,51,0.45)',
  background: 'linear-gradient(180deg, rgba(255,102,51,0.28), rgba(255,102,51,0.12))',
  color: '#ffe6da',
  borderRadius: 10,
  padding: '8px 13px',
  fontSize: 12.5,
  fontWeight: 700,
  cursor: 'pointer',
  fontFamily: 'inherit'
}

const nowPlayingCard: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 12px',
  borderRadius: 14,
  // IDENTICAL terminal glass tint (neutral, not blue) so the in-body NodeFrost
  // (blurred wallpaper) reads through the card as one liquid-glass surface. NO
  // backdrop-filter (would blur text under canvas scale). Faint near-invisible
  // edge so there's no hard specular "recuadro" line.
  background: 'rgba(var(--glass-term-tint), var(--glass-term-alpha))',
  border: '1px solid rgba(150,175,235,0.05)'
}

const thumbWrap: React.CSSProperties = {
  flex: '0 0 auto',
  width: 54,
  height: 54,
  borderRadius: 12,
  overflow: 'hidden',
  background: 'rgba(255,102,51,0.12)',
  border: '1px solid rgba(255,102,51,0.25)'
}

// Visible video square that hosts the live <webview>/<video>. Bounded square on
// the LEFT of the media row, so it never gets stretched/dragged and stays crisp
// (no backdrop-filter, no transform scaling of its own).
const videoSquareWrap: React.CSSProperties = {
  flex: '0 0 auto',
  // Bounded square: its HEIGHT is the row height (alignItems:stretch), and
  // aspectRatio derives the width from that height — so it can NEVER be taller
  // than the media row (the old width-driven aspectRatio could overflow short
  // rows and shove the controls). Width is still capped for wide/tall nodes.
  height: '100%',
  aspectRatio: '1 / 1',
  width: 'auto',
  maxWidth: 'min(60%, 220px)',
  minWidth: 84,
  maxHeight: '100%',
  alignSelf: 'stretch',
  borderRadius: 12,
  overflow: 'hidden',
  border: '1px solid rgba(255,102,51,0.35)',
  background: '#0a0c14',
  position: 'relative',
  boxShadow: '0 6px 22px rgba(0,0,0,0.35)'
}

// "Abrir en YouTube" fallback shown over the video square when a video genuinely
// cannot be embedded (real YouTube error 150/101). Opaque (no backdrop-filter)
// to stay crisp inside the scaled canvas world.
const ytErrorOverlay: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
  padding: 12,
  background: '#0a0c14',
  color: '#9fb0d2',
  fontSize: 11,
  lineHeight: 1.4
}

const ytErrorLink: React.CSSProperties = {
  padding: '7px 12px',
  background: 'linear-gradient(180deg, rgba(255,102,51,0.32), rgba(255,102,51,0.14))',
  border: '1px solid rgba(255,130,80,0.45)',
  borderRadius: 8,
  color: '#ffe6da',
  textDecoration: 'none',
  fontSize: 12,
  fontWeight: 700
}

function queueToggleBtn(active: boolean): React.CSSProperties {
  return {
    flex: '0 0 auto',
    padding: '6px 11px',
    borderRadius: 8,
    border: '1px solid ' + (active ? 'rgba(255,102,51,0.45)' : 'rgba(120,150,220,0.16)'),
    background: active ? 'rgba(255,102,51,0.16)' : 'rgba(255,255,255,0.03)',
    color: active ? '#ffd9c8' : '#9fb0d2',
    fontSize: 11,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 0.15s'
  }
}

const queueNavBtn: React.CSSProperties = {
  flex: '0 0 auto',
  width: 28,
  height: 28,
  borderRadius: 6,
  border: '1px solid rgba(120,150,220,0.16)',
  background: 'rgba(255,255,255,0.04)',
  color: '#aebbd6',
  fontSize: 10,
  cursor: 'pointer',
  display: 'grid',
  placeItems: 'center'
}

const queueListBox: React.CSSProperties = {
  flex: '0 0 auto',
  maxHeight: 150,
  overflow: 'auto',
  borderRadius: 10,
  border: '1px solid rgba(150,175,235,0.05)',
  // IDENTICAL terminal glass tint so the in-body NodeFrost reads through as one
  // liquid-glass surface (neutral, not blue; soft near-invisible edge).
  background: 'rgba(var(--glass-term-tint), var(--glass-term-alpha))',
  padding: '6px 0'
}

function queueRow(active: boolean): React.CSSProperties {
  return {
    padding: '7px 12px',
    cursor: 'pointer',
    background: active ? 'rgba(255,102,51,0.2)' : 'transparent',
    borderLeft: '3px solid ' + (active ? ACCENT : 'transparent'),
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    color: active ? '#ffd9c8' : '#9fb0d2',
    fontSize: 12,
    overflow: 'hidden'
  }
}

const queueRowText: React.CSSProperties = {
  minWidth: 0,
  flex: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

const queueRemoveBtn: React.CSSProperties = {
  flex: '0 0 auto',
  width: 20,
  height: 20,
  borderRadius: 4,
  border: '1px solid rgba(120,150,220,0.16)',
  background: 'rgba(255,255,255,0.04)',
  color: '#aebbd6',
  fontSize: 10,
  cursor: 'pointer',
  display: 'grid',
  placeItems: 'center'
}

const titleText: React.CSSProperties = {
  fontWeight: 700,
  fontSize: 15,
  color: '#f1f5ff',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis'
}

// Title variant for the YouTube now-playing card: wraps to at most two lines and
// then ellipsises, so long titles never overflow horizontally and never push the
// clear (✕) button off the card at narrow widths.
const titleTextClamp: React.CSSProperties = {
  fontWeight: 700,
  fontSize: 15,
  color: '#f1f5ff',
  lineHeight: 1.2,
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  wordBreak: 'break-word'
}

const subtitleText: React.CSSProperties = {
  color: 'var(--canvasio-subtext)',
  fontSize: 12,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis'
}

const clearBtn: React.CSSProperties = {
  flex: '0 0 auto',
  width: 26,
  height: 26,
  borderRadius: 8,
  border: '1px solid rgba(120,150,220,0.16)',
  background: 'rgba(255,255,255,0.04)',
  color: '#aebbd6',
  fontSize: 12,
  cursor: 'pointer',
  display: 'grid',
  placeItems: 'center'
}

const vizBox: React.CSSProperties = {
  position: 'relative',
  flex: 1,
  minWidth: 0,
  minHeight: 56,
  borderRadius: 14,
  overflow: 'hidden',
  border: '1px solid rgba(255,102,51,0.16)',
  background: 'linear-gradient(180deg, rgba(20,12,8,0.7), rgba(8,10,18,0.55))'
}

const playBtn: React.CSSProperties = {
  width: 50,
  height: 50,
  flex: '0 0 auto',
  borderRadius: '50%',
  border: '1px solid rgba(255,130,80,0.45)',
  background: 'linear-gradient(180deg, rgba(255,102,51,0.32), rgba(255,102,51,0.14))',
  color: '#fff',
  fontSize: 16,
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
  boxShadow: '0 4px 18px rgba(255,102,51,0.28)'
}

const muteBtn: React.CSSProperties = {
  width: 30,
  height: 30,
  flex: '0 0 auto',
  borderRadius: 8,
  border: '1px solid rgba(120,150,220,0.16)',
  background: 'rgba(255,255,255,0.04)',
  color: '#aebbd6',
  fontSize: 13,
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer'
}

function chip(active: boolean): React.CSSProperties {
  return {
    border: '1px solid ' + (active ? 'rgba(255,130,80,0.6)' : 'rgba(120,150,220,0.18)'),
    background: active ? 'rgba(255,102,51,0.18)' : 'rgba(255,255,255,0.03)',
    color: active ? '#ffd9c8' : '#9fb0d2',
    borderRadius: 8,
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
    transition: 'all 0.15s'
  }
}
