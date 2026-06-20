import { useReplay } from '../store/replay'
import { useT } from '../store/i18n'
import { AGENT_COLOR, KIND_META, phraseFor, relTime } from './MissionLog'

/**
 * Flight Recorder Replay transport — a bottom-center glass bar that appears only
 * while a replay is armed. It drives the cinematic playback of the Mission Pulse
 * timeline: the camera flies from event to event (camera-only, via the existing
 * centerOnNode tween) while a caption narrates the current frame and a scrubber
 * lets you scrub through the whole work session.
 *
 * Purely renderer-side and additive: it READS the replay store and CALLS its
 * actions. No IPC, no geometry mutation, no persistence.
 */
export function ReplayBar(): JSX.Element | null {
  const t = useT()
  const armed = useReplay((s) => s.armed)
  const isPlaying = useReplay((s) => s.isPlaying)
  const index = useReplay((s) => s.index)
  const speed = useReplay((s) => s.speed)
  const snapshot = useReplay((s) => s.snapshot)

  if (!armed || snapshot.length === 0) return null

  const total = snapshot.length
  const current = snapshot[Math.min(index, total - 1)]
  const meta = KIND_META[current.kind]
  const accent = current.agent ? AGENT_COLOR[current.agent] : '#7c97e0'
  const cycleSpeed = (): void => useReplay.getState().setSpeed(speed === 1 ? 2 : speed === 2 ? 4 : 1)

  return (
    <div
      className="glass no-drag"
      style={{
        pointerEvents: 'auto',
        position: 'absolute',
        bottom: 22,
        left: '50%',
        transform: 'translateX(-50%)',
        borderRadius: 14,
        padding: '12px 16px',
        width: 'min(560px, 84vw)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        color: '#d7e1f7',
        zIndex: 60
      }}
    >
      {/* caption: which event is "now playing" */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <span
          aria-hidden
          style={{ color: meta.color, fontWeight: 700, flexShrink: 0, width: 16, textAlign: 'center' }}
        >
          {meta.icon}
        </span>
        <span style={{ fontWeight: 700, color: accent, flexShrink: 0 }}>{current.title}</span>
        <span
          style={{
            fontSize: 12,
            color: '#aebbd6',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {phraseFor(current)}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: '#6f84ad', flexShrink: 0 }}>
          {relTime(current.ts, Date.now())}
        </span>
      </div>

      {/* scrubber over the whole timeline */}
      <input
        type="range"
        min={0}
        max={total - 1}
        step={1}
        value={Math.min(index, total - 1)}
        onChange={(e) => useReplay.getState().stepTo(Number(e.target.value))}
        aria-label={t('replayBar.timeline')}
        style={{ width: '100%', accentColor: accent, cursor: 'pointer' }}
      />

      {/* transport controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: '#8fa3cc', minWidth: 64 }}>
          {index + 1} / {total}
        </span>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '0 auto' }}>
          <TransportButton
            label={t('replayBar.prev_event')}
            onClick={() => useReplay.getState().prev()}
            disabled={index <= 0}
          >
            ◀◀
          </TransportButton>
          <TransportButton
            label={isPlaying ? t('replayBar.pause') : t('replayBar.play')}
            onClick={() => useReplay.getState().togglePlay()}
            primary
          >
            {isPlaying ? '❚❚' : '▶'}
          </TransportButton>
          <TransportButton
            label={t('replayBar.next_event')}
            onClick={() => useReplay.getState().next()}
            disabled={index >= total - 1}
          >
            ▶▶
          </TransportButton>
        </div>

        <button
          onClick={cycleSpeed}
          title={t('replayBar.playback_speed')}
          aria-label={t('replayBar.change_speed')}
          style={{
            background: 'rgba(91,140,255,0.14)',
            border: '1px solid rgba(120,150,220,0.22)',
            color: '#cfe0ff',
            borderRadius: 7,
            padding: '3px 9px',
            fontSize: 11.5,
            fontWeight: 700,
            cursor: 'pointer',
            minWidth: 38
          }}
        >
          {speed}x
        </button>

        <button
          onClick={() => useReplay.getState().stop()}
          title={t('replayBar.close_replay')}
          aria-label={t('replayBar.close_replay')}
          style={{
            background: 'transparent',
            border: '1px solid rgba(120,150,220,0.2)',
            color: '#8fa3cc',
            borderRadius: 7,
            padding: '3px 8px',
            fontSize: 11,
            cursor: 'pointer'
          }}
        >
          ✕
        </button>
      </div>
    </div>
  )
}

function TransportButton({
  children,
  label,
  onClick,
  disabled,
  primary
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  primary?: boolean
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      style={{
        width: primary ? 38 : 32,
        height: 30,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: primary ? 'var(--canvasio-accent, #5b8cff)' : 'rgba(8,12,26,0.55)',
        border: primary ? 'none' : '1px solid rgba(120,150,220,0.18)',
        color: primary ? '#0b1020' : '#cfe0ff',
        borderRadius: 8,
        fontSize: primary ? 12 : 11,
        fontWeight: 700,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1
      }}
    >
      {children}
    </button>
  )
}
