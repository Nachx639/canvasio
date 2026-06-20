import { useCanvas, getCameraNav } from '../store/canvas'
import { useT } from '../store/i18n'

/**
 * Slipstream — a tiny glass pair of Back/Forward arrows (‹ ›) that fly the camera
 * through its navigation history, exactly like a browser's Back/Forward buttons.
 * Sits just to the right of ZoomControls (bottom-left).
 *
 * It reads availability from the module-scope camera history via getCameraNav(),
 * re-rendering whenever `histTick` bumps (every push/traverse). CAMERA-ONLY:
 * every action only tweens the camera — it never mutates node/shape geometry or
 * touches IPC. The whole control is hidden until at least two vantage points
 * exist (one Back is possible), so it adds no chrome until the feature is used —
 * matching the WaypointRail "no chrome when unused" convention.
 */
export function SlipstreamNav(): JSX.Element | null {
  // Subscribe to histTick so the disabled/visible state updates on every
  // push/traverse (the actual stack lives at module scope in canvas.ts).
  useCanvas((s) => s.histTick)
  const t = useT()
  const cameraBack = useCanvas((s) => s.cameraBack)
  const cameraForward = useCanvas((s) => s.cameraForward)

  const { canBack, canForward, length } = getCameraNav()

  // No chrome until there's somewhere to go back to.
  if (length < 2) return null

  return (
    <div className="slipstream glass no-drag" role="navigation" aria-label={t('slipstream.history_aria')}>
      <button
        type="button"
        className="slipstream-btn"
        onClick={() => cameraBack()}
        disabled={!canBack}
        aria-disabled={!canBack}
        title={t('slipstream.back_title')}
        aria-label={t('slipstream.back_aria')}
      >
        ‹
      </button>
      <button
        type="button"
        className="slipstream-btn"
        onClick={() => cameraForward()}
        disabled={!canForward}
        aria-disabled={!canForward}
        title={t('slipstream.forward_title')}
        aria-label={t('slipstream.forward_aria')}
      >
        ›
      </button>
    </div>
  )
}
