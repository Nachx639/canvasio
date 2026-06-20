// timefold.ts
//
// Timefold — Canvas Time Machine (PURE substrate).
//
// Every existing time tool in CanvasIO handles the EVENT timeline and only one
// focus at a time: Flight Recorder Replay (replay.ts) flies the camera event-to-
// event; Director chases live events; Chronoscope draws per-agent swimlanes;
// Vigil / Grand Tour are camera autopilots. NONE reconstruct CONTENT STATE
// across ALL nodes at one chosen wall-clock instant.
//
// This module is the pure, unit-tested reconstruction kernel behind Timefold.
// Given the two timestamped substrates CanvasIO already captures for free —
// the Echo Index ring of meaningful output lines per node (echo.ts) and the
// Mission Pulse log of per-node status transitions (mission.ts) — it answers
// "what was this node printing, and what status did it hold, AS OF moment T?".
//
// Design contract: ZERO store imports (no cycles), ZERO side effects, ZERO
// React. It takes plain data in and returns plain data out. The shapes mirror
// EchoLine (echo.ts) and MissionEvent (mission.ts) STRUCTURALLY so callers pass
// the live arrays straight through with no adapter. Both substrates are appended
// in ascending-ts order, which these scans rely on.

/** Structural mirror of echo.ts EchoLine (kept local to avoid a store import). */
export interface TimefoldLine {
  text: string
  ts: number
}

/** The minimal shape of a mission event Timefold needs (subset of MissionEvent). */
export interface TimefoldEvent {
  nodeId: string
  ts: number
  /** logical status-ish kind; only transitions that map to a status matter here. */
  kind: string
}

/** Inclusive wall-clock span covered by the captured substrates. */
export interface TimefoldRange {
  minTs: number
  maxTs: number
}

/**
 * Map a MissionEvent kind to the node status it implies at that instant. Mirrors
 * the canvas node `status` union ('idle' | 'working' | 'done' | 'error') so the
 * caller can index STATUS_COLOR directly. Quiet lifecycle kinds (spawn/close/
 * relay) carry no status of their own, so they return null and are skipped when
 * folding for the as-of status.
 */
export type FoldStatus = 'idle' | 'working' | 'done' | 'error'

export function statusForKind(kind: string): FoldStatus | null {
  switch (kind) {
    case 'work-start':
      return 'working'
    case 'done':
      return 'done'
    case 'error':
      return 'error'
    case 'waiting':
      // "waiting / needs-input" is a paused-but-live state; surface it as idle
      // (the calmest dot) since there is no dedicated waiting color in the
      // STATUS_COLOR map the overlay reuses.
      return 'idle'
    // spawn / close / relay carry no intrinsic status.
    default:
      return null
  }
}

/**
 * The inclusive {minTs,maxTs} span across BOTH substrates, or null when there is
 * nothing recorded yet (a fresh / restored canvas). Considers every echo line's
 * ts and every mission event's ts. Pure.
 */
export function computeRange(
  echoEntries: Record<string, TimefoldLine[]>,
  missionEvents: TimefoldEvent[]
): TimefoldRange | null {
  let min = Infinity
  let max = -Infinity
  for (const nodeId in echoEntries) {
    const ring = echoEntries[nodeId]
    for (const line of ring) {
      if (line.ts < min) min = line.ts
      if (line.ts > max) max = line.ts
    }
  }
  for (const ev of missionEvents) {
    if (ev.ts < min) min = ev.ts
    if (ev.ts > max) max = ev.ts
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return null
  return { minTs: min, maxTs: max }
}

/**
 * The last line in a node's ring whose ts is <= t (the line that was on screen
 * "as of" t), or null if the ring is empty or every line came AFTER t. Rings are
 * appended in ascending-ts order, so a binary search finds the boundary.
 */
export function lineAtTime(ring: TimefoldLine[] | undefined, t: number): TimefoldLine | null {
  if (!ring || ring.length === 0) return null
  // Fast paths at the extremes.
  if (ring[0].ts > t) return null
  if (ring[ring.length - 1].ts <= t) return ring[ring.length - 1]
  // Binary search for the rightmost index with ts <= t.
  let lo = 0
  let hi = ring.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (ring[mid].ts <= t) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ring[ans]
}

/**
 * The status a node held as of t: the most-recent status-bearing transition
 * at-or-before t. Filters to events for `nodeId`, scans for the latest ts <= t
 * that maps to a real status (statusForKind), and returns it; null when the node
 * had no status-bearing event yet at t. Events are assumed ascending-ts.
 */
export function statusAtTime(
  events: TimefoldEvent[],
  nodeId: string,
  t: number
): FoldStatus | null {
  let result: FoldStatus | null = null
  for (const ev of events) {
    if (ev.nodeId !== nodeId) continue
    if (ev.ts > t) break // ascending ts → nothing further qualifies
    const st = statusForKind(ev.kind)
    if (st != null) result = st
  }
  return result
}

/**
 * Sorted, de-duplicated list of every meaningful timestamp across both
 * substrates — the "ticks" the scrubber snaps to when arrow-stepping. Pure.
 */
export function eventTicks(
  echoEntries: Record<string, TimefoldLine[]>,
  missionEvents: TimefoldEvent[]
): number[] {
  const set = new Set<number>()
  for (const nodeId in echoEntries) {
    for (const line of echoEntries[nodeId]) set.add(line.ts)
  }
  for (const ev of missionEvents) set.add(ev.ts)
  return Array.from(set).sort((a, b) => a - b)
}

/**
 * Given the sorted ticks and the current t, the neighboring tick in `dir`
 * (+1 = next, -1 = prev), or null when there is none in that direction. Used by
 * the scrubber's ◀/▶ buttons and ←/→ keys to hop between real moments instead
 * of arbitrary millisecond steps.
 */
export function neighborTick(ticks: number[], t: number, dir: 1 | -1): number | null {
  if (ticks.length === 0) return null
  if (dir === 1) {
    for (let i = 0; i < ticks.length; i++) {
      if (ticks[i] > t) return ticks[i]
    }
    return null
  }
  for (let i = ticks.length - 1; i >= 0; i--) {
    if (ticks[i] < t) return ticks[i]
  }
  return null
}
