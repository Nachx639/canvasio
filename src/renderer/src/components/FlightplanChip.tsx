import { useMemo, useState } from 'react'
import { useCanvas, AGENT_LABEL, type CanvasNode } from '../store/canvas'
import { useChangeset } from '../store/changeset'
import { useBoard } from '../store/board'
import { useReplay } from '../store/replay'
import { useDirector } from '../store/director'
import { useFlightplan } from '../store/flightplan'
import { basename, type FlightConflict } from '../lib/flightplan'
import { useT } from '../store/i18n'

/**
 * Flightplan Chip — Pre-Flight Conflict Radar.
 *
 * The first FORWARD-LOOKING cross-agent surface. Every other relationship surface
 * is REACTIVE — CollisionWatch fires only after two agents already saved edits to
 * the same file, consensus surfaces a contradiction only after both pinned
 * conflicting facts, taskforces flags redundant effort only after both output
 * overlapping subjects. Flightplan reasons at the one moment prevention is free:
 * the instant a new agent is handed a task but BEFORE it touches anything.
 *
 * It reads the most-recently-spawned, STILL-IDLE terminal node's task text
 * (its pendingPrompt / objective — already on the node) and calls
 * useFlightplan.getFlightplan, which cross-references the task's implied paths /
 * subjects against every live agent's actual Changeset dirty files + Brief Board
 * subjects. For each predicted overlap it shows one calm chip
 * "⚠ overlaps with <incumbent> · <area>" with two one-key actions: "stage behind"
 * (auto-wire a relay handoff so the new agent waits for the incumbent) and dismiss.
 *
 * 100% DERIVED from already-in-memory Changeset/Board/Canvas state via the pure
 * useFlightplan.getFlightplan() selector (no new persistent state, no IPC, no
 * main-process change). Renders NOTHING when there is no idle new node or no
 * predicted overlap (zero chrome when unused, the convention every overlay
 * follows). The chip auto-clears once the new node leaves 'idle' (it has started
 * working) so it never lingers. CAMERA-ONLY: it only ever calls centerOnNode —
 * never mutates node/shape geometry. Hidden while an auto-driven camera
 * (Replay/Director) owns the view so it never fights them, matching CollisionWatch.
 */
const AMBER = '#f0b429'

/** Human label for a node: its title, falling back to the agent persona. */
function labelOf(n: CanvasNode): string {
  return n.title || (n.agent ? AGENT_LABEL[n.agent].title : 'Agente')
}

/**
 * Pick the "new" node to pre-flight: the most-recently-raised (highest z),
 * STILL-IDLE terminal that carries a task (pendingPrompt or an objective). Idle is
 * the pre-flight window — once it starts working the chip auto-clears. Returns null
 * when no such node exists (then the chip renders nothing). Pure over its input.
 */
function pickNewNode(nodes: CanvasNode[]): { node: CanvasNode; task: string } | null {
  let best: CanvasNode | null = null
  for (const n of nodes) {
    if (n.kind !== 'terminal') continue
    // Pre-flight window: the agent hasn't started working yet.
    if (n.status && n.status !== 'idle') continue
    const task = (n.pendingPrompt || n.objective?.text || '').trim()
    if (!task) continue
    if (!best || n.z > best.z) best = n
  }
  if (!best) return null
  return { node: best, task: (best.pendingPrompt || best.objective?.text || '').trim() }
}

/** One amber pre-flight chip. "stage behind" wires a relay handoff; "✕" dismisses. */
function FlightChip({
  conflict,
  newNodeId,
  onDismiss
}: {
  conflict: FlightConflict
  newNodeId: string
  onDismiss: () => void
}): JSX.Element {
  const t = useT()
  const centerOnNode = useCanvas((s) => s.centerOnNode)
  const stageBehind = useFlightplan((s) => s.stageBehind)
  const [staged, setStaged] = useState(false)

  const area =
    conflict.kind === 'path'
      ? basename(conflict.detail) || conflict.detail
      : conflict.detail
  const tooltip =
    conflict.kind === 'path'
      ? t('flightplanChip.tooltip_path', { title: conflict.title, detail: conflict.detail })
      : t('flightplanChip.tooltip_subject', { title: conflict.title, detail: conflict.detail })

  const stage = (): void => {
    if (staged) return
    if (stageBehind(newNodeId, conflict.nodeId)) setStaged(true)
  }

  return (
    <div
      className="glass no-drag"
      role="listitem"
      title={tooltip}
      style={{
        pointerEvents: 'auto',
        borderRadius: 12,
        padding: '6px 8px 6px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        color: '#f5e6c8',
        border: `1px solid ${AMBER}55`
      }}
    >
      <span aria-hidden style={{ fontSize: 12.5 }}>
        ⚠
      </span>
      <button
        className="no-drag"
        onClick={() => centerOnNode(conflict.nodeId)}
        title={t('flightplanChip.go_to', { title: conflict.title })}
        aria-label={t('flightplanChip.overlap_aria', { title: conflict.title, area })}
        style={{
          pointerEvents: 'auto',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: 0,
          color: 'inherit'
        }}
      >
        <span style={{ fontSize: 11.5, fontWeight: 700, color: '#d9c7a0', letterSpacing: '0.02em' }}>
          {t('flightplanChip.overlaps_with')}
        </span>
        <span style={{ fontWeight: 800, color: AMBER, fontSize: 12.5 }}>{conflict.title}</span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 800,
            color: '#0b0a06',
            background: AMBER,
            borderRadius: 8,
            padding: '1px 6px'
          }}
        >
          {area}
        </span>
      </button>
      <button
        className="no-drag"
        onClick={stage}
        disabled={staged}
        title={t('flightplanChip.stage_behind_title')}
        aria-label={t('flightplanChip.stage_behind_aria', { title: conflict.title })}
        style={{
          pointerEvents: 'auto',
          borderRadius: 8,
          padding: '2px 8px',
          fontSize: 10.5,
          fontWeight: 800,
          letterSpacing: '0.02em',
          cursor: staged ? 'default' : 'pointer',
          color: staged ? '#9fe6b0' : '#0b1f12',
          background: staged ? 'transparent' : '#8fe3a8',
          border: staged ? '1px solid #9fe6b066' : 'none'
        }}
      >
        {staged ? t('flightplanChip.staged') : t('flightplanChip.stage_behind')}
      </button>
      <button
        className="no-drag"
        onClick={onDismiss}
        title={t('flightplanChip.dismiss')}
        aria-label={t('flightplanChip.dismiss_aria')}
        style={{
          pointerEvents: 'auto',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: '#bda874',
          fontSize: 13,
          lineHeight: 1,
          padding: '0 2px'
        }}
      >
        ✕
      </button>
    </div>
  )
}

export function FlightplanChip(): JSX.Element | null {
  // Subscribe to every input getFlightplan reads so the rail re-derives whenever
  // the new node's task, the changeset poll, board facts, or nodes change.
  const nodes = useCanvas((s) => s.nodes)
  const byNode = useChangeset((s) => s.byNode)
  const facts = useBoard((s) => s.facts)
  const replayArmed = useReplay((s) => s.armed)
  const directorArmed = useDirector((s) => s.armed)
  const t = useT()

  // Per-new-node dismissal: once dismissed, stay quiet until a DIFFERENT new node
  // becomes the pre-flight target (keyed by node id, so a re-spawn re-arms).
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)

  const picked = useMemo(() => pickNewNode(nodes), [nodes])

  const conflicts = useMemo(() => {
    if (!picked) return [] as FlightConflict[]
    // getFlightplan reads byNode/facts lazily; the subscriptions above trigger this.
    void byNode
    void facts
    return useFlightplan.getState().getFlightplan(picked.task, picked.node.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, byNode, facts])

  // Hidden while an auto-driven camera owns the view (mirrors CollisionWatch).
  if (replayArmed || directorArmed) return null
  if (!picked) return null
  // Per-node dismissal (and zero chrome when there is nothing to warn about).
  if (dismissedFor === picked.node.id) return null
  if (!conflicts.length) return null

  return (
    <div
      className="no-drag"
      role="list"
      aria-label={t('flightplanChip.list_aria')}
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        bottom: 136,
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
      {conflicts.map((c) => (
        <FlightChip
          key={`${picked.node.id}:${c.nodeId}`}
          conflict={c}
          newNodeId={picked.node.id}
          onDismiss={() => setDismissedFor(picked.node.id)}
        />
      ))}
    </div>
  )
}
