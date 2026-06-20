// tripwireMatch.ts
//
// Pure matcher compiler for Tripwire — content-triggered output alerts. A user
// types a watch PATTERN as either plain text ("tests passed", "Allow rm -rf")
// or a `/regex/flags` literal (e.g. `/error TS\d+/i`). This module turns that
// raw string into a compiled, side-effect-free matcher and tests output lines
// against it.
//
// Discipline (mirrors lensExcerpt.ts / insightHarvest.ts): import-free,
// deterministic, no state, NEVER throws. An invalid regex degrades to a literal
// case-insensitive substring of the inner pattern text — so a half-typed
// `/foo[/` still does something useful instead of blowing up the hot scan path
// that runs per output line. The input line is assumed already ANSI-stripped by
// the caller (the Echo chokepoint), so we never re-run that pass here.

/** A compiled, ready-to-test matcher. Opaque to callers besides `matches`. */
export interface CompiledTripwire {
  /** how the pattern was interpreted (for UI / debugging). */
  kind: 'substring' | 'regex'
  /** lowercased substring needle (kind === 'substring'). */
  needle?: string
  /** compiled RegExp (kind === 'regex'). */
  re?: RegExp
}

/** Detect a `/body/flags` regex literal and split out body + flags. */
function parseRegexLiteral(raw: string): { body: string; flags: string } | null {
  // Must start with `/` and have a closing `/` somewhere after the first char.
  if (raw.length < 2 || raw[0] !== '/') return null
  const close = raw.lastIndexOf('/')
  if (close <= 0) return null
  const body = raw.slice(1, close)
  const flags = raw.slice(close + 1)
  if (!body) return null
  // Only allow real RegExp flag chars; anything else means this wasn't a
  // regex literal (treat the whole thing as plain text instead).
  if (flags && !/^[gimsuy]*$/.test(flags)) return null
  return { body, flags }
}

/**
 * Compile a raw user pattern into a matcher. Plain text becomes a
 * case-insensitive substring; a `/…/flags` literal becomes a RegExp (always
 * given the `i` flag if the user omitted it, matching the substring path's
 * case-insensitivity). An invalid regex falls back to a case-insensitive
 * substring of the inner body. An empty/whitespace pattern compiles to a matcher
 * that never fires. Never throws.
 */
export function compileTripwire(pattern: string): CompiledTripwire {
  const raw = (pattern ?? '').trim()
  if (!raw) return { kind: 'substring', needle: '' }

  const lit = parseRegexLiteral(raw)
  if (lit) {
    const flags = lit.flags.includes('i') ? lit.flags : lit.flags + 'i'
    try {
      return { kind: 'regex', re: new RegExp(lit.body, flags) }
    } catch {
      // Invalid regex body — degrade to a literal substring of the body so the
      // wire still does something sensible and the scan path never throws.
      return { kind: 'substring', needle: lit.body.toLowerCase() }
    }
  }

  return { kind: 'substring', needle: raw.toLowerCase() }
}

/**
 * Does `line` trip this compiled matcher? Empty-needle matchers never fire (so
 * an empty pattern can't alert on every single line). Pure and total — for a
 * stateful regex (global/sticky flag) we reset lastIndex so repeated calls are
 * deterministic. Never throws.
 */
export function matches(compiled: CompiledTripwire, line: string): boolean {
  if (!line) return false
  if (compiled.kind === 'regex' && compiled.re) {
    const re = compiled.re
    // Global/sticky regexes carry lastIndex across calls; reset for determinism.
    if (re.lastIndex !== 0) re.lastIndex = 0
    try {
      return re.test(line)
    } catch {
      return false
    }
  }
  const needle = compiled.needle
  if (!needle) return false
  return line.toLowerCase().includes(needle)
}
