import { useCanvas } from '../store/canvas'
import { useTour, DWELL_OPTIONS, type DwellMs } from '../store/tour'
import { useT } from '../store/i18n'

/**
 * Grand Tour transport — a bottom-center glass bar shown only while a tour is
 * armed (returns null otherwise, per the project's "no chrome until used"
 * convention). It drives the hands-free, looping presentation of your saved
 * Waypoints: the camera flies stop -> stop (camera-only, via goWaypoint's eased
 * tween) while this shows the current stop + lets you pause, step, and tune the
 * dwell time.
 *
 * Purely renderer-side and additive: it READS the tour/canvas stores and CALLS
 * their actions. No IPC, no geometry mutation, no persistence.
 */
export function TourBar(): JSX.Element | null {
  const armed = useTour((s) => s.armed)
  const paused = useTour((s) => s.paused)
  const index = useTour((s) => s.index)
  const dwellMs = useTour((s) => s.dwellMs)
  const waypoints = useCanvas((s) => s.waypoints)
  const t = useT()

  if (!armed) return null

  const total = waypoints.length
  const current = waypoints[Math.min(index, Math.max(0, total - 1))]
  const cycleDwell = (): void => {
    const i = DWELL_OPTIONS.indexOf(dwellMs)
    const nextMs = DWELL_OPTIONS[(i + 1) % DWELL_OPTIONS.length] as DwellMs
    useTour.getState().setDwell(nextMs)
  }

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
        padding: '10px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        color: '#d7e1f7',
        zIndex: 60
      }}
    >
      <span aria-hidden style={{ fontSize: 14 }}>
        🎬
      </span>
      <span style={{ fontSize: 11, color: '#8fa3cc', minWidth: 52 }}>
        Tour {Math.min(index + 1, total)} / {total}
      </span>
      {current && (
        <span
          style={{
            fontWeight: 700,
            color: '#cfe0ff',
            maxWidth: 160,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {current.name}
        </span>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <TourButton label={t('tourBar.previous')} onClick={() => useTour.getState().prev()}>
          ‹
        </TourButton>
        <TourButton
          label={paused ? t('tourBar.resume') : t('tourBar.pause')}
          onClick={() => useTour.getState().togglePause()}
          primary
        >
          {paused ? '▶' : '❚❚'}
        </TourButton>
        <TourButton label={t('tourBar.next')} onClick={() => useTour.getState().next()}>
          ›
        </TourButton>
      </div>

      <button
        onClick={cycleDwell}
        title={t('tourBar.dwell_time')}
        aria-label={t('tourBar.change_dwell_time')}
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
        {Math.round(dwellMs / 1000)}s
      </button>

      <button
        onClick={() => useTour.getState().stop()}
        title={t('tourBar.close_tour')}
        aria-label={t('tourBar.close_tour')}
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
  )
}

function TourButton({
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
        fontSize: primary ? 12 : 14,
        fontWeight: 700,
        cursor: 'pointer'
      }}
    >
      {children}
    </button>
  )
}
