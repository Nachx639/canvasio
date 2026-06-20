// backlog.ts
//
// Backlog — per-agent "unseen activity" attention router (thin SELECTOR store).
//
// This store owns NO data of its own. It is a read-only JOIN over two facts the
// app already computes in memory:
//   - useCanvas.visits[id].lastTs — "when I last LOOKED at this agent" (bumped at
//     the single centerOnNode chokepoint every manual jump funnels through), and
//   - useEcho.entries[id] — the per-node ring of meaningful output lines, stamped
//     with ts.
// unseen(id) = count of this agent's Echo lines newer than its lastTs watermark.
// Flying to a node bumps lastTs (centerOnNode), so the count zeroes itself the
// instant you actually look. Zero new IPC, zero new parse pass, zero persistence,
// zero geometry mutation.
//
// Persistence contract: because it holds NO state, there is nothing to persist or
// reset — a fresh / restored canvas automatically starts with zero backlog the
// moment Echo + visits are cleared (which resetRelayAndMission already does). The
// selectors read getState() at CALL TIME (never at module init) so there is no
// import cycle with canvas/echo — the same deferred-usage rule stall/echo follow.

import { create } from 'zustand'
import { useCanvas } from './canvas'
import { useEcho } from './echo'
import { countUnseen, pickPeak, totalUnseen as totalUnseenPure } from '../lib/backlog'

/** Live terminal node ids (music/web never produce Echo backlog). Call-time read. */
function terminalNodeIds(): string[] {
  return useCanvas
    .getState()
    .nodes.filter((n) => n.kind === 'terminal')
    .map((n) => n.id)
}

interface BacklogState {
  /**
   * How many of THIS agent's meaningful Echo lines are newer than the last time
   * the operator looked at it (visits[id].lastTs). 0 when never produced output
   * or when last-looked is newer than every line. Read-only, call-time getState.
   */
  unseen: (nodeId: string) => number
  /** Total unseen lines across every live terminal agent (the TopBar chip number). */
  totalUnseen: () => number
  /**
   * The agent with the most unseen activity right now (tie-break: most-recent
   * line), or null when nobody has any. Camera jumps fly here via centerOnNode.
   */
  peakNode: () => string | null
}

export const useBacklog = create<BacklogState>(() => ({
  unseen: (nodeId) => {
    const lastTs = useCanvas.getState().visits[nodeId]?.lastTs ?? 0
    return countUnseen(useEcho.getState().entries[nodeId], lastTs)
  },

  totalUnseen: () =>
    totalUnseenPure(
      terminalNodeIds(),
      useCanvas.getState().visits,
      useEcho.getState().entries
    ),

  peakNode: () =>
    pickPeak(terminalNodeIds(), useCanvas.getState().visits, useEcho.getState().entries)
}))
