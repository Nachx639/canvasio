// sentinel.ts (PURE lib)
//
// Sentinel — spatial standing orders ("watch X for Y, then fly me there"). This
// is the PURE, side-effect-free evaluation layer: given the armed orders and the
// live substrates the rest of the nav suite already reads (Mission Pulse events
// + Agent Lens lines + the live node ids), decide which orders' conditions are
// NEWLY true and should therefore fire.
//
// Every other nav primitive in CanvasIO is REACTIVE — it points you at, or
// replays, things that already happened (Thermal=hottest, PulseRadar=current
// off-screen status, Backlog/Catch-Up=unread, Vigil=auto-follow the hottest).
// NONE let you declare an intent about the FUTURE. Sentinel is that missing
// forward-looking primitive: arm a standing order on a specific node ("wake me
// when this agent goes WAITING / ERRORS / finishes / prints a regex match"),
// then deep-focus elsewhere. The instant the condition fires, the chip pulses
// and (optionally) the camera flies straight there.
//
// This module mirrors backlog.ts / awayAlerts.ts / tripwireMatch.ts discipline:
//   - imports ONLY types (no zustand stores, no React, no IPC, no main process),
//   - never mutates its inputs,
//   - is fully deterministic given the same inputs (unit-testable),
//   - never throws (a malformed user regex degrades to "never matches").
//
// The store (store/sentinel.ts) owns the orders[] + per-order baseline/firedTs;
// it calls evaluateOrders() on every mission/lens change and acts on the ids
// this returns.

import type { MissionEvent, MissionKind } from '../store/mission'
import type { LensLine } from '../store/lens'

/** The status-style triggers map 1:1 onto a node's latest Mission Pulse kind. */
export type SentinelStatusKind = 'waiting' | 'error' | 'done'
/** All trigger kinds: the three status transitions + a Lens regex match. */
export type SentinelKind = SentinelStatusKind | 'match'

/**
 * One armed standing order. The store owns these; the evaluator only READS them.
 *
 * `baselineTs` is the arm-time guard: an order arms AGAINST the current state, so
 * a condition that is ALREADY true at arm-time must not instantly fire. Only a
 * substrate fact stamped strictly AFTER baselineTs can trip the order. The store
 * captures baselineTs = Date.now() (or the latest relevant substrate ts) on arm.
 *
 * `firedTs` is null until the order fires; the evaluator returns an order's id
 * only while firedTs is still null (so it fires at most once until re-armed).
 */
export interface SentinelOrder {
  id: string
  /** the node this order watches. */
  nodeId: string
  kind: SentinelKind
  /** for kind==='match': the user's regex source (pattern only, no flags). */
  pattern?: string
  /** arm-time watermark: only substrate facts newer than this can fire. */
  baselineTs: number
  /** wall-clock ms the order fired, or null while still armed (not yet fired). */
  firedTs: number | null
  /** whether firing should auto-fly the camera to the node (vs. just pulse). */
  autoFly: boolean
}

/**
 * Compile a user regex pattern safely. An invalid pattern (or an empty/whitespace
 * one) yields null, which the caller treats as "never matches" — Sentinel never
 * throws on a bad pattern and a bad-pattern order can never fire. Case-insensitive
 * to match the forgiving, grep-like feel of Tripwire's matcher.
 */
export function compilePattern(pattern: string | undefined): RegExp | null {
  if (!pattern || !pattern.trim()) return null
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return null
  }
}

/**
 * Does a single order's condition hold, given the live substrates?
 *
 * - status kinds (waiting/error/done): the node's LATEST mission event has that
 *   kind AND was recorded strictly after the order's baseline (so a status that
 *   was already in effect at arm-time doesn't fire — the agent must TRANSITION
 *   into it while the order is armed).
 * - 'match': the node's current Lens line matches the (safely compiled) regex AND
 *   that line was captured strictly after the baseline (so a line already on
 *   screen at arm-time doesn't fire — a NEW matching line must arrive).
 *
 * Pure; never mutates inputs; never throws.
 */
export function orderFires(
  order: SentinelOrder,
  latestByNode: Map<string, MissionEvent>,
  lensLines: Record<string, LensLine>
): boolean {
  if (order.kind === 'match') {
    const re = compilePattern(order.pattern)
    if (!re) return false
    const line = lensLines[order.nodeId]
    if (!line) return false
    if (line.ts <= order.baselineTs) return false
    return re.test(line.text)
  }
  // status kind
  const latest = latestByNode.get(order.nodeId)
  if (!latest) return false
  if (latest.ts <= order.baselineTs) return false
  return (latest.kind as MissionKind) === order.kind
}

/**
 * Evaluate every armed order against the live substrates and return the ids of
 * those whose condition NEWLY holds (i.e. they are still armed — firedTs===null —
 * and orderFires() is true now). An order whose node no longer exists is pruned
 * out (never returned) so a fired jump can't target a gone node; the caller
 * (store) does the durable pruning, this is the read-side safety net.
 *
 * `latestEventByNode` is passed pre-folded by the caller (the store reuses the
 * shared mission.latestEventByNode), keeping this layer free of any fold cost
 * duplication and import of the mission store.
 *
 * Deterministic, pure, never throws.
 */
export function evaluateOrders(
  orders: SentinelOrder[],
  latestByNode: Map<string, MissionEvent>,
  lensLines: Record<string, LensLine>,
  liveNodeIds: ReadonlySet<string>
): string[] {
  const fired: string[] = []
  for (const order of orders) {
    if (order.firedTs !== null) continue // already fired, stays quiet until re-armed
    if (!liveNodeIds.has(order.nodeId)) continue // node gone — never fire at it
    if (orderFires(order, latestByNode, lensLines)) fired.push(order.id)
  }
  return fired
}
