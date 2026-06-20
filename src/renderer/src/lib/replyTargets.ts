// replyTargets.ts
//
// Reply Rail — pure derivation of the "needs-you" inbox: the ordered list of
// agents currently BLOCKED on the user (waiting on a confirmation prompt) plus
// the exact prompt line the Agent Lens already captured for each.
//
// This reuses the EXACT "waiting tier" semantics that attentionQueue (canvas.ts)
// uses for Triage Jump — the latest mission event per node, with kind 'waiting',
// ordered oldest-first so the agent that has been blocked the longest is serviced
// first. It is the read-only half of "N agents are blocked": Triage Jump POINTS
// the camera at them; Reply Rail lists them so you can ANSWER in place.
//
// Pure / no side effects: it READS nodes + mission events + lens lines and returns
// a plain array. No store access, no IPC, no geometry — fully unit-testable against
// fixtures. (The writing half lives entirely in ReplyRail.tsx via pty.write.)

import type { AgentKind, CanvasNode } from '../store/canvas'
import { latestEventByNode, type MissionEvent } from '../store/mission'
import type { LensLine } from '../store/lens'

/** One blocked agent the user can answer in place. */
export interface ReplyTarget {
  /** the terminal node id to write the answer to (window.canvasio.pty.write). */
  nodeId: string
  /** node title at derivation time (e.g. "Nova"). */
  title: string
  /** agent persona, for accent coloring; undefined for non-agent terminals. */
  agent?: AgentKind
  /**
   * the captured prompt line the agent is blocked on (from the Agent Lens), e.g.
   * "Allow `rm -rf build`? (y/n)". May be undefined if the lens hasn't captured a
   * line yet (the row still renders — the agent is provably waiting).
   */
  prompt?: string
  /** ms timestamp of the waiting transition (how long it's been blocked). */
  ts: number
}

/**
 * Build the ordered Reply Rail inbox.
 *
 * Selects terminal nodes whose LATEST mission event kind === 'waiting' (the exact
 * fold attentionQueue uses for its waiting tier), ordered oldest-first, and
 * attaches each node's current Agent Lens line as the prompt text.
 *
 * `now` is accepted for signature symmetry with attentionQueue / testability; the
 * ordering only depends on the recorded transition timestamps.
 */
export function buildReplyTargets(
  nodes: CanvasNode[],
  events: MissionEvent[],
  lensLines: Record<string, LensLine>,
  _now: number = Date.now()
): ReplyTarget[] {
  // Latest mission event per node (same fold as attentionQueue / PulseRadar).
  const last = latestEventByNode(events)

  const out: ReplyTarget[] = []
  for (const n of nodes) {
    if (n.kind !== 'terminal') continue
    const ev = last.get(n.id)
    // Only agents whose newest transition is 'waiting' (blocked on the user).
    if (ev?.kind !== 'waiting') continue
    out.push({
      nodeId: n.id,
      title: n.title,
      agent: n.agent,
      prompt: lensLines[n.id]?.text,
      ts: ev.ts
    })
  }

  // Oldest-waiting-first: service the agent that's been blocked the longest.
  out.sort((a, b) => a.ts - b.ts)
  return out
}
