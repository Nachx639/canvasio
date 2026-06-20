import { useMemo } from 'react'
import { useT } from '../store/i18n'
import { useCanvas } from '../store/canvas'
import { useEcho } from '../store/echo'
import { useReplay } from '../store/replay'
import { useDirector } from '../store/director'
import { useBacklog } from '../store/backlog'
import { countUnseen, agentsWithUnseen } from '../lib/backlog'

/**
 * Backlog chip — a compact "•N" badge on a terminal node's header showing how
 * many of THIS agent's meaningful output lines have landed since the last time
 * you looked at it (unseen activity). It answers the single most-asked multi-agent
 * question — "which agent did something worth seeing while my back was turned?" —
 * per node, at a glance.
 *
 * unseen = count of this node's Echo lines with ts > visits[nodeId].lastTs. A
 * never-visited node (no lastTs) counts ALL its lines. Clicking flies the camera
 * to the node via the existing centerOnNode, which BUMPS visits.lastTs — zeroing
 * the badge the instant you actually look. Pure renderer-side: it READS the Echo
 * ring + this node's visit watermark and CALLS centerOnNode — no new store state,
 * no IPC, no geometry mutation.
 *
 * Subscribes narrowly (this node's Echo ring + this node's visit entry) so it
 * re-renders only when this agent's unseen tally can change, and renders NOTHING
 * when N === 0 — a quiet / fully-seen node looks exactly as before.
 */
export function BacklogChip({ nodeId }: { nodeId: string }): JSX.Element | null {
  const t = useT()
  const ring = useEcho((s) => s.entries[nodeId])
  const visit = useCanvas((s) => s.visits[nodeId])
  const n = countUnseen(ring, visit?.lastTs ?? 0)
  if (n === 0) return null

  return (
    <span
      title={t(n === 1 ? 'app.backlog_lines_one' : 'app.backlog_lines_other', { n })}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        // Flying here bumps visits.lastTs at the centerOnNode chokepoint, which
        // zeroes this badge the moment the camera arrives.
        useCanvas.getState().centerOnNode(nodeId)
      }}
      style={{
        marginLeft: 2,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 10.5,
        lineHeight: 1,
        padding: '2px 6px',
        borderRadius: 6,
        cursor: 'pointer',
        color: '#cfe0ff',
        background: 'rgba(122,162,255,0.16)',
        border: '1px solid rgba(122,162,255,0.45)',
        flex: '0 0 auto',
        userSelect: 'none',
        fontVariantNumeric: 'tabular-nums'
      }}
    >
      <span aria-hidden style={{ fontWeight: 700 }}>•</span>
      <span style={{ fontWeight: 700 }}>{n}</span>
    </span>
  )
}

/**
 * Jump to the agent with the most unseen activity. Camera-only: resolves the peak
 * node (read-only over visits + echo) and flies there via the existing
 * centerOnNode, which bumps its lastTs and zeroes its backlog. No-op when nobody
 * has unseen activity. Shared by the TopBar chip, the Command Palette action, and
 * the App capture-phase hotkey so they can never diverge.
 */
export function jumpToBacklogPeak(): void {
  const peak = useBacklog.getState().peakNode()
  if (peak) useCanvas.getState().centerOnNode(peak)
}

/**
 * Backlog attention chip (TopBar) — a single glass pill showing the TOTAL unseen
 * lines across every agent ("•N sin ver" / "Al día"). It is the swarm-level
 * companion to the per-node "•N" badge: one glance tells you whether attention is
 * owed anywhere, and clicking jumps the camera straight to the agent that owes the
 * most (same march as the keyboard action).
 *
 * Read-only: subscribes to nodes + visits + every Echo ring and recomputes the
 * total locally so it tracks the badges exactly. Hidden while an auto-driven
 * camera (Replay/Director) owns the view so it never fights them — matching
 * TriageChip / PulseRadar.
 */
export function BacklogTopChip(): JSX.Element | null {
  const t = useT()
  const nodes = useCanvas((s) => s.nodes)
  const visits = useCanvas((s) => s.visits)
  const entries = useEcho((s) => s.entries)
  const replayArmed = useReplay((s) => s.armed)
  const directorArmed = useDirector((s) => s.armed)

  const agents = useMemo(() => {
    const ids = nodes.filter((n) => n.kind === 'terminal').map((n) => n.id)
    return agentsWithUnseen(ids, visits, entries)
  }, [nodes, visits, entries])

  if (replayArmed || directorArmed) return null

  const clear = agents === 0
  const accent = '#7aa2ff'
  const label = clear
    ? t('app.backlog_up_to_date')
    : t(agents === 1 ? 'app.backlog_agents_one' : 'app.backlog_agents_other', { n: agents })
  const tip = clear
    ? t('app.backlog_clear_tip')
    : t('app.backlog_pending_tip', { n: agents })

  return (
    <button
      className="no-drag"
      onClick={jumpToBacklogPeak}
      title={tip}
      aria-label={tip}
      style={{
        pointerEvents: 'auto',
        flex: '0 0 auto',
        borderRadius: 8,
        padding: '4px 9px',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        color: '#d7e1f7',
        cursor: clear ? 'default' : 'pointer',
        background: clear ? 'rgba(120,140,170,0.10)' : `${accent}1f`,
        opacity: clear ? 0.55 : 1,
        border: `1px solid ${clear ? 'rgba(120,140,170,0.22)' : `${accent}55`}`
      }}
    >
      <span
        aria-hidden
        style={{
          fontWeight: 800,
          fontSize: 12.5,
          color: clear ? '#9fb0c9' : accent
        }}
      >
        •
      </span>
      <span style={{ fontWeight: 700, color: clear ? '#9fb0c9' : accent, fontSize: 12.5 }}>
        {label}
      </span>
    </button>
  )
}
