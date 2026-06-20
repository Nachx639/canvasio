/**
 * Warm microphone + rolling pre-roll buffer.
 *
 * WHY: push-to-talk used to call getUserMedia on keydown, then start a
 * MediaRecorder only after that resolved (~150–300 ms, worse on the first,
 * cold acquisition). By then the speaker has already begun, so the opening
 * syllables are lost before recording actually starts.
 *
 * FIX: keep ONE getUserMedia stream open and continuously feed it through a
 * WebAudio node into a small ring buffer (~400 ms of raw Float32 PCM). When
 * recording starts we hand the MediaRecorder the already-hot stream (no async
 * wait), and when it stops we PREPEND the last ~300 ms of ring-buffer audio to
 * the captured clip. The result: the user hears their own first syllable and
 * whisper sees it too.
 *
 * This module owns NOTHING React. It is a plain singleton so the warm stream is
 * shared no matter how many components mount. All capture happens in refs/closures
 * here, so it never causes a React render (no #185 risk).
 */

// ~400 ms of head-room so a 300 ms pre-roll always has data even right after warm-up.
const RING_MS = 400
// Capture in small frames; 1024 samples ≈ 23 ms at 44.1 kHz.
const FRAME = 1024

type WarmState = {
  stream: MediaStream
  ctx: AudioContext
  source: MediaStreamAudioSourceNode
  proc: ScriptProcessorNode
  sink: GainNode
  ring: Float32Array
  ringLen: number
  // total samples ever written (monotonic) — lets takePreRoll grab the tail.
  written: number
  rate: number
}

let state: WarmState | null = null
let warming: Promise<boolean> | null = null

/**
 * Ensure the warm stream + ring buffer are running. Idempotent and safe to call
 * repeatedly (e.g. on every component mount). Resolves true once audio is
 * flowing, false if the mic could not be opened (caller then falls back to the
 * old per-record getUserMedia path).
 */
export function ensureWarm(): Promise<boolean> {
  if (state) return Promise.resolve(true)
  if (warming) return warming
  warming = (async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const AudioCtx: typeof AudioContext =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new AudioCtx()
      // Some browsers start the context suspended until a user gesture; PTT is a
      // gesture, but resume() here is harmless and keeps capture flowing.
      ctx.resume().catch(() => {})
      const rate = ctx.sampleRate
      const ringLen = Math.max(FRAME * 2, Math.ceil((RING_MS / 1000) * rate))
      const ring = new Float32Array(ringLen)
      const source = ctx.createMediaStreamSource(stream)
      const proc = ctx.createScriptProcessor(FRAME, 1, 1)
      // A muted sink keeps the ScriptProcessor pulling without echoing the mic to
      // the speakers (gain 0 = silent monitor).
      const sink = ctx.createGain()
      sink.gain.value = 0

      const st: WarmState = {
        stream,
        ctx,
        source,
        proc,
        sink,
        ring,
        ringLen,
        written: 0,
        rate
      }

      proc.onaudioprocess = (e: AudioProcessingEvent): void => {
        const input = e.inputBuffer.getChannelData(0)
        const n = input.length
        let pos = st.written % st.ringLen
        for (let i = 0; i < n; i++) {
          st.ring[pos] = input[i]
          pos++
          if (pos >= st.ringLen) pos = 0
        }
        st.written += n
      }

      source.connect(proc)
      proc.connect(sink)
      sink.connect(ctx.destination)
      state = st
      return true
    } catch {
      state = null
      return false
    } finally {
      warming = null
    }
  })()
  return warming
}

/** The live warm stream, or null if not warmed yet. */
export function getWarmStream(): MediaStream | null {
  return state?.stream ?? null
}

/** Sample rate of the warm capture context (needed to resample the pre-roll). */
export function warmRate(): number {
  return state?.rate ?? 0
}

/**
 * Snapshot the most recent `ms` of captured audio from the ring buffer as a
 * fresh Float32Array (at warmRate()). Returns an empty array if not warmed or
 * not enough audio has been captured yet. The copy is independent of the ring,
 * so ongoing capture never mutates it.
 */
export function takePreRoll(ms: number): Float32Array {
  const st = state
  if (!st || ms <= 0) return new Float32Array(0)
  const want = Math.min(
    st.ringLen,
    st.written,
    Math.ceil((ms / 1000) * st.rate)
  )
  if (want <= 0) return new Float32Array(0)
  const out = new Float32Array(want)
  // The oldest sample of the window sits `want` behind the write head.
  let pos = (st.written - want) % st.ringLen
  if (pos < 0) pos += st.ringLen
  for (let i = 0; i < want; i++) {
    out[i] = st.ring[pos]
    pos++
    if (pos >= st.ringLen) pos = 0
  }
  return out
}

/**
 * Fully release the warm stream + audio graph. Call only on real teardown
 * (provider unmount / shutdown) — keeping it warm between recordings is the
 * whole point. Idempotent.
 */
export function releaseWarm(): void {
  const st = state
  state = null
  if (!st) return
  try {
    st.proc.onaudioprocess = null
    st.source.disconnect()
    st.proc.disconnect()
    st.sink.disconnect()
  } catch {
    /* ignore */
  }
  try {
    st.ctx.close().catch(() => {})
  } catch {
    /* ignore */
  }
  st.stream.getTracks().forEach((t) => t.stop())
}
