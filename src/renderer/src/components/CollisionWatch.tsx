import { useEffect, useRef } from 'react'
import { useCanvas, AGENT_LABEL } from '../store/canvas'
import { useChangeset, type Collision } from '../store/changeset'
import { useMission } from '../store/mission'
import { useReplay } from '../store/replay'
import { useDirector } from '../store/director'
import { t, useT } from '../store/i18n'

/**
 * Collision Watch — Cross-Agent File-Conflict Radar.
 *
 * The first surface that reasons about a RELATIONSHIP between agents' work rather
 * than each agent in isolation. It is a calm amber chip rail (bottom-center,
 * stacked above the Director chip) that appears ONLY when two or more coding
 * agents in the SAME repo (cwd) have the SAME file dirty at once — the #1 silent
 * cause of clobbered work in multi-agent coding. Each chip reads
 * "⚠ N agents · <basename>"; clicking it cycles the camera between the contending
 * nodes (the exact Enter-cycle pattern ConstellationFilter uses).
 *
 * 100% DERIVED from already-in-memory Changeset data via the pure
 * useChangeset.collisions() selector (no new state, no IPC, no main-process /
 * git change). Renders NOTHING when there are no collisions (zero chrome when
 * unused, the convention every overlay follows). CAMERA/RENDERER-ONLY: it only
 * ever calls centerOnNode — never mutates node/shape geometry. Hidden while an
 * auto-driven camera (Replay/Director) owns the view so it never fights them,
 * matching TriageChip / PulseRadar.
 */
const AMBER = '#f0b429'

/** Last path segment of a repo-relative path (for the compact chip label). */
function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

/** Human label for a node id: its title (falling back to the agent persona). */
function nodeLabel(nodeId: string): string {
  const n = useCanvas.getState().nodes.find((x) => x.id === nodeId)
  if (!n) return nodeId
  return n.title || (n.agent ? AGENT_LABEL[n.agent].title : t('collisionWatch.agent_fallback'))
}

/** One amber collision chip. Clicking cycles the camera across its contenders. */
function CollisionChip({ c }: { c: Collision }): JSX.Element {
  const t = useT()
  const centerOnNode = useCanvas((s) => s.centerOnNode)
  // Index into this collision's nodeIds for click-to-cycle (mirrors the
  // ConstellationFilter Enter-cycle: -1 means "next click starts at the first").
  const cycleRef = useRef<number>(-1)

  const n = c.nodeIds.length
  const titles = c.nodeIds.map(nodeLabel)
  const tooltip = `${t('collisionWatch.agents_editing', { n, path: c.path })}\n${titles.join(' · ')}\n${c.cwd}`

  const cycle = (): void => {
    const ids = c.nodeIds
    if (!ids.length) return
    const next = (cycleRef.current + 1) % ids.length
    cycleRef.current = next
    centerOnNode(ids[next])
  }

  return (
    <button
      className="glass no-drag"
      onClick={cycle}
      title={tooltip}
      aria-label={t('collisionWatch.chip_aria', { n, path: c.path })}
      style={{
        pointerEvents: 'auto',
        borderRadius: 12,
        padding: '7px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        color: '#f5e6c8',
        cursor: 'pointer',
        border: `1px solid ${AMBER}55`
      }}
    >
      <span aria-hidden style={{ fontSize: 12.5 }}>
        ⚠
      </span>
      <span style={{ fontWeight: 800, color: AMBER, fontSize: 12.5 }}>{n}</span>
      <span style={{ fontSize: 11.5, fontWeight: 700, color: '#d9c7a0', letterSpacing: '0.02em' }}>
        {basename(c.path)}
      </span>
    </button>
  )
}

export function CollisionWatch(): JSX.Element | null {
  const t = useT()
  // Subscribe to the inputs collisions() reads (byNode + nodes) so the rail
  // re-derives whenever the Changeset poll or the canvas nodes change.
  const byNode = useChangeset((s) => s.byNode)
  const nodes = useCanvas((s) => s.nodes)
  const replayArmed = useReplay((s) => s.armed)
  const directorArmed = useDirector((s) => s.armed)

  // Pure derived list (memo-guarded inside the store for a stable reference).
  // Reading via getState() here is intentional: the byNode/nodes subscriptions
  // above are what trigger the re-render; collisions() then recomputes.
  void byNode
  void nodes
  const collisions = useChangeset.getState().collisions()

  // Mission Pulse — log each NEW collision once (debounced per-key) so Director /
  // Replay / MissionLog can reflect that a conflict appeared. Purely additive and
  // at the SAME no-side-effect discipline: it never mutates geometry or touches
  // IPC. Keys that drop out are forgotten so a re-collision logs again.
  const loggedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const live = new Set(collisions.map((c) => c.key))
    for (const c of collisions) {
      if (loggedRef.current.has(c.key)) continue
      loggedRef.current.add(c.key)
      const head = c.nodeIds[0]
      const n = useCanvas.getState().nodes.find((x) => x.id === head)
      useMission.getState().record({
        nodeId: head,
        title: n?.title ?? t('collisionWatch.agent_fallback'),
        agent: n?.agent,
        kind: 'error',
        detail: t('collisionWatch.log_detail', {
          n: c.nodeIds.length,
          file: basename(c.path)
        })
      })
    }
    // Forget keys no longer colliding so a future re-collision is logged again.
    for (const k of loggedRef.current) if (!live.has(k)) loggedRef.current.delete(k)
  }, [collisions, t])

  // Hidden while an auto-driven camera owns the view (mirrors TriageChip).
  if (replayArmed || directorArmed) return null
  // Zero chrome when there are no collisions (the convention every overlay follows).
  if (!collisions.length) return null

  return (
    <div
      className="no-drag"
      role="list"
      aria-label={t('collisionWatch.rail_aria')}
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
      {collisions.map((c) => (
        <CollisionChip key={c.key} c={c} />
      ))}
    </div>
  )
}
