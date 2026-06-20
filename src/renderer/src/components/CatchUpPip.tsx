import { useShallow } from 'zustand/react/shallow'
import { useT } from '../store/i18n'
import { useCatchup } from '../store/catchup'
import { useCanvas } from '../store/canvas'
import { useMission } from '../store/mission'
import { useEcho } from '../store/echo'
import { useCommandTrail } from '../store/commandTrail'
import { useChangeset } from '../store/changeset'

/**
 * Catch-Up pip — a compact "↺N" badge on a terminal node's header showing how
 * many MEANINGFUL milestones THIS agent crossed since the last time you looked at
 * it (went done/error/waiting, ran a destructive/network/vcs command, touched
 * files, or emitted output). It is the cross-signal companion to the Backlog "•N"
 * chip (which counts ONLY raw output lines): this one answers "did this agent do
 * something worth a re-orientation while my eyes were elsewhere?".
 *
 * The count is the deltaFor(nodeId).unreadCount join of the node's read-marker
 * (visits.lastTs, bumped at the centerOnNode chokepoint) against the four live
 * substrates. Clicking flies the camera here via centerOnNode, which bumps
 * visits.lastTs and zeroes the pip the moment you arrive.
 *
 * Pure renderer-side: it READS the live substrates and CALLS centerOnNode — no new
 * store state, no IPC, no geometry mutation. Subscribes to the substrate maps so
 * it re-renders only when this agent's tally can change, renders NOTHING when the
 * feature is off or the count is 0 (a caught-up node looks exactly as before), and
 * is hidden at low zoom (`hidden`) like the other node chrome.
 */
export function CatchUpPip({
  nodeId,
  hidden
}: {
  nodeId: string
  hidden?: boolean
}): JSX.Element | null {
  const t = useT()
  const enabled = useCatchup((s) => s.enabled)
  // Subscribe to the inputs so the pip recomputes when any substrate or the
  // read-marker changes. The actual join is the pure deltaFor selector.
  //
  // PERF: subscribe to THIS node's mission events only (shallow-compared), not the
  // whole `events` array. One CatchUpPip is mounted per terminal node, so a raw
  // `s.events` subscription re-rendered EVERY pip on EVERY status flip from ANY
  // node — O(N) pips each running an O(E) buildCatchup per mission event during
  // multi-agent streaming. Filtering to this node's events here means a pip only
  // re-renders when ITS own agent transitions. deltaFor still reads the full live
  // store via getState(), so the rendered count is byte-for-byte identical.
  useMission(useShallow((s) => s.events.filter((e) => e.nodeId === nodeId)))
  useEcho((s) => s.entries[nodeId])
  useCommandTrail((s) => s.entries[nodeId])
  useChangeset((s) => s.byNode[nodeId])
  useCanvas((s) => s.visits[nodeId])
  useCatchup((s) => s.dismissedAt[nodeId])

  if (!enabled || hidden) return null
  const n = useCatchup.getState().deltaFor(nodeId).unreadCount
  if (n === 0) return null

  return (
    <span
      title={n === 1 ? t('catchUpPip.title_one', { n }) : t('catchUpPip.title_other', { n })}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        // Flying here bumps visits.lastTs at the centerOnNode chokepoint, which
        // zeroes this pip the moment the camera arrives.
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
        color: '#ffe2b0',
        background: 'rgba(242,168,75,0.16)',
        border: '1px solid rgba(242,168,75,0.5)',
        flex: '0 0 auto',
        userSelect: 'none',
        fontVariantNumeric: 'tabular-nums'
      }}
    >
      <span aria-hidden style={{ fontWeight: 700 }}>↺</span>
      <span style={{ fontWeight: 700 }}>{n}</span>
    </span>
  )
}
