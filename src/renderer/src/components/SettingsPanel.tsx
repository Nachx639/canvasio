import { useEffect, useState } from 'react'
import { useCanvas } from '../store/canvas'
import { useAwayAlerts } from '../store/awayAlerts'
import { useCatchup } from '../store/catchup'
import { useI18n, useT, type Lang } from '../store/i18n'
import { useVoicePrefs, VOICE_CATALOG, voiceEngine } from '../store/voicePrefs'
import { THEMES } from '../lib/themes'

/** The four supported languages, shown in their NATIVE names in the selector. */
const LANGS: { id: Lang; label: string }[] = [
  { id: 'es', label: 'Español' },
  { id: 'en', label: 'English' },
  { id: 'pt', label: 'Português' },
  { id: 'zh', label: '中文' }
]

// Per-language voice display — mirrors src/main/kokoroVoices.ts so the Settings
// panel shows the ACTUAL Kokoro neural voice + macOS `say` fallback that will be
// used for the currently selected language (not a hardcoded es). `name` is the
// Kokoro voice id; readiness is gated on the SINGLE shared model (caps.kokoroModelReady),
// so the status dot is green when the model is on disk and amber ("downloads on
// first use") otherwise.
const VOICE_DISPLAY: Record<Lang, { name: string; short: string; sayName: string; native: string }> = {
  es: { name: 'ef_dora', short: 'Kokoro · ef_dora', sayName: 'Mónica', native: 'Español' },
  en: { name: 'af_heart', short: 'Kokoro · af_heart', sayName: 'Samantha', native: 'English' },
  pt: { name: 'pf_dora', short: 'Kokoro · pf_dora', sayName: 'Luciana', native: 'Português' },
  zh: { name: 'zf_xiaoxiao', short: 'Kokoro · zf_xiaoxiao', sayName: 'Sin-ji', native: '中文' }
}

interface Caps {
  stt: boolean
  sttBackend: string | null
  ttsBackend: string
  modelReady: boolean
  piper: boolean
  voices: string[]
  kokoro: boolean
  kokoroModelReady: boolean
}

interface BgItem {
  id: string
  name: string
  hasBoom: boolean
  hasThumb?: boolean
}

export function SettingsPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const t = useT()
  // #185-safe: this selector returns the primitive `lang` string, so the panel
  // re-renders (and the active language highlights) on a switch without churn.
  const lang = useI18n((s) => s.lang)
  const theme = useCanvas((s) => s.theme)
  const setTheme = useCanvas((s) => s.setTheme)
  // #185-safe: primitive selectors. `chosenVoice` is the user's Kokoro voice for
  // the active language; `setVoice` persists a new pick. The "test voice" button
  // and useVoiceCapture read voiceForLang() so a change applies immediately.
  const chosenVoice = useVoicePrefs((s) => s.voices[lang])
  const setVoice = useVoicePrefs((s) => s.setVoice)

  // Away Alerts — persisted native OS notification preferences (its own store +
  // localStorage key 'canvasio:awayAlerts'). Master toggle plus per-event-type flags.
  const away = useAwayAlerts()
  const [caps, setCaps] = useState<Caps | null>(null)
  // Engine-aware display for the chosen voice: Piper for the es_ES (Spain) voices,
  // Kokoro otherwise. `voiceReady` drives the "downloads on first use" hint + dot.
  const voiceEng = voiceEngine(lang, chosenVoice)
  const voiceLabel = `${voiceEng === 'piper' ? 'Piper' : 'Kokoro'} · ${chosenVoice}`
  const voiceNeuralAvail = voiceEng === 'piper' ? !!caps?.piper : !!caps?.kokoro
  const voiceReady = voiceEng === 'piper' ? !!caps?.piper : !!caps?.kokoroModelReady
  const [testText, setTestText] = useState(() => t('settings.test_voice_default_text'))
  // True once the user edits the test text by hand, which freezes it so the
  // language-sync effect below stops overwriting their custom phrase.
  const [testEdited, setTestEdited] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  // True between pressing "test voice" and audio actually starting — covers the
  // synthesis wait (first sidecar spawn / model load) so the user sees a
  // "loading voice…" notice instead of a silent pause.
  const [preparing, setPreparing] = useState(false)
  const [pct, setPct] = useState<number | null>(null)

  // Keep the sample phrase in sync with the selected language so switching to
  // English/Português/中文 shows (and speaks) a sentence in THAT language —
  // unless the user has typed their own text, in which case we leave it alone.
  useEffect(() => {
    if (!testEdited) setTestText(t('settings.test_voice_default_text'))
    // re-run when language changes; `t` identity tracks `lang` via useT().
  }, [lang, testEdited, t])

  const [bgs, setBgs] = useState<BgItem[]>([])
  const [bgId, setBgId] = useState<string>(() => localStorage.getItem('canvasio:bg') || '')
  const [bgMode, setBgMode] = useState<'normal' | 'boom'>(
    () => (localStorage.getItem('canvasio:bgmode') === 'boom' ? 'boom' : 'normal')
  )

  // Insight Harvester: auto-pin discovery-grade agent lines to the Brief Board.
  // Default ON (only 'off' disables it); TerminalOverlay reads the SAME key.
  const [harvest, setHarvest] = useState<boolean>(
    () => localStorage.getItem('canvasio:harvest') !== 'off'
  )

  const toggleHarvest = (): void => {
    setHarvest((v) => {
      const next = !v
      localStorage.setItem('canvasio:harvest', next ? 'on' : 'off')
      return next
    })
  }

  // Command Trail: capture the shell commands each agent runs into the per-node
  // audit timeline. Default ON (only 'off' disables it); TerminalOverlay reads the
  // SAME key ('canvasio:cmdtrail').
  const [cmdtrail, setCmdtrail] = useState<boolean>(
    () => localStorage.getItem('canvasio:cmdtrail') !== 'off'
  )

  const toggleCmdtrail = (): void => {
    setCmdtrail((v) => {
      const next = !v
      localStorage.setItem('canvasio:cmdtrail', next ? 'on' : 'off')
      return next
    })
  }

  // Backlog — per-agent "unseen activity" jump. When on, the capture-phase '.'
  // hotkey flies the camera to the agent with the most unseen output. Default ON
  // (only 'off' disables it); App.tsx reads the SAME key ('canvasio:backlog'),
  // mirroring the harvest/cmdtrail toggles. The per-node "•N" badge + TopBar chip
  // are always shown regardless; this flag only governs the keyboard jump.
  const [backlog, setBacklog] = useState<boolean>(
    () => localStorage.getItem('canvasio:backlog') !== 'off'
  )

  const toggleBacklog = (): void => {
    setBacklog((v) => {
      const next = !v
      localStorage.setItem('canvasio:backlog', next ? 'on' : 'off')
      return next
    })
  }

  // Catch-Up — per-agent "what happened since you last looked" unread digest. When
  // on, terminal nodes show a "↺N" pip and ⌘U opens the digest panel. Default ON;
  // the flag lives in the (memory-only) Catch-Up store but persists its preference
  // under its own localStorage key, mirroring the toggles above.
  const catchupEnabled = useCatchup((s) => s.enabled)
  const setCatchupEnabled = useCatchup((s) => s.setEnabled)
  const toggleCatchup = (): void => setCatchupEnabled(!catchupEnabled)

  // Recall — Auto-recall on spawn. When on, a freshly spawned agent is silently
  // surfaced the relevant remembered facts from persisted Cross-Mission memory.
  // Default ON (only 'off' disables it); TerminalOverlay reads the SAME key
  // ('canvasio:recall'), mirroring the harvest/cmdtrail toggles.
  const [recall, setRecall] = useState<boolean>(
    () => localStorage.getItem('canvasio:recall') !== 'off'
  )

  const toggleRecall = (): void => {
    setRecall((v) => {
      const next = !v
      localStorage.setItem('canvasio:recall', next ? 'on' : 'off')
      return next
    })
  }

  // Magnetic Align — smart snap guides while hand-dragging a window. When on, a
  // dragged window's edges/centers magnetically snap to nearby windows and crisp
  // cyan guide lines flash. Default ON (only 'off' disables it); NodeView reads the
  // SAME key ('canvasio:snap') live per drag, mirroring the harvest/cmdtrail toggles.
  // (Hold Alt during a drag to suspend snapping for free placement regardless.)
  const [snap, setSnap] = useState<boolean>(
    () => localStorage.getItem('canvasio:snap') !== 'off'
  )

  const toggleSnap = (): void => {
    setSnap((v) => {
      const next = !v
      localStorage.setItem('canvasio:snap', next ? 'on' : 'off')
      return next
    })
  }

  // Esc closes the panel (capture phase, like the other HUD panels).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  useEffect(() => {
    window.canvasio.voice.capabilities().then(setCaps).catch(() => {})
    const off = window.canvasio.voice.onModelProgress(setPct)
    return () => {
      off()
    }
  }, [])

  useEffect(() => {
    window.canvasio.bg
      .list()
      .then((items) => setBgs(items as BgItem[]))
      .catch(() => setBgs([]))
  }, [])

  const selectedBg = bgs.find((b) => b.id === bgId)

  const selectBg = (id: string): void => {
    setBgId(id)
    if (id) localStorage.setItem('canvasio:bg', id)
    else localStorage.removeItem('canvasio:bg')
    window.dispatchEvent(new CustomEvent('canvasio:bgchange'))
  }

  const selectBgMode = (mode: 'normal' | 'boom'): void => {
    setBgMode(mode)
    localStorage.setItem('canvasio:bgmode', mode)
    window.dispatchEvent(new CustomEvent('canvasio:bgchange'))
  }

  const test = async (): Promise<void> => {
    setPreparing(true)
    try {
      // Pass the active language + the user's chosen voice so the test previews
      // exactly what they just selected.
      const r = await window.canvasio.voice.tts(testText, chosenVoice, lang)
      setPreparing(false)
      if (r.ok && r.wavBase64) {
        setSpeaking(true)
        const a = new Audio('data:audio/wav;base64,' + r.wavBase64)
        a.volume = useCanvas.getState().appVolume
        a.onended = () => setSpeaking(false)
        a.onerror = () => setSpeaking(false)
        await a.play()
      } else setSpeaking(false)
    } catch {
      setPreparing(false)
      setSpeaking(false)
    }
  }

  const downloadModel = async (): Promise<void> => {
    await window.canvasio.voice.ensureModel()
    setPct(null)
    setCaps(await window.canvasio.voice.capabilities())
  }

  return (
    <div
      className="glass-solid no-drag"
      style={{
        pointerEvents: 'auto',
        position: 'absolute',
        top: 46,
        left: '50%',
        transform: 'translateX(-130px)',
        borderRadius: 14,
        padding: 16,
        width: 360,
        // Adapt to the window height and scroll instead of overflowing off-screen
        // on short windows (top:46 anchor → leave a small bottom margin).
        maxHeight: 'calc(100vh - 60px)',
        overflowY: 'auto',
        fontSize: 13,
        color: '#d7e1f7'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{t('settings.title')}</span>
        <button onClick={onClose} aria-label={t('settings.close')} title={t('common.close')} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#8fa3cc' }}>
          ✕
        </button>
      </div>

      <div style={{ marginBottom: 6, color: '#8fa3cc', fontSize: 12 }}>{t('common.language')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginBottom: 16 }}>
        {LANGS.map((l) => {
          const active = lang === l.id
          return (
            <button
              key={l.id}
              onClick={() => useI18n.getState().setLang(l.id)}
              title={l.label}
              style={{
                border: '1px solid ' + (active ? 'rgba(120,160,255,0.6)' : 'rgba(120,150,220,0.2)'),
                background: active ? 'rgba(91,140,255,0.18)' : 'rgba(8,12,26,0.35)',
                color: active ? '#cfe0ff' : '#9fb0d2',
                borderRadius: 8,
                padding: '6px 4px',
                fontSize: 12,
                fontWeight: active ? 600 : 400,
                cursor: 'pointer',
                outline: active ? '2px solid rgba(120,160,255,0.33)' : 'none',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {l.label}
            </button>
          )
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 8 }}>
        <span style={{ color: '#8fa3cc', fontSize: 12 }}>{t('settings.background')}</span>
        <span style={{ marginLeft: 'auto', color: '#6f84ad', fontSize: 11 }}>
          {bgId === '' ? t('settings.background_animated') : selectedBg?.name ?? ''}
        </span>
      </div>
      <div
        className="canvasio-bg-scroll"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 8,
          maxHeight: 248,
          overflowY: 'auto',
          paddingRight: 4,
          marginBottom: 12
        }}
      >
        <button
          onClick={() => selectBg('')}
          title={t('settings.background_animated_themes')}
          style={bgCardStyle(bgId === '')}
        >
          <div
            style={{
              ...bgThumbStyle,
              background: 'linear-gradient(135deg, #2b3a6b, #6f4fb0)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <span style={{ fontSize: 22 }}>✨</span>
          </div>
          <div style={bgLabelStyle(bgId === '')}>{t('settings.background_animated_themes')}</div>
        </button>
        {bgs.map((b) => {
          const selected = bgId === b.id
          return (
            <button key={b.id} onClick={() => selectBg(b.id)} title={b.name} style={bgCardStyle(selected)}>
              <div style={bgThumbStyle}>
                <img
                  src={`canvasio-bg://local/${b.id}.jpg`}
                  loading="lazy"
                  alt={b.name}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
                {b.hasBoom && (
                  <span
                    style={{
                      position: 'absolute',
                      top: 4,
                      right: 4,
                      fontSize: 9,
                      lineHeight: 1,
                      padding: '2px 4px',
                      borderRadius: 5,
                      background: 'rgba(8,12,26,0.7)',
                      color: '#cfe0ff'
                    }}
                  >
                    ↺
                  </span>
                )}
              </div>
              <div style={bgLabelStyle(selected)}>{b.name}</div>
            </button>
          )
        })}
      </div>

      {bgId !== '' && selectedBg?.hasBoom && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16 }}>
          <span style={{ color: '#8fa3cc', fontSize: 12, marginRight: 'auto' }}>{t('settings.loop')}</span>
          {(['normal', 'boom'] as const).map((m) => (
            <button
              key={m}
              onClick={() => selectBgMode(m)}
              style={{
                border: '1px solid ' + (bgMode === m ? 'rgba(120,160,255,0.6)' : 'rgba(120,150,220,0.2)'),
                background: bgMode === m ? 'rgba(91,140,255,0.18)' : 'transparent',
                color: bgMode === m ? '#cfe0ff' : '#9fb0d2',
                borderRadius: 8,
                padding: '4px 10px',
                fontSize: 11.5,
                cursor: 'pointer'
              }}
            >
              {m === 'normal' ? t('common.normal') : t('common.boomerang')}
            </button>
          ))}
        </div>
      )}
      {bgId === '' && <div style={{ marginBottom: 16 }} />}

      <div style={{ marginBottom: 6, color: '#8fa3cc', fontSize: 12 }}>{t('settings.theme')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 16 }}>
        {THEMES.map((th) => (
          <button
            key={th.id}
            onClick={() => setTheme(th.id)}
            title={th.name}
            style={{
              border: '1px solid ' + (theme === th.id ? th.accent : 'rgba(120,150,220,0.2)'),
              borderRadius: 9,
              padding: 6,
              background: 'transparent',
              cursor: 'pointer',
              outline: theme === th.id ? `2px solid ${th.accent}55` : 'none'
            }}
          >
            <div
              style={{
                height: 30,
                borderRadius: 6,
                background: `linear-gradient(135deg, ${th.sky[1]}, ${th.sky[3]})`,
                position: 'relative',
                overflow: 'hidden'
              }}
            >
              <span style={{ position: 'absolute', top: 4, right: 5, width: 7, height: 7, borderRadius: '50%', background: th.moon }} />
              {th.grass && (
                <span style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 7, background: th.grass[0] }} />
              )}
            </div>
            <div style={{ fontSize: 10.5, color: theme === th.id ? '#fff' : '#9fb0d2', marginTop: 4 }}>{th.name}</div>
          </button>
        ))}
      </div>

      <div style={{ marginBottom: 6, color: '#8fa3cc', fontSize: 12 }}>{t('settings.agents')}</div>
      <button
        onClick={toggleHarvest}
        title={t('settings.harvest_tooltip')}
        style={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          gap: 10,
          marginBottom: 16,
          border: '1px solid ' + (harvest ? 'rgba(255,212,121,0.45)' : 'rgba(120,150,220,0.2)'),
          background: harvest ? 'rgba(255,212,121,0.1)' : 'rgba(8,12,26,0.35)',
          borderRadius: 10,
          padding: '8px 11px',
          cursor: 'pointer',
          textAlign: 'left'
        }}
      >
        <span style={{ fontSize: 14, color: harvest ? '#ffd479' : '#6f84ad' }}>✦</span>
        <span style={{ flex: '1 1 0', minWidth: 0 }}>
          <div style={{ fontSize: 12.5, color: '#dbe6ff', fontWeight: 600 }}>{t('settings.harvest_title')}</div>
          <div style={{ fontSize: 10.5, color: '#6f84ad', lineHeight: 1.4 }}>
            {t('settings.harvest_desc')}
          </div>
        </span>
        <span
          style={{
            flex: '0 0 auto',
            width: 34,
            height: 18,
            borderRadius: 9,
            background: harvest ? 'rgba(255,212,121,0.55)' : 'rgba(120,150,220,0.25)',
            position: 'relative',
            transition: 'background 120ms'
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: harvest ? 18 : 2,
              width: 14,
              height: 14,
              borderRadius: '50%',
              background: '#0b1326',
              transition: 'left 120ms'
            }}
          />
        </span>
      </button>

      <button
        onClick={toggleCmdtrail}
        title={t('settings.cmdtrail_tooltip')}
        style={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          gap: 10,
          marginBottom: 16,
          border: '1px solid ' + (cmdtrail ? 'rgba(122,162,255,0.45)' : 'rgba(120,150,220,0.2)'),
          background: cmdtrail ? 'rgba(122,162,255,0.1)' : 'rgba(8,12,26,0.35)',
          borderRadius: 10,
          padding: '8px 11px',
          cursor: 'pointer',
          textAlign: 'left'
        }}
      >
        <span style={{ fontSize: 14, color: cmdtrail ? '#7aa2ff' : '#6f84ad' }}>⌗</span>
        <span style={{ flex: '1 1 0', minWidth: 0 }}>
          <div style={{ fontSize: 12.5, color: '#dbe6ff', fontWeight: 600 }}>{t('settings.cmdtrail_title')}</div>
          <div style={{ fontSize: 10.5, color: '#6f84ad', lineHeight: 1.4 }}>
            {t('settings.cmdtrail_desc')}
          </div>
        </span>
        <span
          style={{
            flex: '0 0 auto',
            width: 34,
            height: 18,
            borderRadius: 9,
            background: cmdtrail ? 'rgba(122,162,255,0.55)' : 'rgba(120,150,220,0.25)',
            position: 'relative',
            transition: 'background 120ms'
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: cmdtrail ? 18 : 2,
              width: 14,
              height: 14,
              borderRadius: '50%',
              background: '#0b1326',
              transition: 'left 120ms'
            }}
          />
        </span>
      </button>

      <button
        onClick={toggleBacklog}
        title={t('settings.backlog_tooltip')}
        style={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          gap: 10,
          marginBottom: 16,
          border: '1px solid ' + (backlog ? 'rgba(122,162,255,0.45)' : 'rgba(120,150,220,0.2)'),
          background: backlog ? 'rgba(122,162,255,0.1)' : 'rgba(8,12,26,0.35)',
          borderRadius: 10,
          padding: '8px 11px',
          cursor: 'pointer',
          textAlign: 'left'
        }}
      >
        <span style={{ fontSize: 14, color: backlog ? '#7aa2ff' : '#6f84ad' }}>•</span>
        <span style={{ flex: '1 1 0', minWidth: 0 }}>
          <div style={{ fontSize: 12.5, color: '#dbe6ff', fontWeight: 600 }}>{t('settings.backlog_title')}</div>
          <div style={{ fontSize: 10.5, color: '#6f84ad', lineHeight: 1.4 }}>
            {t('settings.backlog_desc')}
          </div>
        </span>
        <span
          style={{
            flex: '0 0 auto',
            width: 34,
            height: 18,
            borderRadius: 9,
            background: backlog ? 'rgba(122,162,255,0.55)' : 'rgba(120,150,220,0.25)',
            position: 'relative',
            transition: 'background 120ms'
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: backlog ? 18 : 2,
              width: 14,
              height: 14,
              borderRadius: '50%',
              background: '#0b1326',
              transition: 'left 120ms'
            }}
          />
        </span>
      </button>

      <button
        onClick={toggleCatchup}
        title={t('settings.catchup_tooltip')}
        style={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          gap: 10,
          marginBottom: 16,
          border:
            '1px solid ' + (catchupEnabled ? 'rgba(242,168,75,0.45)' : 'rgba(120,150,220,0.2)'),
          background: catchupEnabled ? 'rgba(242,168,75,0.1)' : 'rgba(8,12,26,0.35)',
          borderRadius: 10,
          padding: '8px 11px',
          cursor: 'pointer',
          textAlign: 'left'
        }}
      >
        <span style={{ fontSize: 14, color: catchupEnabled ? '#f2a84b' : '#6f84ad' }}>↺</span>
        <span style={{ flex: '1 1 0', minWidth: 0 }}>
          <div style={{ fontSize: 12.5, color: '#dbe6ff', fontWeight: 600 }}>{t('settings.catchup_title')}</div>
          <div style={{ fontSize: 10.5, color: '#6f84ad', lineHeight: 1.4 }}>
            {t('settings.catchup_desc')}
          </div>
        </span>
        <span
          style={{
            flex: '0 0 auto',
            width: 34,
            height: 18,
            borderRadius: 9,
            background: catchupEnabled ? 'rgba(242,168,75,0.55)' : 'rgba(120,150,220,0.25)',
            position: 'relative',
            transition: 'background 120ms'
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: catchupEnabled ? 18 : 2,
              width: 14,
              height: 14,
              borderRadius: '50%',
              background: '#0b1326',
              transition: 'left 120ms'
            }}
          />
        </span>
      </button>

      <button
        onClick={toggleRecall}
        title={t('settings.recall_tooltip')}
        style={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          gap: 10,
          marginBottom: 16,
          border: '1px solid ' + (recall ? 'rgba(72,213,151,0.45)' : 'rgba(120,150,220,0.2)'),
          background: recall ? 'rgba(72,213,151,0.1)' : 'rgba(8,12,26,0.35)',
          borderRadius: 10,
          padding: '8px 11px',
          cursor: 'pointer',
          textAlign: 'left'
        }}
      >
        <span style={{ fontSize: 14, color: recall ? '#9af0c6' : '#6f84ad' }}>✦</span>
        <span style={{ flex: '1 1 0', minWidth: 0 }}>
          <div style={{ fontSize: 12.5, color: '#dbe6ff', fontWeight: 600 }}>{t('settings.recall_title')}</div>
          <div style={{ fontSize: 10.5, color: '#6f84ad', lineHeight: 1.4 }}>
            {t('settings.recall_desc')}
          </div>
        </span>
        <span
          style={{
            flex: '0 0 auto',
            width: 34,
            height: 18,
            borderRadius: 9,
            background: recall ? 'rgba(72,213,151,0.55)' : 'rgba(120,150,220,0.25)',
            position: 'relative',
            transition: 'background 120ms'
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: recall ? 18 : 2,
              width: 14,
              height: 14,
              borderRadius: '50%',
              background: '#0b1326',
              transition: 'left 120ms'
            }}
          />
        </span>
      </button>

      <button
        onClick={toggleSnap}
        title={t('settings.snap_tooltip')}
        style={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          gap: 10,
          marginBottom: 16,
          border: '1px solid ' + (snap ? 'rgba(90,209,232,0.45)' : 'rgba(120,150,220,0.2)'),
          background: snap ? 'rgba(90,209,232,0.1)' : 'rgba(8,12,26,0.35)',
          borderRadius: 10,
          padding: '8px 11px',
          cursor: 'pointer',
          textAlign: 'left'
        }}
      >
        <span style={{ fontSize: 14, color: snap ? '#5ad1e8' : '#6f84ad' }}>⌗</span>
        <span style={{ flex: '1 1 0', minWidth: 0 }}>
          <div style={{ fontSize: 12.5, color: '#dbe6ff', fontWeight: 600 }}>{t('settings.snap_title')}</div>
          <div style={{ fontSize: 10.5, color: '#6f84ad', lineHeight: 1.4 }}>
            {t('settings.snap_desc')}
          </div>
        </span>
        <span
          style={{
            flex: '0 0 auto',
            width: 34,
            height: 18,
            borderRadius: 9,
            background: snap ? 'rgba(90,209,232,0.55)' : 'rgba(120,150,220,0.25)',
            position: 'relative',
            transition: 'background 120ms'
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: snap ? 18 : 2,
              width: 14,
              height: 14,
              borderRadius: '50%',
              background: '#0b1326',
              transition: 'left 120ms'
            }}
          />
        </span>
      </button>

      <button
        onClick={away.toggle}
        title={t('settings.away_tooltip')}
        style={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          gap: 10,
          marginBottom: away.enabled ? 8 : 16,
          border: '1px solid ' + (away.enabled ? 'rgba(255,138,138,0.45)' : 'rgba(120,150,220,0.2)'),
          background: away.enabled ? 'rgba(255,138,138,0.1)' : 'rgba(8,12,26,0.35)',
          borderRadius: 10,
          padding: '8px 11px',
          cursor: 'pointer',
          textAlign: 'left'
        }}
      >
        <span style={{ fontSize: 14, color: away.enabled ? '#ff8a8a' : '#6f84ad' }}>🔔</span>
        <span style={{ flex: '1 1 0', minWidth: 0 }}>
          <div style={{ fontSize: 12.5, color: '#dbe6ff', fontWeight: 600 }}>{t('settings.away_title')}</div>
          <div style={{ fontSize: 10.5, color: '#6f84ad', lineHeight: 1.4 }}>
            {t('settings.away_desc')}
          </div>
        </span>
        <span
          style={{
            flex: '0 0 auto',
            width: 34,
            height: 18,
            borderRadius: 9,
            background: away.enabled ? 'rgba(255,138,138,0.55)' : 'rgba(120,150,220,0.25)',
            position: 'relative',
            transition: 'background 120ms'
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: away.enabled ? 18 : 2,
              width: 14,
              height: 14,
              borderRadius: '50%',
              background: '#0b1326',
              transition: 'left 120ms'
            }}
          />
        </span>
      </button>

      {away.enabled && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            marginBottom: 16,
            paddingLeft: 2
          }}
        >
          {(
            [
              { key: 'notifyWaiting', label: t('settings.away_waiting'), on: away.notifyWaiting, toggle: away.toggleWaiting },
              { key: 'notifyError', label: t('settings.away_error'), on: away.notifyError, toggle: away.toggleError },
              { key: 'notifyDone', label: t('settings.away_done'), on: away.notifyDone, toggle: away.toggleDone }
            ] as const
          ).map((c) => (
            <button
              key={c.key}
              onClick={c.toggle}
              style={{
                flex: '1 1 0',
                minWidth: 0,
                border: '1px solid ' + (c.on ? 'rgba(255,138,138,0.5)' : 'rgba(120,150,220,0.2)'),
                background: c.on ? 'rgba(255,138,138,0.14)' : 'transparent',
                color: c.on ? '#ffd0d0' : '#8fa3cc',
                borderRadius: 8,
                padding: '5px 6px',
                fontSize: 10.5,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      <Row label={t('settings.stt')} value={caps?.stt ? caps.sttBackend || '—' : t('settings.unavailable')} ok={!!caps?.stt} />
      <Row label={t('settings.stt_model')} value={caps?.modelReady ? t('settings.stt_ready') : t('settings.stt_not_downloaded')} ok={!!caps?.modelReady} />
      <Row
        label={t('settings.tts')}
        value={voiceNeuralAvail ? voiceLabel : `macOS say · ${VOICE_DISPLAY[lang].sayName}`}
        ok
      />
      <Row
        label={t('settings.neural_voice')}
        value={
          voiceNeuralAvail
            ? voiceLabel + (voiceReady ? '' : ` · ${t('settings.voice_on_demand')}`)
            : `macOS say · ${VOICE_DISPLAY[lang].sayName}`
        }
        ok={!voiceNeuralAvail || voiceReady}
      />

      {/* Per-language voice picker — applies immediately to "test voice" + the
          voice assistant. Hidden when no neural engine is available (only `say`). */}
      {(caps?.kokoro || caps?.piper) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', gap: 10 }}>
          <span style={{ color: '#9fb0d2', fontSize: 12 }}>{t('settings.voice_pick')}</span>
          <select
            value={chosenVoice}
            onChange={(e) => setVoice(lang, e.target.value)}
            style={{
              flex: '1 1 auto',
              maxWidth: 210,
              background: 'rgba(8,12,26,0.7)',
              border: '1px solid rgba(120,150,220,0.22)',
              borderRadius: 8,
              color: '#dbe6ff',
              padding: '6px 8px',
              fontSize: 12.5,
              outline: 'none'
            }}
          >
            {VOICE_CATALOG[lang].map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {caps && !caps.modelReady && (
        <button onClick={downloadModel} style={primaryBtn}>
          {t('settings.download_stt_model')} {pct != null ? `· ${pct}%` : ''}
        </button>
      )}

      <div style={{ marginTop: 14, marginBottom: 6, color: '#8fa3cc', fontSize: 12 }}>
        {t('settings.test_voice_heading', { lang: VOICE_DISPLAY[lang].native })}
      </div>
      <textarea
        value={testText}
        onChange={(e) => {
          setTestEdited(true)
          setTestText(e.target.value)
        }}
        rows={2}
        style={{
          width: '100%',
          background: 'rgba(8,12,26,0.7)',
          border: '1px solid rgba(120,150,220,0.16)',
          borderRadius: 8,
          color: '#dbe6ff',
          padding: 8,
          fontSize: 12.5,
          resize: 'none',
          outline: 'none'
        }}
      />
      <button onClick={test} disabled={speaking || preparing} style={primaryBtn}>
        {pct != null
          ? t('settings.downloading_voice', { pct })
          : preparing
            ? t('settings.loading_voice')
            : speaking
              ? t('settings.speaking')
              : t('settings.test_voice')}
      </button>

      <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(140,165,225,0.14)', fontSize: 11.5, color: '#6f84ad', lineHeight: 1.5 }}>
        {t('settings.ptt_hint', { space: t('settings.ptt_space') })
          .split(new RegExp(`(${t('settings.ptt_space')})`))
          .map((part, i) =>
            part === t('settings.ptt_space') ? (
              <b key={i} style={{ color: '#aebbd6' }}>
                {part}
              </b>
            ) : (
              part
            )
          )}
      </div>
    </div>
  )
}

function Row({ label, value, ok }: { label: string; value: string; ok?: boolean }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0' }}>
      <span style={{ color: '#9fb0d2' }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: ok ? '#48d597' : '#f2c84b' }} />
        {value}
      </span>
    </div>
  )
}

const bgThumbStyle: React.CSSProperties = {
  height: 52,
  borderRadius: 6,
  overflow: 'hidden',
  position: 'relative',
  background: '#0a0f1e'
}

function bgCardStyle(selected: boolean): React.CSSProperties {
  return {
    border: '1px solid ' + (selected ? 'rgba(120,160,255,0.6)' : 'rgba(120,150,220,0.2)'),
    borderRadius: 9,
    padding: 5,
    background: selected ? 'rgba(91,140,255,0.12)' : 'rgba(8,12,26,0.35)',
    cursor: 'pointer',
    outline: selected ? '2px solid rgba(120,160,255,0.33)' : 'none',
    textAlign: 'left'
  }
}

function bgLabelStyle(selected: boolean): React.CSSProperties {
  return {
    fontSize: 10.5,
    color: selected ? '#fff' : '#9fb0d2',
    marginTop: 4,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
  }
}

const primaryBtn: React.CSSProperties = {
  marginTop: 10,
  width: '100%',
  border: '1px solid rgba(120,160,255,0.35)',
  background: 'rgba(91,140,255,0.18)',
  color: '#cfe0ff',
  borderRadius: 9,
  padding: '8px 12px',
  fontSize: 13,
  fontWeight: 600
}
