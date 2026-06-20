import { useEffect, useMemo } from 'react'
import { useTimefold } from '../store/timefold'
import { useEcho } from '../store/echo'
import { useMission } from '../store/mission'
import { eventTicks } from '../lib/timefold'
import { useT } from '../store/i18n'

/**
 * Timefold transport — a bottom-center glass scrubber that appears ONLY while the
 * time machine is armed (no chrome when unused, matching ReplayBar/WaypointRail).
 * Dragging the playhead rewinds the ENTIRE canvas to a past wall-clock instant;
 * every in-world terminal then renders a frozen "as-of T" overlay (NodeView). A
 * row of faint tick marks shows where real events happened; ◀/▶ (and ←/→) hop
 * between them; Esc snaps back to live.
 *
 * Purely renderer-side and additive: it READS the timefold store + the Echo /
 * Mission substrates (for tick positions) and CALLS store actions. No IPC, no
 * geometry mutation, no persistence.
 */
export function TimefoldBar(): JSX.Element | null {
  const t_ = useT()
  const armed = useTimefold((s) => s.armed)
  const t = useTimefold((s) => s.t)
  const range = useTimefold((s) => s.range)
  // Subscribe to the substrates so the tick row + bounds stay current if data is
  // appended while armed (rare, but harmless — the range itself is snapshot at arm).
  const echo = useEcho((s) => s.entries)
  const events = useMission((s) => s.events)

  const ticks = useMemo(() => eventTicks(echo, events), [echo, events])

  // Capture-phase keydown so app/global shortcuts don't fire while scrubbing
  // (mirrors Chronoscope / ChangesetLens capture-phase ownership). Left/Right hop
  // ticks, Escape disarms.
  useEffect(() => {
    if (!armed) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        e.stopPropagation()
        useTimefold.getState().stepTick(-1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        e.stopPropagation()
        useTimefold.getState().stepTick(1)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        useTimefold.getState().disarm()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [armed])

  if (!armed || !range || t == null) return null

  const span = Math.max(1, range.maxTs - range.minTs)
  const frac = (t - range.minTs) / span
  const atLive = range.maxTs - t < 1500 // within ~1.5s of the live edge
  const clock = new Date(t).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  const accent = '#7c97e0'

  return (
    <div
      className="timefold-bar glass no-drag"
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
        zIndex: 61
      }}
    >
      {/* caption: the frozen wall-clock moment */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <span aria-hidden style={{ color: accent, fontWeight: 700, flexShrink: 0, width: 16, textAlign: 'center' }}>
          ⏳
        </span>
        <span style={{ fontWeight: 700, color: '#eaf1ff', flexShrink: 0 }}>Timefold</span>
        <span
          style={{
            fontSize: 12,
            color: '#aebbd6',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {atLive ? t_('timefoldBar.live_hint') : t_('timefoldBar.frozen_hint')}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 12,
            fontWeight: 700,
            color: atLive ? '#48d597' : accent,
            flexShrink: 0,
            fontVariantNumeric: 'tabular-nums'
          }}
        >
          {atLive ? t_('timefoldBar.now') : clock}
        </span>
      </div>

      {/* scrubber over the whole wall-clock span, with event tick marks behind it */}
      <div style={{ position: 'relative', height: 18, display: 'flex', alignItems: 'center' }}>
        <div
          aria-hidden
          style={{ position: 'absolute', inset: '0 2px', pointerEvents: 'none' }}
        >
          {ticks.map((tick, i) => {
            const left = ((tick - range.minTs) / span) * 100
            if (left < 0 || left > 100) return null
            return (
              <span
                key={i}
                className="timefold-tick"
                style={{ left: `${left}%` }}
              />
            )
          })}
        </div>
        <input
          type="range"
          min={range.minTs}
          max={range.maxTs}
          step={1}
          value={t}
          onChange={(e) => useTimefold.getState().setT(Number(e.target.value))}
          aria-label={t_('timefoldBar.scrubber_aria')}
          style={{ position: 'relative', width: '100%', accentColor: accent, cursor: 'pointer' }}
        />
      </div>

      {/* transport: tick-step, frame-past, close */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: '#8fa3cc', minWidth: 64, fontVariantNumeric: 'tabular-nums' }}>
          {Math.round(frac * 100)}%
        </span>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '0 auto' }}>
          <FoldButton label={t_('timefoldBar.prev_event')} onClick={() => useTimefold.getState().stepTick(-1)}>
            ◀◀
          </FoldButton>
          <FoldButton label={t_('timefoldBar.frame_past')} onClick={() => useTimefold.getState().framePast()} primary>
            ⤢
          </FoldButton>
          <FoldButton label={t_('timefoldBar.next_event')} onClick={() => useTimefold.getState().stepTick(1)}>
            ▶▶
          </FoldButton>
        </div>

        <button
          onClick={() => useTimefold.getState().disarm()}
          title={t_('timefoldBar.back_to_present')}
          aria-label={t_('timefoldBar.back_to_present')}
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

function FoldButton({
  children,
  label,
  onClick,
  primary
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
  primary?: boolean
}): JSX.Element {
  return (
    <button
      onClick={onClick}
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
        fontSize: primary ? 13 : 11,
        fontWeight: 700,
        cursor: 'pointer'
      }}
    >
      {children}
    </button>
  )
}
