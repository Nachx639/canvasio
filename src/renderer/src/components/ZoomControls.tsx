import { useCanvas } from '../store/canvas'
import { useT } from '../store/i18n'

export function ZoomControls(): JSX.Element {
  const t = useT()
  const zoom = useCanvas((s) => s.camera.zoom)
  const fitToView = useCanvas((s) => s.fitToView)
  const resetZoom100 = useCanvas((s) => s.resetZoom100)

  const zoomBy = (f: number): void => {
    const cx = window.innerWidth / 2
    const cy = window.innerHeight / 2
    useCanvas.getState().zoomAt(cx, cy, f)
  }

  return (
    <div
      className="glass"
      style={{
        position: 'absolute',
        left: 16,
        bottom: 16,
        zIndex: 40,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: 4,
        borderRadius: 11
      }}
    >
      <button style={btn} onClick={() => zoomBy(120)} title={t('zoomControls.out')} aria-label={t('zoomControls.out')}>
        −
      </button>
      <button
        style={{ ...btn, width: 56, fontSize: 12, fontWeight: 600 }}
        onClick={() => fitToView()}
        title={t('zoomControls.fit')}
        aria-label={t('zoomControls.fit_aria', { pct: Math.round(zoom * 100) })}
      >
        {Math.round(zoom * 100)}%
      </button>
      <button style={btn} onClick={() => zoomBy(-120)} title={t('zoomControls.in')} aria-label={t('zoomControls.in')}>
        +
      </button>
      <button
        style={{ ...btn, marginLeft: 2 }}
        onClick={() => resetZoom100()}
        title={t('zoomControls.reset')}
        aria-label={t('zoomControls.reset')}
      >
        ⤢
      </button>
    </div>
  )
}

const btn: React.CSSProperties = {
  minWidth: 28,
  height: 28,
  display: 'grid',
  placeItems: 'center',
  border: 'none',
  background: 'transparent',
  color: '#cdd9f5',
  borderRadius: 7,
  fontSize: 16
}
