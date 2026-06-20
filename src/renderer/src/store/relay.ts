// relay.ts
//
// Agent Relay — a tiny renderer-only handoff bus for sequential multi-agent
// collaboration. A RelayRule says: "when <sourceId> finishes (done/error),
// send <text> to <targetId>". When a source's status classifier reports a
// logical transition into 'done' or 'error' (fired from TerminalOverlay's
// applyStatus chokepoint), every armed rule for that source enqueues its text
// for its target. The target terminal, once its own classifier reports it is
// idle/ready (the SAME readiness signal already used for pendingPrompt),
// drains the queue: it writes the text via window.canvasio.pty.write and marks
// itself 'working', narrating the baton pass.
//
// IMPORTANT — persistence contract: this state lives ONLY in memory. It is
// NEVER added to canvas.ts loadLayout / serialization, so it cannot affect
// persistence or cold-start behavior. Existing features are untouched.

import { create } from 'zustand'
import { nanoid } from 'nanoid'
// Critical Path — PURE intelligence over the relay graph + live node statuses.
// types-only/pure helper import (criticalPath.ts imports nothing from any store),
// so this introduces no cycle. The live canvas nodes are read lazily INSIDE the
// criticalPath() selector via useCanvas.getState() (call-time only), mirroring
// changeset.ts collisions()'s deferred-usage discipline — no module-init cross
// import, no initialization-order hazard.
import { useCanvas } from './canvas'
import {
  computeCriticalPath,
  type CriticalPath,
  type CritEdge,
  type NodeStatus
} from '../lib/criticalPath'

/** A single queued/armed handoff. */
export interface RelayRule {
  id: string
  /** node id of the agent whose done/error transition fires this rule. */
  sourceId: string
  /** node id of the agent the text is delivered to. */
  targetId: string
  /** the instruction written into the target terminal. */
  text: string
  /** when true (default), the rule disarms after firing a single time. */
  once: boolean
  /** false once the rule has fired (kept around only for `once === false`). */
  armed: boolean
  /**
   * Smart Relay: when true, the current Brief Board (shared context pool) is
   * prepended to this rule's instruction at delivery time, so the baton carries
   * the team's real findings instead of only the static, pre-typed text.
   * Defaults to false; when false the delivered text is byte-for-byte identical
   * to today's behavior. Additive + in-memory, off the persistence path.
   */
  includeBoard?: boolean
}

/** Hard caps to prevent runaway loops / unbounded growth. */
const MAX_RULES = 16
/** Max pending instructions retained per target; bounds queue growth. */
const MAX_QUEUED = 8

/** A single queued handoff instruction awaiting delivery to a target. */
export interface QueuedInstruction {
  /** the instruction text (already trimmed/capped when the rule was created). */
  text: string
  /** Smart Relay: when true, prepend the live Brief Board at delivery time. */
  includeBoard?: boolean
}

/**
 * Relay Conduits — a transient "a handoff just fired" pulse. Set at the fireSource
 * chokepoint to the source->target pair (+ a timestamp so repeated fires of the
 * SAME pair still retrigger the canvas baton animation via a changed reference).
 * IN-MEMORY ONLY, NEVER persisted (relay already lives off the persistence path),
 * NEVER sent over IPC. Purely additive: it changes no delivery behavior — the
 * instruction queue is updated byte-identically; this is just a render signal the
 * ConduitsLayer subscribes to so it can animate a baton dot along the fired wire.
 */
export interface RelayFire {
  sourceId: string
  targetId: string
  /** Date.now() at fire time; makes back-to-back identical fires a NEW reference. */
  at: number
}

interface RelayState {
  rules: RelayRule[]
  /** transient per-target queue of pending instructions awaiting delivery. */
  queue: Record<string, QueuedInstruction[]>
  /**
   * Relay Conduits — the most-recent handoff pulse (or null). Drives the canvas
   * baton animation. Additive + in-memory; see RelayFire.
   */
  lastFired: RelayFire | null
  /**
   * Add a relay rule. Forbids self-relay and caps the total. Returns the new
   * rule id, or null if rejected (self-relay or cap reached). `includeBoard`
   * (default false) makes the handoff carry the live Brief Board (Smart Relay).
   */
  addRule: (r: {
    sourceId: string
    targetId: string
    text: string
    once?: boolean
    includeBoard?: boolean
  }) => string | null
  removeRule: (id: string) => void
  /** Drop every rule referencing this node (as source OR target). */
  clearForNode: (nodeId: string) => void
  /** Rules whose source is this node (for badge rendering). */
  rulesForSource: (sourceId: string) => RelayRule[]
  /** Rules whose target is this node (for badge rendering). */
  rulesForTarget: (targetId: string) => RelayRule[]
  /**
   * A source reached a terminal logical state ('done' | 'error'): enqueue the
   * text of every armed matching rule for its target and disarm `once` rules.
   */
  fireSource: (sourceId: string) => void
  /** Take (and remove) the next pending instruction for a target, if any. */
  takeForTarget: (targetId: string) => QueuedInstruction | null
  /**
   * Brief Board injection: directly enqueue a ready-to-deliver instruction for a
   * target, bypassing the source-finish trigger. Used by "Inject Board" so the
   * shared-context block rides the SAME readiness-gated drain path (deliverRelay)
   * the relay handoffs already use — no new delivery path. Returns false when the
   * text is empty or the target is unknown-cap already applies via MAX_QUEUED.
   */
  enqueueForTarget: (targetId: string, text: string) => boolean
  /**
   * Critical Path — PURE selector (no new state, no IPC). Cross-references the
   * armed relay rules (the live dependency DAG) against the canvas nodes' live
   * status to compute the blocked agents + the single bottleneck + its critical
   * chain. Reads the canvas lazily via useCanvas.getState() INSIDE the call only
   * (same call-time-only discipline changeset.collisions / mission.getBrief use),
   * so relay.ts keeps its in-memory, off-the-persistence-path contract. A memo
   * guard returns a STABLE reference when the result is structurally identical to
   * the previous call (mirrors collisions()) so subscribers don't re-render on
   * every tick. Camera/render-only; never mutates geometry or touches IPC.
   */
  criticalPath: () => CriticalPath
}

/** Shared empty result so the no-blocked case keeps a stable reference. */
const EMPTY_CRITICAL: CriticalPath = { blocked: [], bottleneckId: null, bottleneckHeld: 0, chain: [] }

// Memo guard for criticalPath(): the last computed result is returned by reference
// when the next computation is structurally identical, so consumers (CriticalPathChip)
// don't re-render every tick. IN-MEMORY ONLY, mirroring collisions()'s memo intent.
let lastCritical: CriticalPath = EMPTY_CRITICAL

/** Structural equality between two CriticalPath readouts (order-sensitive; the
 *  producer sorts deterministically so identical inputs yield identical order). */
function sameCritical(prev: CriticalPath, next: CriticalPath): boolean {
  if (prev.bottleneckId !== next.bottleneckId || prev.bottleneckHeld !== next.bottleneckHeld) {
    return false
  }
  if (prev.chain.length !== next.chain.length) return false
  for (let i = 0; i < next.chain.length; i++) if (prev.chain[i] !== next.chain[i]) return false
  if (prev.blocked.length !== next.blocked.length) return false
  for (let i = 0; i < next.blocked.length; i++) {
    const a = prev.blocked[i]
    const b = next.blocked[i]
    if (a.nodeId !== b.nodeId || a.waitingOn.length !== b.waitingOn.length) return false
    for (let j = 0; j < b.waitingOn.length; j++) if (a.waitingOn[j] !== b.waitingOn[j]) return false
  }
  return true
}

export const useRelay = create<RelayState>((set, get) => ({
  rules: [],
  queue: {},
  lastFired: null,

  addRule: ({ sourceId, targetId, text, once = true, includeBoard = false }) => {
    if (!sourceId || !targetId || sourceId === targetId) return null
    const body = (text || '').trim()
    if (!body) return null
    if (get().rules.length >= MAX_RULES) return null
    const id = nanoid(8)
    const rule: RelayRule = { id, sourceId, targetId, text: body, once, armed: true, includeBoard }
    set((s) => ({ rules: [...s.rules, rule] }))
    return id
  },

  removeRule: (id) => set((s) => ({ rules: s.rules.filter((r) => r.id !== id) })),

  clearForNode: (nodeId) =>
    set((s) => {
      const { [nodeId]: _drop, ...rest } = s.queue
      return {
        rules: s.rules.filter((r) => r.sourceId !== nodeId && r.targetId !== nodeId),
        queue: rest
      }
    }),

  rulesForSource: (sourceId) => get().rules.filter((r) => r.sourceId === sourceId),
  rulesForTarget: (targetId) => get().rules.filter((r) => r.targetId === targetId),

  fireSource: (sourceId) =>
    set((s) => {
      const matched = s.rules.filter((r) => r.sourceId === sourceId && r.armed)
      if (!matched.length) return {}
      const queue = { ...s.queue }
      // Relay Conduits — record the handoff pulse for the canvas baton animation.
      // Use the LAST matched rule's target (the most recent edge to fire); the
      // timestamp guarantees a fresh reference even for a repeated same-pair fire.
      // Additive only: it does not alter the queue/delivery logic below.
      const fired: RelayFire = {
        sourceId,
        targetId: matched[matched.length - 1].targetId,
        at: Date.now()
      }
      for (const r of matched) {
        const list = queue[r.targetId] ? [...queue[r.targetId]] : []
        // Skip back-to-back duplicates so a once:false source flipping
        // done/error repeatedly doesn't stack identical instructions.
        if (list[list.length - 1]?.text !== r.text) {
          list.push({ text: r.text, includeBoard: r.includeBoard })
        }
        // Bound per-target growth: a busy/closed/never-ready target must not
        // accumulate without limit (only MAX_RULES capped rules before).
        queue[r.targetId] = list.length > MAX_QUEUED ? list.slice(-MAX_QUEUED) : list
      }
      // Disarm `once` rules; drop them entirely (kept only if armed again).
      const rules = s.rules
        .map((r) => (r.sourceId === sourceId && r.armed && r.once ? { ...r, armed: false } : r))
        .filter((r) => r.armed || !r.once)
      return { rules, queue, lastFired: fired }
    }),

  takeForTarget: (targetId) => {
    const list = get().queue[targetId]
    if (!list || !list.length) return null
    const [next, ...rest] = list
    set((s) => {
      const queue = { ...s.queue }
      if (rest.length) queue[targetId] = rest
      else delete queue[targetId]
      return { queue }
    })
    return next
  },

  enqueueForTarget: (targetId, text) => {
    const body = (text || '').trim()
    if (!targetId || !body) return false
    // The board is already composed into `text` by the caller, so it is delivered
    // verbatim (includeBoard:false avoids prepending the board a SECOND time).
    set((s) => {
      const list = s.queue[targetId] ? [...s.queue[targetId]] : []
      if (list[list.length - 1]?.text !== body) list.push({ text: body, includeBoard: false })
      const queue = { ...s.queue }
      queue[targetId] = list.length > MAX_QUEUED ? list.slice(-MAX_QUEUED) : list
      return { queue }
    })
    return true
  },

  criticalPath: () => {
    // Armed rules ARE the live pending dependency edges (unarmed rules have fired,
    // so they encode no remaining wait). Pass armed-ness through; criticalPath.ts
    // filters on it so the contract stays explicit.
    const edges: CritEdge[] = get().rules.map((r) => ({
      sourceId: r.sourceId,
      targetId: r.targetId,
      armed: r.armed
    }))
    if (!edges.length) {
      if (lastCritical !== EMPTY_CRITICAL) lastCritical = EMPTY_CRITICAL
      return EMPTY_CRITICAL
    }
    // Read live canvas nodes lazily (call-time only). Defensive: if the canvas
    // store isn't available for any reason, there is no critical path to report.
    let nodes: { id: string; kind: string; status?: NodeStatus }[] = []
    try {
      nodes = useCanvas.getState().nodes
    } catch {
      return EMPTY_CRITICAL
    }
    const known = new Set<string>()
    const status = new Map<string, NodeStatus>()
    for (const n of nodes) {
      // Only terminal agents participate in the relay handoff graph + carry status.
      if (n.kind !== 'terminal') continue
      known.add(n.id)
      if (n.status) status.set(n.id, n.status)
    }
    const next = computeCriticalPath(edges, status, known)
    if (sameCritical(lastCritical, next)) return lastCritical
    lastCritical = next
    return next
  }
}))
