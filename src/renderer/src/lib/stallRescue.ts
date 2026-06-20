// stallRescue.ts
//
// Pure, import-free (types-only), unit-testable composer for Stall Watch's rescue
// message. When a blocked agent is nudged, we hand it back the team's accumulated
// shared context (the Brief Board facts) plus its own last Agent Lens line, so the
// rescue carries REAL context instead of a generic "are you stuck?" poke.
//
// Mirrors the design contract of lib/missionBrief.ts / lib/boardFormat.ts:
//   - imports ONLY types (no zustand stores, no React, no IPC, no main process),
//   - never mutates its inputs,
//   - is fully deterministic given the same inputs (trivially unit-testable).
//
// Terminal-safety contract (shared with boardFormat.ts): the produced string is
// delivered through the SAME readiness-gated relay drain path that submits a
// prompt with a single trailing '\r'. An embedded newline inside a TUI input box
// would prematurely send a partial line, so the body MUST stay a single line. We
// therefore join everything with " · " on ONE line and collapse any stray
// whitespace, exactly like formatBoardForInjection.

/** Structural shape of a board fact this needs; avoids importing the store type. */
export interface RescueFactLike {
  text: string
  sourceNodeId?: string
  sourceTitle?: string
  agent?: string
}

/** How many board facts (at most) to fold into a single rescue message. */
const MAX_FACTS = 4
/** Per-fact text cap so one huge fact can't dominate the rescue. */
const MAX_FACT_LEN = 140
/** Cap on the last-Lens-line excerpt embedded in the rescue. */
const MAX_LENS_LEN = 140
/** Total cap on the produced rescue so an oversized board can't flood the TUI. */
const MAX_TOTAL = 1000

/** Collapse internal runs of whitespace and trim the ends (single-line safe). */
function squash(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim()
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/**
 * Compose a compact, single-line, terminal-safe Spanish rescue message for a
 * stalled node.
 *
 * Fact selection mirrors the Brief Board injection discipline: we PREFER facts
 * discovered by OTHER agents (sourceNodeId !== the stalled node) — those are the
 * useful cross-agent context the stuck agent likely lacks — falling back to its
 * own facts only to fill up to MAX_FACTS. Most-recent facts (end of the array,
 * matching board.ts's append order) are kept first.
 *
 * Returns '' when there is genuinely nothing to say (no facts AND no lens line),
 * so the caller can still nudge with a bare prompt if it chooses, or skip.
 */
export function composeRescue(
  stalledNodeId: string,
  facts: RescueFactLike[],
  lastLensLine?: string | null
): string {
  // Newest-first so the rescue leads with the freshest shared context.
  const ordered = [...(facts || [])].reverse()
  const others = ordered.filter((f) => f.sourceNodeId && f.sourceNodeId !== stalledNodeId)
  const own = ordered.filter((f) => !f.sourceNodeId || f.sourceNodeId === stalledNodeId)
  // Prefer cross-agent context; backfill with the node's own facts up to the cap.
  const picked = [...others, ...own].slice(0, MAX_FACTS)

  const factParts: string[] = []
  for (const f of picked) {
    const text = squash(f.text)
    if (!text) continue
    const who = squash(f.sourceTitle || f.agent || '')
    const line = who ? `[${who}] ${text}` : text
    factParts.push(clip(line, MAX_FACT_LEN))
  }

  const lens = clip(squash(lastLensLine || ''), MAX_LENS_LEN)

  const segments: string[] = []
  if (factParts.length) segments.push('Contexto del equipo: ' + factParts.join(' · '))
  if (lens) segments.push('Tu último estado: ' + lens)
  if (segments.length === 0) return ''

  // Closing instruction: tell the stuck agent what we actually want from it.
  segments.push('Responde a lo que esté pendiente o continúa.')

  let out = segments.join(' · ')
  if (out.length > MAX_TOTAL) out = out.slice(0, MAX_TOTAL - 1) + '…'
  return out
}

/**
 * Pure stall-detection predicate, factored out of the store so it is deterministic
 * and unit-testable given (status, lastEventTs, now, threshold). A node counts as
 * stalled when:
 *   - its current canvas status is 'waiting' or 'error' (it needs the operator), AND
 *   - its most-recent mission event is older than `stallMs` (no fresh activity).
 *
 * `lastEventTs` is the ts of the node's newest mission event (or 0/undefined if it
 * has none — a node with no recorded activity is never considered stalled here,
 * since Stall Watch only seeds itself from the live feed). `now` is injected for
 * determinism in tests.
 */
export function isStalled(
  status: string | undefined,
  lastEventTs: number | undefined,
  now: number,
  stallMs: number
): false | 'waiting' | 'error' {
  if (status !== 'waiting' && status !== 'error') return false
  if (!lastEventTs || lastEventTs <= 0) return false
  if (now - lastEventTs < stallMs) return false
  return status
}
