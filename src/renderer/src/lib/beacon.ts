// beacon.ts
//
// PURE full-text search over a snapshot of every live terminal's scrollback.
// No DOM, no stores, no IPC: it takes a Map<nodeId, string[]> of already-read
// scrollback lines plus a needle, and returns ranked, capped hits with a per-
// node match count + a trimmed excerpt windowed around each match. This is the
// first CanvasIO search primitive that navigates by CONTENT (what agents SAID)
// instead of node metadata (title/subtitle/agentLabel/status).
//
// Determinism: results are ordered by node READING ORDER (the iteration order of
// the snapshot Map, which TerminalOverlay registers in spawn order) then by line
// index, so the same snapshot + needle always yields the same ranking. Both the
// per-node hit count and the total hit count are capped so a pathological match
// (e.g. searching " " across 8000-line buffers) can never blow up the panel.

/** A single content match: which node, which line, where in the line, + excerpt. */
export interface BeaconHit {
  /** Canvas node id whose terminal scrollback this line belongs to. */
  nodeId: string
  /** 0-based index into that node's scrollback line array (drives scrollToLine). */
  line: number
  /** 0-based column of the match start within the (untrimmed) source line. */
  col: number
  /** The source line trimmed to a window around the match (for display). */
  excerpt: string
  /** Offset of the match within `excerpt` (so the UI can highlight it). */
  excerptCol: number
  /** Length of the matched needle (for highlighting). */
  matchLen: number
}

/** Grouped result: one node, its total match count, and its (capped) hits. */
export interface BeaconNodeResult {
  nodeId: string
  /** Total matches found in this node BEFORE the per-node cap (true count). */
  count: number
  /** The hits actually surfaced for this node (length <= perNode cap). */
  hits: BeaconHit[]
}

export interface BeaconResult {
  /** Per-node groups, in node reading order; only nodes with >=1 hit appear. */
  groups: BeaconNodeResult[]
  /** Flat hit list in the SAME order (groups concatenated) for arrow-key walk. */
  hits: BeaconHit[]
  /** Total matches across all nodes BEFORE caps (true grand total). */
  total: number
  /** True when caps clipped the surfaced results below the true total. */
  capped: boolean
}

export interface BeaconOpts {
  /** Max total hits surfaced across all nodes. Default 200. */
  cap?: number
  /** Max hits surfaced per node. Default 20. */
  perNode?: number
  /** Chars of context kept on each side of the match in the excerpt. Default 60. */
  context?: number
}

const DEFAULT_CAP = 200
const DEFAULT_PER_NODE = 20
const DEFAULT_CONTEXT = 60

/**
 * Build the trimmed excerpt window around a match. Keeps `context` chars on each
 * side, collapses leading/trailing whitespace, and prefixes/suffixes an ellipsis
 * when the window is clipped. Returns the excerpt plus the match offset INSIDE it.
 */
function makeExcerpt(
  source: string,
  col: number,
  matchLen: number,
  context: number
): { excerpt: string; excerptCol: number } {
  const start = Math.max(0, col - context)
  const end = Math.min(source.length, col + matchLen + context)
  let slice = source.slice(start, end)
  // Drop noisy leading/trailing whitespace from the slice, tracking how many
  // leading chars we removed so the highlight offset stays correct.
  const leadTrimmed = slice.length - slice.trimStart().length
  slice = slice.trim()
  const pre = start > 0 ? '…' : ''
  const post = end < source.length ? '…' : ''
  const excerptCol = pre.length + (col - start - leadTrimmed)
  return { excerpt: `${pre}${slice}${post}`, excerptCol: Math.max(0, excerptCol) }
}

/**
 * Search a scrollback snapshot for `needle` (case-insensitive). Returns ranked,
 * grouped, capped hits. An empty/whitespace needle yields no hits (the panel
 * shows nothing rather than every line). Pure — safe to unit test in isolation.
 */
export function search(
  snapshot: Map<string, string[]>,
  needle: string,
  opts: BeaconOpts = {}
): BeaconResult {
  const cap = opts.cap ?? DEFAULT_CAP
  const perNode = opts.perNode ?? DEFAULT_PER_NODE
  const context = opts.context ?? DEFAULT_CONTEXT

  const trimmed = needle.trim()
  if (!trimmed) {
    return { groups: [], hits: [], total: 0, capped: false }
  }
  const lower = trimmed.toLowerCase()
  const needleLen = trimmed.length

  const groups: BeaconNodeResult[] = []
  const flat: BeaconHit[] = []
  let total = 0
  let surfaced = 0
  let capped = false

  // Iterate in the Map's insertion order = node reading/spawn order.
  for (const [nodeId, lines] of snapshot) {
    if (!lines || lines.length === 0) continue
    const nodeHits: BeaconHit[] = []
    let nodeCount = 0

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]
      if (!raw) continue
      const hay = raw.toLowerCase()
      // First occurrence per line is enough to locate + excerpt the line; we
      // count the LINE as one match (line-granular, like grep without -o).
      const col = hay.indexOf(lower)
      if (col === -1) continue
      nodeCount++
      total++
      // Only materialize a hit while we're under both caps; the true count keeps
      // climbing regardless so the badge reflects reality.
      if (nodeHits.length < perNode && surfaced < cap) {
        const { excerpt, excerptCol } = makeExcerpt(raw, col, needleLen, context)
        nodeHits.push({ nodeId, line: i, col, excerpt, excerptCol, matchLen: needleLen })
        surfaced++
      } else {
        capped = true
      }
    }

    if (nodeCount > 0) {
      groups.push({ nodeId, count: nodeCount, hits: nodeHits })
      for (const h of nodeHits) flat.push(h)
    }
  }

  return { groups, hits: flat, total, capped }
}
