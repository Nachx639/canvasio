import { useRef, useState } from 'react'
import { useCanvas } from '../store/canvas'
import { useVoiceLoop } from '../store/voiceLoop'
import { useVoice } from '../hooks/VoiceContext'
import { useFrostRect } from '../hooks/useFrostRect'
import { useT } from '../store/i18n'

export function VoiceBar(): JSX.Element {
  const t = useT()
  // The text <input> is UI-local; the capture/STT/run pipeline lives in the
  // shared useVoiceCapture hook (one recorder, one in-flight guard) consumed via
  // context so the FAB and this bar drive the SAME state.
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const {
    recording,
    busy,
    thinking,
    caps,
    hint,
    modelPct,
    speakOn,
    setSpeakOn,
    startRec,
    stopRec,
    run,
    downloadModel
  } = useVoice()

  const store = useCanvas

  // Reveal the z-29 BackdropFrost under the two glass surfaces so they read as
  // real liquid glass (blurred wallpaper through them), in lockstep with layout.
  const bootRef = useRef<HTMLButtonElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  useFrostRect(bootRef, { radius: 10 })
  useFrostRect(barRef, { radius: 14 })

  // Voice Standup Loop — armed flag + the single pending "respondiendo a <X>"
  // reply target. Subscribed reactively so the chip + toggle reflect live state.
  const loopArmed = useVoiceLoop((s) => s.armed)
  const loopPending = useVoiceLoop((s) => s.pending)
  const toggleLoop = useVoiceLoop((s) => s.toggle)

  const submit = (): void => {
    const v = text.trim()
    if (!v || busy || thinking) return
    setText('')
    run(v)
  }

  return (
    <>
      {/* Boot recipe (bottom-left, above zoom) */}
      <button
        ref={bootRef}
        className="glass"
        onClick={() => {
          store.getState().bootRecipe()
        }}
        title={t('voice.boot_recipe_tooltip')}
        aria-label={t('voice.boot_recipe_tooltip')}
        style={{
          position: 'absolute',
          left: 16,
          bottom: 56,
          zIndex: 40,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 14px',
          borderRadius: 10,
          color: '#cdd9f5',
          fontSize: 13,
          fontWeight: 600,
          border: 'none'
        }}
      >
        ▸ {t('voice.boot_recipe')}
      </button>

      {/* command bar (bottom center) */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          bottom: 18,
          transform: 'translateX(-50%)',
          zIndex: 45,
          width: 'min(720px, 60vw)'
        }}
      >
        {loopPending && (
          <div style={{ textAlign: 'center', marginBottom: 8 }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 999,
                background: 'rgba(122,162,255,0.18)',
                border: '1px solid rgba(122,162,255,0.45)',
                color: '#cdd9f5',
                fontSize: 12,
                fontWeight: 600
              }}
            >
              <span style={{ fontSize: 11 }}>🎙</span>
              {t('voice.replying_to', { title: loopPending.askingTitle })}
            </span>
          </div>
        )}
        {/* Transient STATUS line only (Escuchando/Transcribiendo/Pensando/errors).
            The conversation itself — what you said and the agent's reply — lives in
            the chat bubbles (VoiceBubbles), so we no longer echo the transcript or
            the reply here (that produced a faint duplicate under the bubbles). */}
        {(hint || modelPct != null) && (
          <div style={{ textAlign: 'center', marginBottom: 8 }}>
            <div
              style={{
                fontSize: 12,
                color: recording ? '#ffd479' : thinking ? '#9aa8ff' : '#9fb0d2'
              }}
            >
              {/* A bare modelPct with no hint = a voice/model downloading in the
                  background (warming) → tell the user it's loading. */}
              {hint || t('voice.downloading_voice')}
              {modelPct != null && ` ${modelPct}%`}
            </div>
          </div>
        )}
        <div
          ref={barRef}
          className="glass"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            borderRadius: 14,
            border: recording ? '1px solid rgba(255,180,90,0.6)' : undefined,
            boxShadow: recording ? '0 0 28px -6px rgba(255,180,90,0.5)' : undefined
          }}
        >
          <button
            onPointerDown={startRec}
            onPointerUp={stopRec}
            onPointerLeave={() => recording && stopRec()}
            title={t('voice.mic_tooltip')}
            style={{
              width: 38,
              height: 38,
              borderRadius: '50%',
              border: 'none',
              flex: '0 0 auto',
              background: recording
                ? 'radial-gradient(circle at 50% 40%, #ff8a5c, #e0563f)'
                : 'rgba(91,140,255,0.18)',
              color: '#fff',
              display: 'grid',
              placeItems: 'center',
              boxShadow: recording ? '0 0 18px rgba(224,86,63,0.7)' : 'none',
              transform: recording ? 'scale(1.06)' : 'scale(1)',
              transition: 'transform 0.12s'
            }}
          >
            <MicIcon />
          </button>

          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
            placeholder={
              busy
                ? t('voice.transcribing')
                : thinking
                  ? t('voice.thinking')
                  : t('voice.placeholder')
            }
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: '#e8eefc',
              fontSize: 14
            }}
          />

          <button
            onClick={() => toggleLoop()}
            aria-label={loopArmed ? t('voice.loop_off') : t('voice.loop_on')}
            title={
              loopArmed
                ? t('voice.loop_active_tooltip')
                : t('voice.loop_inactive_tooltip')
            }
            style={iconToggle(loopArmed)}
          >
            🔁
          </button>
          <button
            onClick={() => setSpeakOn((v) => !v)}
            aria-label={speakOn ? t('voice.tts_off') : t('voice.tts_on')}
            title={speakOn ? t('voice.tts_active') : t('voice.tts_muted')}
            style={iconToggle(speakOn)}
          >
            {speakOn ? '🔊' : '🔈'}
          </button>
          <button onClick={submit} aria-label={t('voice.send')} title={t('voice.send_short')} style={iconToggle(false)}>
            ↵
          </button>
        </div>

        {/* capability footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: 14,
            marginTop: 8,
            fontSize: 11,
            color: '#6f84ad'
          }}
        >
          <span>STT: {caps?.stt ? caps.sttBackend : t('voice.not_installed')}</span>
          <span>TTS: {caps?.ttsBackend || 'say · es_ES'}</span>
          {caps && !caps.modelReady && (
            <button
              onClick={downloadModel}
              style={{ color: '#7aa2ff', background: 'none', border: 'none', fontSize: 11 }}
            >
              {t('voice.download_stt_model')}
            </button>
          )}
        </div>
      </div>
    </>
  )
}

function iconToggle(active: boolean): React.CSSProperties {
  return {
    width: 32,
    height: 32,
    borderRadius: 8,
    border: 'none',
    flex: '0 0 auto',
    background: active ? 'rgba(91,140,255,0.2)' : 'rgba(255,255,255,0.05)',
    color: '#cdd9f5',
    fontSize: 14,
    display: 'grid',
    placeItems: 'center'
  }
}

function MicIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" />
      <path d="M3 7.5a5 5 0 0010 0M8 12.5v2M5.5 14.5h5" />
    </svg>
  )
}
