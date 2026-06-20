// chronoscope.ts
//
// Chronoscope — the temporal-STRUCTURE layer over the Mission Pulse flight
// recorder. The mission store already records a flat, reverse-chronological
// MissionEvent[] (per-agent transitions with durations, relay handoffs,
// spawn/close), and missionBrief.ts folds it into per-agent TOTALS. Neither
// shows the one thing you need when babysitting several parallel agents: the
// PARALLEL temporal structure — who worked when, who was idle, who's been
// blocked the longest, and exactly when one agent handed the baton to another.
//
// This module reconstructs, per agent (= per node), a set of working INTERVALS
// (segments) and point MARKERS on a shared time axis, plus the cross-lane relay
// LINKS. It is a PURE, side-effect-free synthesis layer mirroring missionBrief's
// discipline:
//   - imports ONLY types (no zustand stores, no React, no IPC, no main process),
//   - never mutates its inputs,
//   - is fully deterministic given the same inputs (unit-testable; `now` is an
//     explicit argument so the open-ended "working now" stretch is reproducible).

import type { CanvasNode } from '../store/canvas'
import type { AgentKind } from '../store/canvas'
import type { MissionEvent, MissionKind } from '../store/mission'

/** A colored working stretch on a lane: [startTs, endTs]. */
export interface LaneSegment {
  /** the logical kind of the TERMINAL transition that ended this stretch
   *  ('done' | 'error' | 'waiting' | 'close'), or 'work-start' while still open. */
  kind: MissionKind
  startTs: number
  endTs: number
  /** the event id whose transition produced this segment (the terminal event
   *  when closed, else the opening 'work-start') — used to launch Replay. */
  sourceEventId: string
  /** true when this is the still-running, open-ended current stretch (ends at now). */
  open: boolean
}

/** A point-in-time event on a lane (spawn / done / error / waiting / close). */
export interface LaneMarker {
  kind: MissionKind
  ts: number
  eventId: string
}

/** A cross-lane Agent Relay handoff (curved arrow from source lane to target). */
export interface RelayLink {
  sourceNodeId: string
  /** best-effort resolved target node id (matched by title in the relay detail). */
  targetNodeId?: string
  /** the target name as written in the relay detail (always present for display). */
  targetTitle: string
  ts: number
  eventId: string
}

/** One horizontal swimlane: a single agent/node's timeline. */
export interface Lane {
  nodeId: string
  title: string
  agent?: AgentKind
  /** the node is still live on the canvas (not closed / disposed). */
  live: boolean
  /** live blocker tint, derived from the latest event for this node. */
  blockerKind?: 'error' | 'waiting'
  segments: LaneSegment[]
  markers: LaneMarker[]
}

/** The full reconstructed timeline. */
export interface Chronoscope {
  lanes: Lane[]
  /** earliest event ts across all lanes (axis start). */
  t0: number
  /** latest meaningful ts (axis end) — max(last event, now). */
  t1: number
  /** every cross-lane relay handoff. */
  links: RelayLink[]
  /** true when there is no recorded activity at all. */
  empty: boolean
}

const isTerminalOut = (k: MissionKind): boolean =>
  k === 'done' || k === 'error' || k === 'waiting' || k === 'close'

/**
 * Fold the recorded MissionEvent[] (and the live canvas nodes) into a swimlane
 * timeline. Pure + deterministic. Working intervals are reconstructed by pairing
 * each 'work-start' with the NEXT terminal transition for the same node, using
 * the recorded durationMs when present (which is the authoritative working time
 * captured at the narration/relay chokepoint) and otherwise falling back to the
 * next event's ts. An unclosed final 'work-start' becomes an open-ended segment
 * ending at `now`.
 *
 * `nodes` is used only for liveness + denormalized title fallback; all temporal
 * data comes from `events`.
 */
export function buildLanes(
  events: MissionEvent[],
  nodes: CanvasNode[],
  now: number
): Chronoscope {
  if (events.length === 0) {
    return { lanes: [], t0: now, t1: now, links: [], empty: true }
  }

  const liveIds = new Set<string>()
  const nodeTitle = new Map<string, string>()
  for (const n of nodes) {
    if (n.kind === 'terminal') liveIds.add(n.id)
    nodeTitle.set(n.id, n.title)
  }

  // Stable chronological order without mutating the input.
  const ordered = [...events].sort((a, b) => a.ts - b.ts)

  // Group events per node, preserving chronological order.
  const byNode = new Map<string, MissionEvent[]>()
  for (const e of ordered) {
    let arr = byNode.get(e.nodeId)
    if (!arr) {
      arr = []
      byNode.set(e.nodeId, arr)
    }
    arr.push(e)
  }

  let t0 = ordered[0].ts
  let t1 = ordered[ordered.length - 1].ts
  if (now > t1) t1 = now
  if (now < t0) t0 = now

  const lanes: Lane[] = []
  for (const [nodeId, evs] of byNode) {
    const last = evs[evs.length - 1]
    const live = liveIds.has(nodeId)
    let blockerKind: 'error' | 'waiting' | undefined
    if (live) {
      if (last.kind === 'error') blockerKind = 'error'
      else if (last.kind === 'waiting') blockerKind = 'waiting'
    }

    const segments: LaneSegment[] = []
    const markers: LaneMarker[] = []

    let openStart: MissionEvent | null = null
    for (const e of evs) {
      if (e.kind === 'work-start') {
        // A new work stretch begins. If a previous one was somehow still open
        // (no terminal transition recorded between two work-starts), close it at
        // this event's ts so segments never overlap.
        if (openStart) {
          segments.push({
            kind: 'work-start',
            startTs: openStart.ts,
            endTs: e.ts,
            sourceEventId: openStart.id,
            open: false
          })
        }
        openStart = e
        continue
      }
      if (isTerminalOut(e.kind)) {
        if (openStart) {
          // Prefer the authoritative recorded duration; fall back to the gap.
          const start =
            e.durationMs != null && e.durationMs > 0 ? e.ts - e.durationMs : openStart.ts
          segments.push({
            kind: e.kind,
            startTs: Math.min(start, e.ts),
            endTs: e.ts,
            sourceEventId: e.id,
            open: false
          })
          openStart = null
        }
        // Every terminal transition also drops a point marker.
        markers.push({ kind: e.kind, ts: e.ts, eventId: e.id })
        continue
      }
      // spawn / relay → point markers only (relay also feeds cross-lane links).
      markers.push({ kind: e.kind, ts: e.ts, eventId: e.id })
    }

    // An unterminated final work-start is the live "working now" stretch.
    if (openStart) {
      segments.push({
        kind: 'work-start',
        startTs: openStart.ts,
        endTs: Math.max(openStart.ts, now),
        sourceEventId: openStart.id,
        open: true
      })
    }

    lanes.push({
      nodeId,
      title: nodeTitle.get(nodeId) ?? last.title,
      agent: last.agent,
      live,
      blockerKind,
      segments,
      markers
    })
  }

  // Cross-lane relay links. A relay event is recorded against the SOURCE node and
  // names the target in `detail` (same contract missionBrief.ts relies on). We
  // resolve the target to a nodeId best-effort by title match.
  const titleToId = new Map<string, string>()
  for (const l of lanes) titleToId.set(l.title.toLowerCase(), l.nodeId)
  const links: RelayLink[] = []
  for (const e of ordered) {
    if (e.kind !== 'relay') continue
    const detail = (e.detail ?? '').toLowerCase()
    let targetNodeId: string | undefined
    let targetTitle = e.detail ?? 'relevo'
    for (const l of lanes) {
      const t = l.title.toLowerCase()
      if (t && l.nodeId !== e.nodeId && detail.includes(t)) {
        targetNodeId = l.nodeId
        targetTitle = l.title
        break
      }
    }
    links.push({ sourceNodeId: e.nodeId, targetNodeId, targetTitle, ts: e.ts, eventId: e.id })
  }

  // Order lanes: blockers first, then most-recent activity (mirrors missionBrief).
  lanes.sort((a, b) => {
    const ab = a.blockerKind ? 1 : 0
    const bb = b.blockerKind ? 1 : 0
    if (ab !== bb) return bb - ab
    const at = a.markers.length
      ? a.markers[a.markers.length - 1].ts
      : a.segments.length
        ? a.segments[a.segments.length - 1].endTs
        : 0
    const bt = b.markers.length
      ? b.markers[b.markers.length - 1].ts
      : b.segments.length
        ? b.segments[b.segments.length - 1].endTs
        : 0
    return bt - at
  })

  return { lanes, t0, t1, links, empty: lanes.length === 0 }
}

/** Map a timestamp into a [0,1] fraction across the [t0,t1] axis. Clamped. */
export function tsToFrac(ts: number, t0: number, t1: number): number {
  if (t1 <= t0) return 0
  const f = (ts - t0) / (t1 - t0)
  return f < 0 ? 0 : f > 1 ? 1 : f
}
