import { useTripwire } from '../store/tripwire'
import { useCanvas } from '../store/canvas'
import { AGENT_COLOR } from './MissionLog'
import { useT } from '../store/i18n'
import type { AgentKind } from '../store/canvas'

/**
 * Tripwire Toast — a non-stealing bottom-left glass card surfacing the most
 * recent UNSEEN tripwire hit: which agent printed it + the matched output line.
 * Click (or ⇧W) flies the camera to the firing node via centerOnNode and marks
 * the hit seen, so it disappears. Returns null when there is no unseen hit →
 * zero chrome on an idle canvas (mirrors StallWatchToast / HistoryToast).
 *
 * Purely renderer-side and additive: it READS the tripwire/canvas stores and
 * CALLS centerOnNode + markSeen — no IPC, no geometry mutation, no persistence.
 * Stacked just above the Stall Watch slot so the two watchdogs never overlap.
 */
export function TripwireToast(): JSX.Element | null {
  const t = useT()
  // Subscribe to the hit list so we re-render whenever a hit lands or is seen.
  const hits = useTripwire((s) => s.hits)

  // Newest unseen hit (scan from the end). Recomputed cheaply per render.
  let hit: (typeof hits)[number] | null = null
  for (let i = hits.length - 1; i >= 0; i--) {
    if (!hits[i].seen) {
      hit = hits[i]
      break
    }
  }
  if (!hit) return null

  const accent = hit.agent ? AGENT_COLOR[hit.agent as AgentKind] ?? '#f2c84b' : '#f2c84b'
  const unseenCount = hits.reduce((n, h) => (h.seen ? n : n + 1), 0)

  const jump = (): void => {
    useCanvas.getState().centerOnNode(hit!.nodeId)
    useTripwire.getState().markSeen(hit!.id)
  }

  return (
    <div
      className="glass no-drag watch-alert"
      role="status"
      aria-live="polite"
      onClick={jump}
      title={t('tripwireToast.jump_title')}
      style={{
        pointerEvents: 'auto',
        cursor: 'pointer',
        position: 'absolute',
        bottom: 132,
        left: 22,
        borderRadius: 12,
        padding: '10px 12px',
        minWidth: 252,
        maxWidth: 360,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        color: '#efe6cf',
        zIndex: 61,
        border: '1px solid rgba(242,200,75,0.4)'
      }}
    >
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: '#f2c84b',
            animation: 'canvasio-tripwire-pulse 1.4s ease-out infinite'
          }}
        />
        <span
          style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.12em', color: '#f2c84b' }}
        >
          TRIPWIRE
        </span>
        {unseenCount > 1 && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: '#0c0f14',
              background: '#f2c84b',
              borderRadius: 8,
              padding: '1px 6px'
            }}
          >
            +{unseenCount - 1}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: '#b9a877' }}>{t('tripwireToast.hint')}</span>
      </div>

      {/* firing agent + matched line */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span
          aria-hidden
          style={{ width: 7, height: 7, borderRadius: '50%', background: accent, flex: '0 0 auto' }}
        />
        <span
          style={{
            fontWeight: 700,
            color: accent,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: 150
          }}
        >
          {hit.title}
        </span>
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: '#e7ddc4',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          lineHeight: 1.4,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical'
        }}
      >
        {hit.line}
      </div>

      <style>{`
        @keyframes canvasio-tripwire-pulse {
          0%   { box-shadow: 0 0 0 0 #f2c84b66; }
          70%  { box-shadow: 0 0 0 7px #f2c84b00; }
          100% { box-shadow: 0 0 0 0 #f2c84b00; }
        }
      `}</style>
    </div>
  )
}
