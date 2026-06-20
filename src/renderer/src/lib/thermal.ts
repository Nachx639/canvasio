// thermal.ts
//
// Thermal — Activity Heat. A PURE, in-memory scoring layer over the existing
// Mission Pulse timeline: it turns the timestamped, per-node mission events
// (mission.ts: work-start / done / error / waiting / relay / spawn / close)
// into a per-node "heat" number in [0,1] that decays with time, so a node that
// has been busy recently glows and a node that went quiet cools off.
//
// CONTRACT: this module is PURE. It imports no React, touches no store, does no
// IPC. It only reads the arrays it is handed (MissionEvent[] + a node-id set)
// and returns plain data. It is reused verbatim by ThermalOverlay (the glow),
// Minimap (the heat dots), and the canvas flyToHottest() camera hop, so the heat
// math lives in exactly one place.

import type { MissionEvent, MissionKind } from '../store/mission'

/**
 * Time window (ms) over which mission events still contribute heat. Events older
 * than this are ignored entirely (keeps the scan cheap and the picture "recent").
 */
export const THERMAL_WINDOW_MS = 5 * 60 * 1000 // ~5 min

/**
 * Half-life (ms) of an event's contribution: an event's weight halves every
 * HALF_LIFE_MS of age. ~90s gives a lively but not jittery picture — a burst of
 * work reads hot for a minute or two, then visibly cools.
 */
export const THERMAL_HALF_LIFE_MS = 90 * 1000 // ~90 s

/**
 * Per-kind base weight before time decay. "Working" states are the hottest
 * non-error signal; waiting (te necesita) and relays are mid; done/spawn are
 * cooler tails; close contributes nothing. `error` is handled specially below
 * (it pins the node to max heat) so its weight here is only a fallback.
 */
const KIND_WEIGHT: Record<MissionKind, number> = {
  'work-start': 1,
  waiting: 0.6,
  relay: 0.6,
  done: 0.35,
  spawn: 0.2,
  error: 1,
  close: 0
}

/**
 * Raw (pre-normalization) score at which a node is considered fully hot (heat
 * 1.0). Chosen so a single fresh error or a couple of fresh work-starts reads
 * near the top, while sustained activity saturates. Tuned for visual range, not
 * a physical unit.
 */
const SATURATION = 2.2

/**
 * Compute a per-node heat map in [0,1] from the mission timeline.
 *
 * Score = time-decayed sum of recent per-node event weights (half-life
 * THERMAL_HALF_LIFE_MS over a THERMAL_WINDOW_MS window), normalized against
 * SATURATION and clamped to [0,1]. A node whose MOST RECENT in-window event is
 * an `error` is pinned to max heat (1.0) — an error is the thing you most want
 * the heat picture to scream about, regardless of how much else it has done.
 *
 * PURE: reads only `events`; never mutates input, never touches stores/IPC.
 */
export function computeHeat(events: MissionEvent[], now: number): Map<string, number> {
  const raw = new Map<string, number>()
  // Track the most-recent in-window event kind per node so a fresh error can pin.
  const lastKind = new Map<string, { ts: number; kind: MissionKind }>()

  for (const e of events) {
    const age = now - e.ts
    // Ignore future-dated (clock skew) and out-of-window events.
    if (age < 0 || age > THERMAL_WINDOW_MS) continue
    const w = KIND_WEIGHT[e.kind] ?? 0
    if (w > 0) {
      // ease: 0.5 ^ (age / halfLife) — halves every half-life.
      const decay = Math.pow(0.5, age / THERMAL_HALF_LIFE_MS)
      raw.set(e.nodeId, (raw.get(e.nodeId) ?? 0) + w * decay)
    }
    const prev = lastKind.get(e.nodeId)
    if (!prev || e.ts >= prev.ts) lastKind.set(e.nodeId, { ts: e.ts, kind: e.kind })
  }

  const heat = new Map<string, number>()
  raw.forEach((score, id) => {
    let h = Math.min(1, score / SATURATION)
    // A node whose latest in-window event is an error is pinned red-hot.
    if (lastKind.get(id)?.kind === 'error') h = 1
    if (h > 0.001) heat.set(id, h)
  })
  // A node may have ONLY an error in window (e.g. a single error event whose own
  // weight already counted above) — already covered. But guard the rare case
  // where an error is the only event yet rounded below threshold: pin it.
  lastKind.forEach((v, id) => {
    if (v.kind === 'error') heat.set(id, 1)
  })
  return heat
}

/**
 * Resolve the hottest currently-present node id, restricted to `presentIds`
 * (nodes still on the canvas), so a closed node can never become the fly target.
 * Returns null when no present node has heat. PURE.
 */
export function hottestNodeId(
  heat: Map<string, number>,
  presentIds: Iterable<string>
): string | null {
  const present = presentIds instanceof Set ? presentIds : new Set(presentIds)
  let bestId: string | null = null
  let bestH = 0
  heat.forEach((h, id) => {
    if (!present.has(id)) return
    if (h > bestH) {
      bestH = h
      bestId = id
    }
  })
  return bestId
}
