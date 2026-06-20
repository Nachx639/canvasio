import { useRef } from 'react'
import { useCanvas, AGENT_LABEL } from '../store/canvas'
import { useRelay } from '../store/relay'
import { useReplay } from '../store/replay'
import { useDirector } from '../store/director'
import { useT, t } from '../store/i18n'

/**
 * Critical Path Chip — Live Relay Dependency & Bottleneck Intelligence.
 *
 * Every other agent-intelligence surface reasons about agents in ISOLATION (Lens,
 * Pulse, Thermal, Objectives) or about one PAIRWISE file conflict (Collision
 * Watch). This is the first surface that reads the TRANSITIVE dependency structure
 * of a multi-agent mission: the relay graph already encodes "Tester only starts
 * after Coder finishes" (sourceId -> targetId), and this chip reads it LIVE against
 * node.status to answer the operator's recurring question — "what is everyone
 * waiting on, and which single agent is the bottleneck holding up the rest?".
 *
 * It is a calm chip rail (bottom-center, stacked beside CollisionWatch) that
 * appears ONLY when one or more agents are blocked: "⏳ N agentes esperan a <name>".
 * Clicking it flies the camera along the critical dependency chain through the
 * bottleneck (the agent the most pending work hangs on).
 *
 * 100% DERIVED from already-in-memory relay rules + canvas statuses via the pure
 * useRelay.criticalPath() selector (no new state, no IPC, no main-process change).
 * Renders NOTHING when nothing is blocked (zero chrome when unused, the convention
 * every overlay follows). CAMERA/RENDERER-ONLY: it only ever calls centerOnNode —
 * never mutates node/shape geometry. Hidden while an auto-driven camera
 * (Replay/Director) owns the view so it never fights them, matching CollisionWatch.
 */
const VIOLET = '#9b8cff'

/** Human label for a node id: its title (falling back to the agent persona). */
function nodeLabel(nodeId: string): string {
  const n = useCanvas.getState().nodes.find((x) => x.id === nodeId)
  if (!n) return nodeId
  return n.title || (n.agent ? AGENT_LABEL[n.agent].title : t('criticalPathChip.agent_fallback'))
}

export function CriticalPathChip(): JSX.Element | null {
  const t = useT()
  // Subscribe to the inputs criticalPath() reads (relay rules + canvas nodes/
  // statuses) so the rail re-derives whenever the graph or any status changes.
  const rules = useRelay((s) => s.rules)
  const nodes = useCanvas((s) => s.nodes)
  const centerOnNode = useCanvas((s) => s.centerOnNode)
  const replayArmed = useReplay((s) => s.armed)
  const directorArmed = useDirector((s) => s.armed)

  // Pure derived readout (memo-guarded inside the store for a stable reference).
  // The rules/nodes subscriptions above are what trigger the re-render; the
  // selector then recomputes off the live state.
  void rules
  void nodes
  const cp = useRelay.getState().criticalPath()

  // Index into the critical chain for click-to-cycle (mirrors CollisionWatch's
  // Enter-cycle: -1 means "next click starts at the first node, the bottleneck").
  const cycleRef = useRef<number>(-1)

  // Hidden while an auto-driven camera owns the view (mirrors CollisionWatch).
  if (replayArmed || directorArmed) return null
  // Zero chrome when nothing is blocked (the convention every overlay follows).
  if (!cp.blocked.length) return null

  const n = cp.blocked.length
  const bottleneckId = cp.bottleneckId
  // Precision-over-recall: with no unambiguous bottleneck we still report the
  // blocked count but cycle across the blocked agents themselves.
  const cycleIds = cp.chain.length ? cp.chain : cp.blocked.map((b) => b.nodeId)
  const headName = bottleneckId ? nodeLabel(bottleneckId) : nodeLabel(cycleIds[0])

  const tooltip = bottleneckId
    ? t('criticalPathChip.tooltip_bottleneck', {
        n,
        headName,
        held: cp.bottleneckHeld,
        chain: cp.chain.map(nodeLabel).join(' → ')
      })
    : t('criticalPathChip.tooltip_waiting', { n })

  const cycle = (): void => {
    if (!cycleIds.length) return
    const next = (cycleRef.current + 1) % cycleIds.length
    cycleRef.current = next
    centerOnNode(cycleIds[next])
  }

  return (
    <div
      className="no-drag"
      role="list"
      aria-label={t('criticalPathChip.rail_aria')}
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        bottom: 64,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: 8,
        maxWidth: '80vw',
        zIndex: 60
      }}
    >
      <button
        className="glass no-drag"
        onClick={cycle}
        title={tooltip}
        aria-label={
          bottleneckId
            ? t('criticalPathChip.button_aria_bottleneck', { n, headName })
            : t('criticalPathChip.button_aria', { n })
        }
        style={{
          pointerEvents: 'auto',
          borderRadius: 12,
          padding: '7px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          color: '#e7e2ff',
          cursor: 'pointer',
          border: `1px solid ${VIOLET}55`
        }}
      >
        <span aria-hidden style={{ fontSize: 12.5 }}>
          ⏳
        </span>
        <span style={{ fontWeight: 800, color: VIOLET, fontSize: 12.5 }}>{n}</span>
        <span
          style={{ fontSize: 11.5, fontWeight: 700, color: '#c7c0ea', letterSpacing: '0.02em' }}
        >
          {bottleneckId ? headName : t('criticalPathChip.blocked')}
        </span>
      </button>
    </div>
  )
}
