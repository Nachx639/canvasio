// boardFormat.ts
//
// Pure, import-free, unit-testable formatter for the Brief Board. Turns the
// shared pool of pinned facts into ONE compact, terminal-safe context block that
// is delivered to an agent through the EXISTING pendingPrompt / pty.write path
// (the caller appends a single trailing '\r' to submit, exactly like a spawn
// task or an Agent Relay handoff).
//
// Terminal-safety contract: the body MUST NOT contain a newline, because the
// delivery path submits the prompt with one '\r' — an embedded newline inside a
// TUI input would prematurely send a partial line. We therefore join facts with
// " · " on a SINGLE line (mirroring how pendingPrompt text is a single line that
// the caller submits). An empty board returns '' so callers can skip delivery.

/** Shape this needs from a fact; structural so it doesn't import the store type. */
interface FactLike {
  text: string
  sourceTitle?: string
  agent?: string
}

/** Total cap on the produced block so an oversized board can't flood the TUI. */
const MAX_TOTAL = 1200

/**
 * Build a one-line, terminal-safe shared-context block from the board facts.
 * Each fact is rendered as "[Attribution] text" (attribution = source title or
 * agent, omitted when neither is known), facts joined by " · ". Returns '' for
 * an empty board. The whole block is capped to MAX_TOTAL chars.
 */
export function formatBoardForInjection(facts: FactLike[]): string {
  if (!facts || facts.length === 0) return ''
  const parts: string[] = []
  for (const f of facts) {
    // Collapse any stray newline/whitespace so the block stays a single line.
    const text = (f.text || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const who = (f.sourceTitle || f.agent || '').replace(/\s+/g, ' ').trim()
    parts.push(who ? `[${who}] ${text}` : text)
  }
  if (parts.length === 0) return ''
  let block = 'Contexto compartido del equipo: ' + parts.join(' · ')
  if (block.length > MAX_TOTAL) block = block.slice(0, MAX_TOTAL - 1) + '…'
  return block
}
