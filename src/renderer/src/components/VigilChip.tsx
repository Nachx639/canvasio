import { useCanvas, AGENT_LABEL } from '../store/canvas'
import { useT } from '../store/i18n'

/**
 * Vigil Chip — the live readout for the Follow-Cam auto-pilot.
 *
 * CanvasIO's nav suite has plenty of one-shot camera jumps (Thermal flyToHottest,
 * Triage cycleAttention, JumpHints, Beacon) and PAST replays (Flight Recorder /
 * Chronoscope), but nothing that keeps the camera on whatever agent is hottest
 * RIGHT NOW. Vigil ('v') is that missing live counterpart: a hands-free auto-pilot
 * that gently flies to the currently hottest node (via the SAME computeHeat +
 * hottestNodeId the Thermal overlay/Minimap already use) and re-targets on its own
 * as the swarm's focus shifts.
 *
 * This chip is renderer-ONLY and owns NO timers of its own — the auto-pilot lives
 * in canvas.ts (vigilTick). It renders NOTHING when vigilOn is false (zero chrome
 * when inactive, the project convention every overlay follows); when on, it shows a
 * small glass pill ("Vigil • siguiendo {agentLabel}") with a pulse dot and a
 * click-to-stop, reading vigilOn + the current follow target from the store.
 */
const ACCENT = '#7dd3fc' // sky — distinct from Thermal's warm glow

export function VigilChip(): JSX.Element | null {
  const t = useT()
  const vigilOn = useCanvas((s) => s.vigilOn)
  const targetId = useCanvas((s) => s.vigilTargetId)
  // Subscribe to nodes so the label re-derives if the target's title changes.
  const nodes = useCanvas((s) => s.nodes)

  // Zero chrome when the auto-pilot is off (the convention every overlay follows).
  if (!vigilOn) return null

  // Human label for the follow target: its title (falling back to the persona).
  const target = targetId ? nodes.find((x) => x.id === targetId) : undefined
  const label = target
    ? target.title || (target.agent ? AGENT_LABEL[target.agent].title : t('vigilChip.agent_fallback'))
    : null
  const stop = (): void => {
    useCanvas.getState().toggleVigil()
  }

  return (
    <div
      className="no-drag"
      role="status"
      aria-live="polite"
      aria-label={t('vigilChip.region_label')}
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        bottom: 140,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        justifyContent: 'center',
        zIndex: 60
      }}
    >
      <button
        className="glass no-drag"
        onClick={stop}
        title={t('vigilChip.button_title')}
        aria-label={
          label
            ? t('vigilChip.button_label_following', { label })
            : t('vigilChip.button_label_searching')
        }
        style={{
          pointerEvents: 'auto',
          borderRadius: 12,
          padding: '7px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          color: '#eaf6ff',
          cursor: 'pointer',
          border: `1px solid ${ACCENT}55`
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: ACCENT,
            boxShadow: `0 0 0 0 ${ACCENT}`,
            animation: 'canvasio-vigil-pulse 1.6s ease-out infinite'
          }}
        />
        <span
          style={{ fontSize: 11.5, fontWeight: 700, color: '#bcdcf0', letterSpacing: '0.02em' }}
        >
          Vigil
        </span>
        {label ? (
          <>
            <span aria-hidden style={{ fontSize: 11, color: '#88a6b8' }}>
              {t('vigilChip.following')}
            </span>
            <span style={{ fontWeight: 800, color: ACCENT, fontSize: 12.5 }}>{label}</span>
          </>
        ) : (
          <span style={{ fontSize: 11, color: '#88a6b8' }}>{t('vigilChip.searching')}</span>
        )}
        <style>{`
          @keyframes canvasio-vigil-pulse {
            0%   { box-shadow: 0 0 0 0 ${ACCENT}66; }
            70%  { box-shadow: 0 0 0 7px ${ACCENT}00; }
            100% { box-shadow: 0 0 0 0 ${ACCENT}00; }
          }
        `}</style>
      </button>
    </div>
  )
}
