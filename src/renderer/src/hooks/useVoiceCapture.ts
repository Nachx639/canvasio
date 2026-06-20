import { useCallback, useEffect, useRef, useState } from 'react'
import { useCanvas } from '../store/canvas'
import { useVoiceLoop } from '../store/voiceLoop'
import { runOrder } from '../lib/aiActions'
import { pushVoiceBubble } from '../store/voiceChat'
import { blobToWav16k, blobToWav16kPadded, blobToBase64 } from '../lib/audio'
import { ensureWarm, getWarmStream, warmRate, takePreRoll, releaseWarm } from '../lib/warmMic'
import { logAction, log as rlog } from '../lib/logger'
import { t, useI18n } from '../store/i18n'
import { voiceForLang } from '../store/voicePrefs'

export type Caps = {
  stt: boolean
  tts: boolean
  sttBackend: string | null
  ttsBackend: string
  modelReady: boolean
  piper: boolean
  voices: string[]
}

/** Derived, one-word status used to drive UI affordances (bar + FAB). */
export type VoiceStatus = 'idle' | 'listening' | 'thinking' | 'speaking'

// How much warm-mic audio to PREPEND to each clip (captured just before the
// recorder fired) — covers getUserMedia/MediaRecorder spin-up so the opening
// syllable is never clipped. ~300 ms is generous without adding noise.
const PRE_ROLL_MS = 300
// Trailing silence appended after the speaker releases, so the last word's
// decay is not cut mid-formant.
const TRAIL_PAD_MS = 120

export type VoiceCapture = {
  recording: boolean
  busy: boolean
  thinking: boolean
  speaking: boolean
  status: VoiceStatus
  caps: Caps | null
  hint: string
  transcript: string
  modelPct: number | null
  speakOn: boolean
  setSpeakOn: React.Dispatch<React.SetStateAction<boolean>>
  startRec: () => Promise<void>
  stopRec: () => void
  /** Tap-to-toggle: stops if recording, otherwise starts. */
  toggleRec: () => void
  run: (raw: string) => Promise<void>
  downloadModel: () => Promise<void>
}

/**
 * Single source of truth for voice capture. This owns THE one MediaRecorder,
 * THE one in-flight guard (runningRef) and THE global push-to-talk listeners.
 * It MUST be instantiated exactly once (see VoiceProvider) and shared via
 * context — calling it twice would create two recorders that race the shared
 * CLI session.
 */
export function useVoiceCapture(): VoiceCapture {
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [caps, setCaps] = useState<Caps | null>(null)
  const [hint, setHint] = useState<string>('')
  const [transcript, setTranscript] = useState<string>('')
  const [speakOn, setSpeakOn] = useState(true)
  const [modelPct, setModelPct] = useState<number | null>(null)

  // In-flight guard: a single source of truth so a second Space-tap or Enter
  // while an order is still being interpreted/spoken cannot launch a parallel
  // ai.command (which would race the shared CLI session). Ref (not state) so the
  // check is synchronous and never sees a stale value.
  const runningRef = useRef(false)

  const mediaRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  // Pre-roll snapshot (raw warm-mic PCM captured just BEFORE this recording
  // started) + the rate it was captured at. Set at mr.start(), consumed in
  // onstop to prepend the speaker's opening syllable. A ref (not state) so it
  // never triggers a render. Owned solely by the warm stream, not torn down
  // between recordings.
  const preRollRef = useRef<Float32Array>(new Float32Array(0))
  const preRollRateRef = useRef<number>(0)
  // True when THIS recording reused the warm stream (so onstop must NOT stop the
  // warm tracks — only a fallback per-record stream gets torn down).
  const usedWarmRef = useRef(false)
  // drive the recorder lifecycle off refs to avoid stale-closure races
  const recordingRef = useRef(false)
  const cancelledRef = useRef(false)
  // True only while a push-to-talk key (Space / Meta+Period) is being held down
  // after THIS handler started a recording. Lets keyup distinguish a PTT release
  // from an unrelated Space/Period press so it never stops a toggle-started
  // session (Cmd+Shift+V), keeping keydown/keyup symmetric.
  const pttKeyActiveRef = useRef(false)

  // Holds the Audio element currently playing a TTS reply. speak() is invoked
  // fire-and-forget (runOrder does not await it) and a single AI response can
  // emit several reply/speak actions, so without this the WAV clips would play
  // on top of each other. We stop the prior clip before starting the next so the
  // latest utterance always replaces the previous one.
  const currentAudioRef = useRef<HTMLAudioElement | null>(null)

  const store = useCanvas

  // Centralised teardown: stop the active stream's tracks and drop refs. Safe
  // to call repeatedly and from any path (stop, error, unmount). This is the
  // single place that releases the microphone so there are no track leaks.
  const releaseStream = useCallback(() => {
    const mr = mediaRef.current
    mediaRef.current = null
    if (mr && mr.state !== 'inactive') {
      try {
        mr.stop()
      } catch {
        /* ignore */
      }
    }
    const stream = streamRef.current
    streamRef.current = null
    stream?.getTracks().forEach((t) => t.stop())
  }, [])

  useEffect(() => {
    window.canvasio.voice
      .capabilities()
      .then(setCaps)
      .catch(() => setCaps(null))
    // Treat 100% as TERMINAL: flash it briefly then clear, so the "Descargando
    // voz… 100%" hint never sticks forever (the Kokoro download is detached, so
    // we can't rely on a later call to clear it — audit #13).
    let clearTimer: ReturnType<typeof setTimeout> | undefined
    const off = window.canvasio.voice.onModelProgress((pct) => {
      if (pct >= 100) {
        setModelPct(100)
        clearTimer = setTimeout(() => setModelPct(null), 800)
      } else {
        setModelPct(pct)
      }
    })
    return () => {
      off()
      if (clearTimer) clearTimeout(clearTimer)
    }
  }, [])

  // Warm the mic + rolling pre-roll buffer once on mount, so push-to-talk has a
  // hot stream and ~300 ms of look-behind ready the instant a key is pressed.
  // Fire-and-forget: if it fails (mic denied), startRec falls back to acquiring
  // a stream on demand and simply records without pre-roll. The warm stream is
  // released on unmount via releaseWarm(). No state writes → no render.
  useEffect(() => {
    ensureWarm().catch(() => {})
    return () => {
      releaseWarm()
    }
  }, [])

  const speak = useCallback(
    async (msg: string) => {
      if (!speakOn || !msg) return
      try {
        // Read the active app language as a PRIMITIVE (no selector / fresh object →
        // #185-safe) so TTS speaks in the currently selected language, plus the
        // user's chosen Kokoro voice for that language (Settings selector).
        const lang = useI18n.getState().lang
        const r = await window.canvasio.voice.tts(msg, voiceForLang(lang), lang)
        if (r.ok && r.wavBase64) {
          // Stop any clip still playing so the latest utterance replaces it
          // instead of overlapping into garbled speech.
          const prev = currentAudioRef.current
          if (prev && !prev.ended) {
            try {
              prev.pause()
            } catch {
              /* ignore */
            }
          }
          currentAudioRef.current = null
          const audio = new Audio('data:audio/wav;base64,' + r.wavBase64)
          currentAudioRef.current = audio
          audio.volume = store.getState().appVolume
          // Track the speaking lifecycle so the FAB can show a distinct state.
          // onended/onerror always clear it so the UI never sticks on "speaking".
          setSpeaking(true)
          const clear = (): void => {
            if (currentAudioRef.current === audio) currentAudioRef.current = null
            setSpeaking(false)
          }
          audio.onended = clear
          audio.onerror = clear
          audio.play().catch(() => {
            if (currentAudioRef.current === audio) currentAudioRef.current = null
            setSpeaking(false)
          })
        } else if (!r.ok) {
          rlog.warn('voice.tts.failed', { error: r.error })
        }
      } catch (err) {
        setSpeaking(false)
        rlog.error('voice.tts.error', { message: String((err as Error)?.message || err) })
      }
    },
    [speakOn, store]
  )

  // ---- interpret an order with AI (falls back to local interpreter) ----
  const run = useCallback(
    async (raw: string) => {
      const command = raw.trim()
      if (!command) return
      // Serialize orders: refuse to start a new one while the previous is still
      // running. This protects the single shared CLI session from concurrent
      // --resume races and avoids dropped/duplicated actions.
      if (runningRef.current) {
        setHint(t('voice.busy_previous'))
        speak('Un momento, sigo con lo anterior')
        return
      }
      runningRef.current = true
      // Keep the heard text visible on its own line; the status line below shows
      // progress without clobbering what we understood.
      setTranscript(command)
      // Conversation bubbles: record the user's turn now and the assistant's
      // spoken reply as it is uttered (wrap speak below so each spoken assistant
      // utterance becomes a left-side bubble).
      pushVoiceBubble('user', command)
      let spokenAny = false
      const speakAndBubble = (t: string): void => {
        spokenAny = true
        pushVoiceBubble('assistant', t)
        speak(t)
      }
      setThinking(true)
      setHint(t('voice.thinking'))
      // Escalate the feedback if the CLI is taking a while, so a long silent wait
      // doesn't feel broken.
      const slow = setTimeout(() => setHint(t('voice.still_thinking')), 6000)
      try {
        // runOrder returns a human summary, e.g. "Enviado a Nova: …", a reply
        // text, or a fallback note ("IA no disponible, …").
        const summary = await runOrder(command, { speak: speakAndBubble })
        // The conversation lives in the bubbles now. If nothing was spoken/bubbled
        // (e.g. a pure action command), surface the summary as the assistant bubble;
        // then CLEAR the status line so it never lingers as a faint duplicate under
        // the bubbles.
        if (!spokenAny && summary) pushVoiceBubble('assistant', summary)
        setHint('')
      } catch (err: any) {
        const msg = String(err?.message || err)
        const text = msg && msg !== 'undefined' ? msg : 'No he podido ejecutar la orden'
        pushVoiceBubble('assistant', text)
        setHint('')
      } finally {
        clearTimeout(slow)
        setThinking(false)
        runningRef.current = false
      }
    },
    [speak]
  )

  // ---- recording (push to talk) ----
  const startRec = useCallback(async () => {
    if (recordingRef.current || busy) return
    // Don't start a new recording while a previous order is still being
    // interpreted/spoken — it would overlap the in-flight run.
    if (runningRef.current) {
      setHint(t('voice.busy_previous'))
      return
    }
    if (!caps?.stt) {
      setHint(t('voice.stt_unavailable'))
      return
    }
    // mark intent to record immediately so a fast stop (before getUserMedia
    // resolves) can cancel us via cancelledRef.
    cancelledRef.current = false
    recordingRef.current = true
    try {
      // Reuse the always-warm stream so recording begins with ZERO async spin-up
      // (the old getUserMedia-on-keydown path lost the opening ~200 ms). Only if
      // the warm stream isn't available (mic denied / not warmed yet) do we
      // acquire one on demand as a fallback.
      let usedWarm = false
      let stream = getWarmStream()
      if (stream) {
        usedWarm = true
      } else {
        // Try one warm-up, then fall back to a throwaway per-record stream.
        await ensureWarm().catch(() => false)
        stream = getWarmStream()
        if (stream) {
          usedWarm = true
        } else {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        }
      }
      usedWarmRef.current = usedWarm
      // a quick Space tap may have already requested a stop while we awaited the
      // (fallback) getUserMedia — if so, abort and tear down only a non-warm
      // stream (the warm one must stay alive for next time).
      if (cancelledRef.current) {
        if (!usedWarm) stream.getTracks().forEach((t) => t.stop())
        recordingRef.current = false
        return
      }
      // Defensive: if a prior NON-warm stream somehow survived, release it before
      // we overwrite the ref. Never stop the warm stream here.
      if (streamRef.current && streamRef.current !== stream) {
        streamRef.current.getTracks().forEach((t) => t.stop())
      }
      // Only track a non-warm stream in streamRef so releaseStream() never kills
      // the warm one. The warm stream is owned by warmMic and lives across records.
      streamRef.current = usedWarm ? null : stream
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'
      const mr = new MediaRecorder(stream, { mimeType: mime })
      chunksRef.current = []
      mr.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data)
      // If the recorder errors mid-capture, make sure we always free the mic
      // and clear the recording state so the UI never gets stuck "listening".
      mr.onerror = () => {
        recordingRef.current = false
        if (mediaRef.current === mr) mediaRef.current = null
        // Only stop a non-warm (fallback) stream; the warm one stays alive.
        if (!usedWarm) stream.getTracks().forEach((t) => t.stop())
        if (streamRef.current === stream) streamRef.current = null
        setRecording(false)
        setHint(t('voice.record_error'))
        rlog.error('voice.record.error', {})
      }
      mr.onstop = async () => {
        // Release only a non-warm fallback stream; the warm stream is reused for
        // the next recording and must NOT be torn down here.
        if (!usedWarm) stream.getTracks().forEach((t) => t.stop())
        if (streamRef.current === stream) streamRef.current = null
        if (mediaRef.current === mr) mediaRef.current = null
        const blob = new Blob(chunksRef.current, { type: mime })
        chunksRef.current = []
        // Snapshot the pre-roll / pad captured for THIS recording, then reset so a
        // later recording can never accidentally reuse stale look-behind audio.
        const preRoll = preRollRef.current
        const preRollRate = preRollRateRef.current
        preRollRef.current = new Float32Array(0)
        preRollRateRef.current = 0
        if (blob.size < 1200) {
          setHint(t('voice.hold_longer'))
          return
        }
        setBusy(true)
        setHint(t('voice.transcribing'))
        try {
          // re-encode to clean 16 kHz mono WAV in-renderer (robust STT input),
          // PREPENDING the warm-mic pre-roll (the opening syllable spoken before
          // the recorder fired) and APPENDING a short trailing silence pad so the
          // final word isn't clipped. When there's no pre-roll (fallback stream),
          // blobToWav16kPadded degrades to the plain re-encode.
          const wav = await blobToWav16kPadded(blob, preRoll, preRollRate, TRAIL_PAD_MS)
          const b64 = await blobToBase64(wav)
          // Read the active app language as a PRIMITIVE (no selector / fresh object →
          // #185-safe) so STT transcribes against the currently selected language.
          const lang = useI18n.getState().lang
          logAction('voice.stt')
          const r = await window.canvasio.voice.stt(b64, 'audio/wav', lang)
          setBusy(false)
          if (r.ok && r.text) {
            // show what we heard on the persistent transcript line, then act on
            // it (run() also sets the transcript and drives the status line).
            setTranscript(r.text)
            // Voice Standup Loop: if the loop is armed and a blocking question is
            // awaiting your spoken answer, divert THIS transcript verbatim to the
            // asking agent (enqueueForTarget + auto-resolve) and short-circuit the
            // normal interpret()/run() path. When unarmed or nothing is pending,
            // consumeReply() returns false and behavior is byte-for-byte unchanged.
            const loop = useVoiceLoop.getState()
            if (loop.armed && loop.pending && loop.consumeReply(r.text)) {
              setHint(t('voice.reply_sent', { title: loop.pending.askingTitle }))
            } else {
              run(r.text)
            }
          } else {
            rlog.warn('voice.stt.failed', { error: r.error })
            setHint(r.error || t('voice.not_understood'))
          }
        } catch (err: any) {
          setBusy(false)
          // Use the AudioError CODE (reliable) — a 'silent' clip never reaches STT,
          // so pressing record + saying nothing shows a gentle notice instead of a
          // hallucinated command. No bubble, no command run (we're in catch).
          const code = err?.code
          const m = String(err?.message || err)
          rlog.warn('voice.stt.skip', { code, message: m })
          setHint(
            code === 'silent'
              ? t('voice.not_heard')
              : code === 'too-short' || code === 'empty-recording'
                ? t('voice.too_short')
                : t('voice.not_understood')
          )
        }
      }
      // Capture the look-behind RIGHT before the recorder fires: this is the
      // audio the warm mic buffered in the moments before push-to-talk, i.e. the
      // speaker's opening syllable that the recorder itself would have missed.
      // Only meaningful for the warm stream (the fallback path has no ring buffer).
      if (usedWarm) {
        preRollRef.current = takePreRoll(PRE_ROLL_MS)
        preRollRateRef.current = warmRate()
      } else {
        preRollRef.current = new Float32Array(0)
        preRollRateRef.current = 0
      }
      mr.start(100)
      mediaRef.current = mr
      setRecording(true)
      setHint(t('voice.listening'))
    } catch (err: any) {
      // getUserMedia rejected, or the MediaRecorder constructor / start threw
      // after the stream was acquired. Release everything so no track leaks and
      // the recording state never gets stuck.
      recordingRef.current = false
      releaseStream()
      setRecording(false)
      setHint(t('voice.mic_unavailable'))
    }
  }, [busy, caps, run, releaseStream])

  // idempotent stop: safe to call multiple times (onPointerLeave + onPointerUp)
  const stopRec = useCallback(() => {
    // signal cancellation for an in-flight getUserMedia in startRec
    cancelledRef.current = true
    if (!recordingRef.current) return
    recordingRef.current = false
    // releaseStream() stops the recorder (which fires onstop → transcription)
    // and unconditionally tears down the mic tracks, so there are no leaks even
    // if onstop never runs (e.g. recorder already inactive).
    releaseStream()
    setRecording(false)
  }, [releaseStream])

  // tap-to-toggle: read the ref (not state) so it is race-free even when fired
  // back-to-back from a keyboard accelerator or FAB tap.
  const toggleRec = useCallback(() => {
    if (recordingRef.current) stopRec()
    else void startRec()
  }, [startRec, stopRec])

  // global push-to-talk: hold Space when input not focused, or ⌘. ; plus a
  // tap-to-toggle accelerator (⌘/Ctrl+Shift+V). Registered ONCE here so there is
  // exactly one set of window listeners regardless of how many consumers render.
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.repeat) return
      const inField =
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA'
      // tap-to-toggle accelerator — works even while typing (it is an explicit
      // modifier chord that does not clash with text entry).
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyV') {
        e.preventDefault()
        toggleRec()
        return
      }
      if (
        ((e.code === 'Space' && !inField) || (e.metaKey && e.code === 'Period')) &&
        caps?.stt
      ) {
        e.preventDefault()
        // Remember that PTT owns this recording so the matching keyup (and only
        // it) is allowed to stop it.
        pttKeyActiveRef.current = true
        void startRec()
      }
    }
    const up = (e: KeyboardEvent): void => {
      // Only stop on the release of a PTT key that actually started a recording.
      // This keeps keyup symmetric with keydown and prevents an unrelated
      // Space/Period release from killing a toggle-started session.
      if ((e.code === 'Space' || e.code === 'Period') && pttKeyActiveRef.current) {
        pttKeyActiveRef.current = false
        stopRec()
      }
    }
    // Safety net: if the window loses focus while a PTT key is held (Cmd-Tab, a
    // system dialog steals focus, or focus moves into an embedded xterm/web
    // node), the matching keyup never reaches this window and the mic would
    // record indefinitely. Stop any PTT-owned recording on blur.
    const blur = (): void => {
      if (pttKeyActiveRef.current) {
        pttKeyActiveRef.current = false
        stopRec()
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [startRec, stopRec, toggleRec])

  // optional global accelerator from the main process (electron globalShortcut).
  // Fires even when the window is not focused; routed to the same toggle path.
  // No-op if the preload does not expose it (older main bundle / no restart yet).
  useEffect(() => {
    const off = window.canvasio?.voice?.onToggle?.(() => toggleRec())
    return () => {
      off?.()
    }
  }, [toggleRec])

  // clean up: stop any live getUserMedia tracks / recorder on unmount
  useEffect(() => {
    return () => {
      cancelledRef.current = true
      recordingRef.current = false
      releaseStream()
    }
  }, [releaseStream])

  const downloadModel = useCallback(async (): Promise<void> => {
    setHint(t('voice.downloading_model'))
    await window.canvasio.voice.ensureModel()
    setModelPct(null)
    setHint(t('voice.model_ready'))
    const c = await window.canvasio.voice.capabilities()
    setCaps(c)
  }, [])

  const status: VoiceStatus = recording
    ? 'listening'
    : busy || thinking
      ? 'thinking'
      : speaking
        ? 'speaking'
        : 'idle'

  return {
    recording,
    busy,
    thinking,
    speaking,
    status,
    caps,
    hint,
    transcript,
    modelPct,
    speakOn,
    setSpeakOn,
    startRec,
    stopRec,
    toggleRec,
    run,
    downloadModel
  }
}
