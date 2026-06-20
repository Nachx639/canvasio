// lensExcerpt.ts
//
// Pure helper for Agent Lens: pick the single most-recent MEANINGFUL line from
// an ANSI-stripped output chunk. "Meaningful" means a human could read it and
// learn what the agent is doing — so we drop the noise the terminal emits on
// every frame: blank lines, spinner-only/progress-bar lines, box-drawing chrome,
// and the persistent TUI footers agentStatus.ts already documents (e.g. the
// "bypass permissions" hint Claude Code renders forever while happily working).
//
// Import-free and deterministic so it is trivially unit-testable. The input is
// already ANSI-stripped by the caller (stripAnsi in agentStatus.ts), so this
// never re-runs that regex.

/** Hard cap on the returned excerpt so a single huge line can't bloat the UI. */
const MAX_LEN = 120

// A line that, once trimmed, contains ONLY spinner glyphs, block/progress-bar
// glyphs, box-drawing chars, dots/dashes, and whitespace carries no readable
// information. These are the exact spinner/progress glyph families agentStatus.ts
// keys off, plus the Unicode box-drawing range used by TUI frames.
// eslint-disable-next-line no-control-regex
const NOISE_ONLY_RE =
  /^[\s.\-_=~·•│┃─━┄┅┈┉┌┐└┘├┤┬┴┼╭╮╯╰║═╔╗╚╝╠╣╦╩╬▏▎▍▌▋▊▉█▁▂▃▄▅▆▇░▒▓⠀-⣿◢◣◤◥▶▷◀◁►◄⏵⏶⏷⏴]+$/

// Persistent TUI footers / chrome that render on EVERY frame regardless of what
// the agent is doing. Surfacing these as "what it's doing" would be misleading,
// so we skip a line when it matches one of them. Mirrors the "do NOT match"
// notes in agentStatus.ts (notably the bypass-permissions footer).
const FOOTER_RE =
  /(bypass permissions|shift\+tab to cycle|esc to interrupt|ctrl\+c to|ctrl-c to|\? for shortcuts|press \? for|tab to|to cycle\)|↑↓ to|enter to send)/i

/** Collapse internal runs of whitespace and trim the ends. */
function squash(line: string): string {
  return line.replace(/\s+/g, ' ').trim()
}

/**
 * Is this (already-trimmed, non-empty) line worth showing as "what it's doing"?
 * Rejects pure-noise lines and persistent footers; keeps anything else.
 */
export function isMeaningfulLine(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  if (NOISE_ONLY_RE.test(t)) return false
  if (FOOTER_RE.test(t)) return false
  return true
}

/**
 * Walk an ANSI-stripped chunk from the END and return the first meaningful line,
 * squashed and capped to MAX_LEN. Returns null when the chunk holds nothing
 * readable (all blank / spinner / footer noise) so the caller can leave the
 * previous excerpt untouched.
 */
export function lastMeaningfulLine(cleanChunk: string): string | null {
  if (!cleanChunk) return null
  // \r without \n (carriage-return progress redraws) shouldn't merge two logical
  // lines into one — treat a bare CR as a line break too.
  const lines = cleanChunk.split(/\r\n|\r|\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i]
    if (!raw.trim()) continue
    if (!isMeaningfulLine(raw)) continue
    const squashed = squash(raw)
    if (!squashed) continue
    return squashed.length > MAX_LEN ? squashed.slice(0, MAX_LEN - 1) + '…' : squashed
  }
  return null
}
