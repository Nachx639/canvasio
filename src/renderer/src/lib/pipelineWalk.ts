// pipelineWalk.ts
//
// Slipstream Pipeline Walk — PURE traversal over the Agent Relay handoff graph.
// NO DOM, NO stores, NO IPC: every function takes plain data (relay edges + the
// set of node ids still on the canvas) and returns plain data, so it is trivially
// unit-testable (see pipelineWalk.test.ts) and reusable by the canvas walk action.
//
// The Agent Relay encodes "who hands off to whom" as sourceId -> targetId rules,
// ConduitsLayer DRAWS it, and flowLayout() arranges BY it — but it was never
// TRAVERSABLE. This lib maps the relay rules to the still-on-canvas partner ids in
// each direction so the camera can walk the handoff chain hop by hop:
//   - downstreamOf(n): the agents `n` feeds (n is the rule SOURCE)
//   - upstreamOf(n):   the agents that feed `n` (n is the rule TARGET)
//
// Precision-over-recall contract mirrors conduits.ts exactly: self-edges are
// skipped, parallel duplicates are deduped (first wins, input order preserved),
// and any edge whose partner endpoint is no longer on the canvas is pruned.

/** The minimal relay-rule shape pipeline-walk math needs (a subset of RelayRule). */
export interface WalkRule {
  sourceId: string
  targetId: string
}

/** Walk direction: down = follow handoffs forward, up = trace them backward. */
export type WalkDir = 'down' | 'up'

/**
 * The agents `nodeId` hands off TO (its downstream relay partners): every rule
 * whose source is `nodeId`, mapped to its target, keeping only targets still on
 * the canvas (`existingIds`), deduped, self-edges skipped. Input order preserved.
 */
export function downstreamOf(
  nodeId: string,
  rules: WalkRule[],
  existingIds: ReadonlySet<string>
): string[] {
  return partners(nodeId, rules, existingIds, 'down')
}

/**
 * The agents that hand off TO `nodeId` (its upstream relay partners): every rule
 * whose target is `nodeId`, mapped to its source, keeping only sources still on
 * the canvas (`existingIds`), deduped, self-edges skipped. Input order preserved.
 */
export function upstreamOf(
  nodeId: string,
  rules: WalkRule[],
  existingIds: ReadonlySet<string>
): string[] {
  return partners(nodeId, rules, existingIds, 'up')
}

/** Shared core for downstreamOf/upstreamOf — the only difference is which endpoint
 *  is the pivot vs. the partner. Self-edges skipped, missing partners pruned,
 *  duplicates deduped (first wins), input order preserved. */
function partners(
  nodeId: string,
  rules: WalkRule[],
  existingIds: ReadonlySet<string>,
  dir: WalkDir
): string[] {
  if (!nodeId) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rules) {
    if (r.sourceId === r.targetId) continue // self-edge skip (mirrors conduits)
    const pivot = dir === 'down' ? r.sourceId : r.targetId
    if (pivot !== nodeId) continue
    const partner = dir === 'down' ? r.targetId : r.sourceId
    if (partner === nodeId) continue
    if (!existingIds.has(partner)) continue // prune deleted endpoints
    if (seen.has(partner)) continue // dedup parallels (first wins)
    seen.add(partner)
    out.push(partner)
  }
  return out
}

/**
 * The result of asking "where does pressing n/u from `current` go?":
 *   - { targetId } when there is exactly ONE partner in that direction (walk it).
 *   - { candidates } when there are MULTIPLE (a branch — the picker disambiguates).
 *   - {} (both undefined) when there are NONE (dead end; the caller no-ops).
 */
export interface WalkTarget {
  /** the single unambiguous hop target, when exactly one partner exists. */
  targetId?: string
  /** the >1 partner ids to disambiguate via the ace-jump branch picker. */
  candidates?: string[]
}

/**
 * Resolve a single pipeline-walk hop from `current` in `dir`. Returns a single
 * `targetId` for the 1-partner case, a `candidates` list for the fan-out/fan-in
 * branch case, or an empty object for a dead end. When `frecency` is provided it
 * is used ONLY to break ties deterministically inside the candidate list (most-
 * recently/often-visited partner first) so the branch picker's labels are stable
 * and the most likely branch reads first — it never collapses a branch to a
 * single auto-pick (multiple partners always stay a user choice). Pure.
 */
export function pickWalkTarget(
  current: string | null | undefined,
  dir: WalkDir,
  rules: WalkRule[],
  existingIds: ReadonlySet<string>,
  frecency?: Record<string, { count: number; lastTs: number }>
): WalkTarget {
  if (!current) return {}
  const list = dir === 'down'
    ? downstreamOf(current, rules, existingIds)
    : upstreamOf(current, rules, existingIds)
  if (list.length === 0) return {}
  if (list.length === 1) return { targetId: list[0] }
  // Multiple partners -> branch. Optionally order by frecency (recency, then
  // count) so the most-likely branch surfaces first; ties keep input order via a
  // stable sort. Frecency is advisory ordering only — never an auto-pick.
  const ordered = frecency
    ? [...list].sort((a, b) => {
        const fa = frecency[a]
        const fb = frecency[b]
        const ra = fa?.lastTs ?? 0
        const rb = fb?.lastTs ?? 0
        if (rb !== ra) return rb - ra
        const ca = fa?.count ?? 0
        const cb = fb?.count ?? 0
        return cb - ca
      })
    : list
  return { candidates: ordered }
}
