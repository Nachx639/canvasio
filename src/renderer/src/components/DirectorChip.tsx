import { useCanvas } from '../store/canvas'
import { useDirector } from '../store/director'
import { useT } from '../store/i18n'
import { AGENT_COLOR } from './MissionLog'

/**
 * Director Mode HUD — a small glass "SIGUIENDO" chip (bottom-left) shown only
 * while Director is armed. It reads the followed node's title and accent color
 * so your eyes confirm the camera is locked onto the agent that just demanded
 * attention. Click it to disarm (yield the camera back to you).
 *
 * Purely renderer-side and additive: it READS the director/canvas stores and
 * CALLS director.disarm — no IPC, no geometry mutation, no persistence.
 */
export function DirectorChip(): JSX.Element | null {
  const armed = useDirector((s) => s.armed)
  const followingNodeId = useDirector((s) => s.followingNodeId)
  const node = useCanvas((s) => s.nodes.find((n) => n.id === followingNodeId) ?? null)
  const t = useT()

  if (!armed) return null

  const accent = node?.agent ? AGENT_COLOR[node.agent] : '#c77dff'
  const label = node?.title ?? t('directorChip.awaiting')

  return (
    <button
      className="glass no-drag"
      onClick={() => useDirector.getState().disarm()}
      title={t('directorChip.title')}
      aria-label={t('directorChip.aria_label')}
      style={{
        pointerEvents: 'auto',
        position: 'absolute',
        bottom: 22,
        left: 22,
        borderRadius: 12,
        padding: '8px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        color: '#d7e1f7',
        cursor: 'pointer',
        zIndex: 60,
        border: '1px solid rgba(199,125,255,0.32)'
      }}
    >
      {/* live pulsing dot */}
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: accent,
          boxShadow: `0 0 0 0 ${accent}`,
          animation: 'canvasio-director-pulse 1.6s ease-out infinite'
        }}
      />
      <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.12em', color: '#c77dff' }}>
        {t('directorChip.following')}
      </span>
      <span style={{ fontWeight: 700, color: accent, fontSize: 12.5 }}>{label}</span>
      <style>{`
        @keyframes canvasio-director-pulse {
          0%   { box-shadow: 0 0 0 0 ${accent}66; }
          70%  { box-shadow: 0 0 0 7px ${accent}00; }
          100% { box-shadow: 0 0 0 0 ${accent}00; }
        }
      `}</style>
    </button>
  )
}
