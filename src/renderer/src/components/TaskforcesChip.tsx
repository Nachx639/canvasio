import { useMemo } from 'react'
import { useCanvas, AGENT_LABEL } from '../store/canvas'
import { useEcho } from '../store/echo'
import { useBoard } from '../store/board'
import { useRelay } from '../store/relay'
import { useReplay } from '../store/replay'
import { useDirector } from '../store/director'
import { useTaskforces } from '../store/taskforces'
import { useT } from '../store/i18n'

/**
 * Taskforces Chip — Live Semantic Auto-Grouping of Agents by What They're Working On.
 *
 * Every OTHER grouping surface clusters agents by something OTHER than what they
 * are actually doing: Districts cluster by relay connectivity + spatial proximity,
 * Critical Path reasons over the relay DAG, Consensus over agreement of pinned
 * values, and multi-select / groups / regions are manual. NONE groups agents by
 * the SUBJECT they are independently converging on RIGHT NOW.
 *
 * This chip folds the discoveries agents are ALREADY emitting (their recent Echo
 * lines + Brief Board facts) through the SAME deterministic consensus.subjectKey
 * vocabulary and surfaces the top live taskforce as a calm bottom-center pill:
 * "🧭 Taskforce: auth · 3". When ≥2 agents work the same subject with NO armed
 * relay edge linking them, it adds a redundancy badge ("possible duplicated
 * effort") — the single highest-waste failure mode in a free-form swarm (three
 * agents silently re-deriving the same API base). Clicking flies the camera to
 * frame the whole taskforce, reusing the existing centerOnBounds tween Districts use.
 *
 * 100% DERIVED from already-in-memory Echo/Board/Relay/Canvas state via the pure
 * useTaskforces.getTaskforces() selector (no new persistent state, no IPC, no
 * main-process change). Renders NOTHING when no taskforce exists (zero chrome when
 * unused, the convention every overlay follows). CAMERA-ONLY: frameTaskforce only
 * ever calls centerOnBounds/centerOnNode — never mutates node/shape geometry.
 * Hidden while an auto-driven camera (replay/director) owns the view so it never
 * fights them, matching CriticalPathChip.
 */
const TEAL = '#4fd1c5'
const AMBER = '#f0a868'

/** Human label for a node id: its title (falling back to the agent persona). */
function nodeLabel(nodeId: string, fallback: string): string {
  const n = useCanvas.getState().nodes.find((x) => x.id === nodeId)
  if (!n) return nodeId
  return n.title || (n.agent ? AGENT_LABEL[n.agent].title : fallback)
}

export function TaskforcesChip(): JSX.Element | null {
  const t = useT()
  // Subscribe to every input getTaskforces() reads so the chip re-derives live
  // whenever output, facts, the relay graph, or the node set changes.
  const nodes = useCanvas((s) => s.nodes)
  const echo = useEcho((s) => s.entries)
  const facts = useBoard((s) => s.facts)
  const rules = useRelay((s) => s.rules)
  const replayArmed = useReplay((s) => s.armed)
  const directorArmed = useDirector((s) => s.armed)

  // Re-derive whenever any input changes. getTaskforces() reads every store
  // lazily; the subscriptions above are what trigger the recompute.
  const taskforces = useMemo(
    () => useTaskforces.getState().getTaskforces(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, echo, facts, rules]
  )

  // Hidden while an auto-driven camera owns the view (mirrors CriticalPathChip).
  if (replayArmed || directorArmed) return null
  // Zero chrome when no taskforce exists (the convention every overlay follows).
  if (!taskforces.length) return null

  // Top taskforce: computeTaskforces already sorts redundant (actionable) first.
  const tf = taskforces[0]
  const accent = tf.redundant ? AMBER : TEAL
  const names = tf.nodeIds.map((id) => nodeLabel(id, t('taskforcesChip.agent_fallback')))
  const tooltip = tf.redundant
    ? t('taskforcesChip.tooltip_redundant', { subject: tf.subject, names: names.join(', ') })
    : t('taskforcesChip.tooltip_collab', { subject: tf.subject, names: names.join(', ') })

  const frame = (): void => {
    useTaskforces.getState().frameTaskforce(tf.nodeIds)
  }

  return (
    <div
      className="no-drag"
      role="list"
      aria-label={t('taskforcesChip.list_aria')}
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        bottom: 100,
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
        onClick={frame}
        title={tooltip}
        aria-label={t('taskforcesChip.button_aria', {
          subject: tf.subject,
          count: tf.nodeIds.length,
          dup: tf.redundant ? t('taskforcesChip.button_aria_dup') : ''
        })}
        style={{
          pointerEvents: 'auto',
          borderRadius: 12,
          padding: '7px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          color: '#e6fffb',
          cursor: 'pointer',
          border: `1px solid ${accent}55`
        }}
      >
        <span aria-hidden style={{ fontSize: 12.5 }}>
          🧭
        </span>
        <span
          style={{ fontSize: 11.5, fontWeight: 700, color: '#bdeee8', letterSpacing: '0.02em' }}
        >
          Taskforce:
        </span>
        <span style={{ fontWeight: 800, color: accent, fontSize: 12.5 }}>{tf.subject}</span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 800,
            color: '#0b1f1d',
            background: accent,
            borderRadius: 8,
            padding: '1px 6px'
          }}
        >
          {tf.nodeIds.length}
        </span>
        {tf.redundant && (
          <span
            aria-hidden
            title={t('taskforcesChip.dup_badge_title')}
            style={{
              fontSize: 10.5,
              fontWeight: 800,
              color: AMBER,
              border: `1px solid ${AMBER}66`,
              borderRadius: 8,
              padding: '1px 6px',
              letterSpacing: '0.02em'
            }}
          >
            ⚠ dup
          </span>
        )}
      </button>
    </div>
  )
}
