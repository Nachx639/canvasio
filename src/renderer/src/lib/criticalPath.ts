// criticalPath.ts
//
// Critical Path — PURE relay-dependency + bottleneck intelligence. NO DOM, NO
// stores, NO IPC: every function takes plain data (relay edges + a nodeId->status
// map + nodeId->label map) and returns plain data, so they are trivially
// unit-testable (see criticalPath.test.ts) and reusable by CriticalPathChip and
// any camera framing. This is the first surface that reasons about the TRANSITIVE
// dependency structure of a multi-agent mission rather than one agent in isolation
// (Lens/Pulse/Thermal/Objectives) or one pairwise file conflict (Collision Watch).
//
// The relay graph already encodes real dependencies — "Tester only starts after
// Coder finishes" (sourceId -> targetId). Cross-referenced with live node.status
// it answers the operator's recurring question in a multi-agent mission: who is
// idle-but-blocked, and which single upstream agent is the bottleneck whose
// unblocking releases the most downstream work?
//
// Purity contract mirrors territory.ts / objective.ts: types-only imports, all
// deterministic, precision-over-recall (return empty/none when ambiguous).

/** A live agent status (subset of CanvasNode.status). */
export type NodeStatus = 'idle' | 'working' | 'done' | 'error'

/** A single relay edge (subset of RelayRule): a handoff source -> target. */
export interface CritEdge {
  sourceId: string
  targetId: string
  /** only armed (not-yet-fired) rules represent a still-pending dependency. */
  armed: boolean
}

/** One agent that is idle/ready but waiting on an upstream that is still busy. */
export interface BlockedAgent {
  /** the waiting (idle) target node id. */
  nodeId: string
  /** the upstream node ids (working/error) this target is directly waiting on. */
  waitingOn: string[]
}

/** The computed critical-path readout for the current relay graph + statuses. */
export interface CriticalPath {
  /** every idle target blocked by a still-busy armed upstream, sorted stably. */
  blocked: BlockedAgent[]
  /**
   * the single working/errored node holding up the most TRANSITIVE downstream
   * blocked work, or null when there is no unambiguous bottleneck. The agent the
   * most pending work hangs on.
   */
  bottleneckId: string | null
  /** how many transitively-downstream agents the bottleneck is holding up. */
  bottleneckHeld: number
  /**
   * the critical chain: node ids from the bottleneck along its longest downstream
   * dependency path, for camera cycling. Always starts with bottleneckId (when
   * one exists), then the chain of dependents. Empty when no bottleneck.
   */
  chain: string[]
}

/** Hard cap on BFS/DFS expansion to defuse relay cycles (mirrors flowLayout's
 *  guard of nodes.length; we use edge count which bounds any simple traversal). */
function traversalCap(edges: CritEdge[]): number {
  // +1 so a single-edge graph still does its one expansion; min keeps it sane.
  return Math.max(8, edges.length + 1)
}

/** True when an upstream agent in this status is still "in progress" — i.e. its
 *  downstream targets cannot have legitimately started yet. 'error' counts: an
 *  errored upstream is also blocking (its handoff has not delivered cleanly). */
function isBusy(status: NodeStatus | undefined): boolean {
  return status === 'working' || status === 'error'
}

/** True when a target agent is in a state where it is WAITING (not progressing):
 *  idle/ready, or undefined (freshly spawned, no status yet). A 'working' target
 *  is already moving so it is not "blocked"; 'done' is finished. */
function isWaiting(status: NodeStatus | undefined): boolean {
  return status === undefined || status === 'idle'
}

/**
 * Build a directed adjacency map source -> [targets] from the armed edges only,
 * restricted to a known node set. Unarmed (already-fired) rules no longer encode
 * a pending dependency, so they are excluded. Self-edges and edges referencing
 * unknown nodes are dropped (defensive; addRule already forbids self-relay).
 */
export function buildDeps(edges: CritEdge[], known: Set<string>): Map<string, string[]> {
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    if (!e.armed) continue
    if (e.sourceId === e.targetId) continue
    if (!known.has(e.sourceId) || !known.has(e.targetId)) continue
    const list = adj.get(e.sourceId) ?? []
    if (!list.includes(e.targetId)) list.push(e.targetId)
    adj.set(e.sourceId, list)
  }
  return adj
}

/**
 * Reverse adjacency target -> [sources]: who does each node DIRECTLY wait on.
 * Same filtering as buildDeps.
 */
function buildUpstream(edges: CritEdge[], known: Set<string>): Map<string, string[]> {
  const up = new Map<string, string[]>()
  for (const e of edges) {
    if (!e.armed) continue
    if (e.sourceId === e.targetId) continue
    if (!known.has(e.sourceId) || !known.has(e.targetId)) continue
    const list = up.get(e.targetId) ?? []
    if (!list.includes(e.sourceId)) list.push(e.sourceId)
    up.set(e.targetId, list)
  }
  return up
}

/**
 * BLOCKED agents — every target that is WAITING (idle/undefined) while at least
 * one of its DIRECT armed upstream sources is still BUSY (working/error). A target
 * already 'working' or 'done' is not blocked. Deterministic order: by node id.
 */
export function blockedAgents(
  edges: CritEdge[],
  status: Map<string, NodeStatus>,
  known: Set<string>
): BlockedAgent[] {
  const up = buildUpstream(edges, known)
  const out: BlockedAgent[] = []
  for (const [nodeId, sources] of up) {
    if (!isWaiting(status.get(nodeId))) continue
    const waitingOn = sources.filter((s) => isBusy(status.get(s)))
    if (!waitingOn.length) continue
    waitingOn.sort()
    out.push({ nodeId, waitingOn })
  }
  out.sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
  return out
}

/**
 * Transitive downstream set of a node over the armed dependency DAG, cycle-guarded
 * by a visited set and a hard expansion cap (mirrors flowLayout's guard). Excludes
 * the start node itself. Pure BFS.
 */
function downstreamOf(start: string, adj: Map<string, string[]>, cap: number): Set<string> {
  const seen = new Set<string>()
  let frontier = [start]
  let guard = 0
  while (frontier.length && guard <= cap) {
    guard++
    const next: string[] = []
    for (const u of frontier) {
      for (const v of adj.get(u) ?? []) {
        if (v === start || seen.has(v)) continue
        seen.add(v)
        next.push(v)
      }
    }
    frontier = next
  }
  return seen
}

/**
 * BOTTLENECK — the single BUSY (working/error) node maximizing the count of
 * transitively-downstream BLOCKED agents. That is the agent the most pending work
 * hangs on; unblocking it releases the most of the mission. Ties are broken by
 * node id for determinism. Returns null when no busy node holds up any blocked
 * downstream agent (precision-over-recall: nothing ambiguous is surfaced).
 */
export function bottleneck(
  edges: CritEdge[],
  status: Map<string, NodeStatus>,
  known: Set<string>
): { id: string | null; held: number } {
  const adj = buildDeps(edges, known)
  const cap = traversalCap(edges)
  const blockedIds = new Set(blockedAgents(edges, status, known).map((b) => b.nodeId))
  if (!blockedIds.size) return { id: null, held: 0 }

  let bestId: string | null = null
  let bestHeld = 0
  // Candidate bottlenecks: busy nodes that actually emit a dependency edge.
  for (const sourceId of adj.keys()) {
    if (!isBusy(status.get(sourceId))) continue
    const down = downstreamOf(sourceId, adj, cap)
    let held = 0
    for (const d of down) if (blockedIds.has(d)) held++
    if (held === 0) continue
    if (held > bestHeld || (held === bestHeld && bestId !== null && sourceId < bestId)) {
      bestHeld = held
      bestId = sourceId
    }
  }
  return { id: bestId, held: bestHeld }
}

/**
 * CRITICAL CHAIN — the longest downstream path of node ids starting at the
 * bottleneck, for camera cycling along "where the mission is stuck". Greedy
 * longest-path over the armed DAG, cycle-guarded by a visited set + the expansion
 * cap. Returns [] when there is no bottleneck. The chain always starts with the
 * bottleneck id.
 */
export function criticalChain(
  bottleneckId: string | null,
  edges: CritEdge[],
  known: Set<string>
): string[] {
  if (!bottleneckId || !known.has(bottleneckId)) return []
  const adj = buildDeps(edges, known)
  const cap = traversalCap(edges)

  // Memoized longest-downstream-path length per node, cycle-guarded via the
  // in-progress set so a relay loop can never recurse forever.
  const lenMemo = new Map<string, number>()
  const inProgress = new Set<string>()
  const longestLen = (id: string, depth: number): number => {
    if (depth > cap) return 1
    if (lenMemo.has(id)) return lenMemo.get(id)!
    if (inProgress.has(id)) return 1 // cycle: treat as a leaf
    inProgress.add(id)
    let best = 1
    for (const v of adj.get(id) ?? []) {
      best = Math.max(best, 1 + longestLen(v, depth + 1))
    }
    inProgress.delete(id)
    lenMemo.set(id, best)
    return best
  }

  const chain: string[] = []
  const visited = new Set<string>()
  let cur: string | null = bottleneckId
  let guard = 0
  while (cur && !visited.has(cur) && guard <= cap) {
    guard++
    chain.push(cur)
    visited.add(cur)
    // Pick the downstream neighbor with the longest remaining path; tie-break by
    // id for determinism. Skip already-visited to defuse cycles.
    let nextId: string | null = null
    let nextLen = -1
    for (const v of adj.get(cur) ?? []) {
      if (visited.has(v)) continue
      const l = longestLen(v, 0)
      if (l > nextLen || (l === nextLen && nextId !== null && v < nextId)) {
        nextLen = l
        nextId = v
      }
    }
    cur = nextId
  }
  return chain
}

/**
 * Compose the full Critical Path readout from the armed relay edges, the live
 * status map, and the known node set. Single deterministic entry point used by the
 * relay store selector + CriticalPathChip. Precision-over-recall: when there is no
 * unambiguous bottleneck, bottleneckId is null and chain is empty (the chip then
 * renders nothing). Pure.
 */
export function computeCriticalPath(
  edges: CritEdge[],
  status: Map<string, NodeStatus>,
  known: Set<string>
): CriticalPath {
  const blocked = blockedAgents(edges, status, known)
  const { id: bottleneckId, held: bottleneckHeld } = bottleneck(edges, status, known)
  const chain = criticalChain(bottleneckId, edges, known)
  return { blocked, bottleneckId, bottleneckHeld, chain }
}
