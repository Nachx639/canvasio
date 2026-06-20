// insightHarvest.ts
//
// Insight Harvester — the PURE classifier that lets the shared agent context pool
// (the Brief Board, store/board.ts) populate ITSELF. Given a single, already
// ANSI-stripped + squashed "meaningful line" — the exact one TerminalOverlay
// hands to Agent Lens + Echo on every coalesced chunk (TerminalOverlay ~line 810)
// — it decides whether that line is a DISCOVERY-grade fact worth auto-pinning,
// and if so returns a cleaned, capped fact string. Otherwise it returns null and
// the line is dropped.
//
// Design contract (mirrors lensExcerpt.ts / agentStatus.ts):
//   - Import-free, deterministic, no React / store / IPC. Trivially unit-testable.
//   - The caller (TerminalOverlay) does the throttle, the settings gate, and the
//     store write. This file only CLASSIFIES + CLEANS. It never has side effects.
//   - Precision over recall: we would much rather miss a real insight than spam
//     the board with chatter. When unsure, return null.
//
// What counts as a discovery-grade insight (Spanish + English):
//   * DECISIONS        "decided to use Postgres", "vamos a usar Redis",
//                      "we'll go with bearer auth", "use the /v2 endpoint"
//   * FINDINGS / ROOT  "turns out the API base is /v2", "root cause: race in pty",
//     CAUSE            "the bug is in pty.ts", "resulta que el token expira"
//   * FILE:LINE refs   "error in src/main/pty.ts:240", "fix at index.ts:88"
//   * DEFINITIONS      "the API base is /v2", "auth is a bearer token",
//                      "el endpoint es /login"
//   * VERDICTS         "tests pass", "build succeeded", "fixed", "todo verde",
//                      "compila correctamente", "all 12 tests passed"
//
// What we explicitly REJECT (precision guards):
//   * Questions             lines ending in "?" (or "¿…?") — not a finding.
//   * Bare shell commands   lines that start with a prompt sigil ($, #, ➜, ❯, »).
//   * Pure progress/status   spinner-ish or "downloading…", "installing…",
//                            "running…", "compiling…" with no conclusion.
//   * Footers / TUI chrome   the same persistent hints lensExcerpt drops, in case
//                            one slips through (defense in depth).
//   * Too short / too long   < 12 readable chars, or after-clean fragments.
//
// Quick examples (input -> output):
//   harvestFrom("turns out the API base is /v2")        -> "turns out the API base is /v2"
//   harvestFrom("Decidimos usar Postgres para la cola") -> "Decidimos usar Postgres para la cola"
//   harvestFrom("✓ tests pass (12 passed)")             -> "✓ tests pass (12 passed)"  (✓ kept, it's signal)
//   harvestFrom("The bug is in src/main/pty.ts:240")    -> "The bug is in src/main/pty.ts:240"
//   harvestFrom("Should I use Redis here?")             -> null   (question)
//   harvestFrom("$ npm install")                        -> null   (bare command)
//   harvestFrom("Downloading dependencies…")            -> null   (pure progress)
//   harvestFrom("ok")                                   -> null   (too short)

/** Cap on a harvested fact; board.ts caps again at 200, this keeps it tighter. */
const MAX_LEN = 160
/** A line shorter than this (after cleaning) can't carry a real finding. */
const MIN_LEN = 12

// Persistent TUI footers / chrome — defense in depth; lensExcerpt already drops
// most, but the harvester is conservative so it re-checks.
const FOOTER_RE =
  /(bypass permissions|shift\+tab to cycle|esc to interrupt|ctrl\+c to|ctrl-c to|\? for shortcuts|press \? for|to cycle\)|↑↓ to|enter to send)/i

// A line that's just an agent asking a question is not a discovery. Catch both a
// trailing "?" and the Spanish inverted opener.
const QUESTION_RE = /\?\s*$|^\s*¿/

// Bare shell command: starts with a prompt sigil. We don't want to pin the user's
// (or the agent's) typed command, only conclusions drawn from running it.
const PROMPT_SIGIL_RE = /^\s*[$#➜❯»▶]\s/

// Pure progress / in-flight status with no conclusion yet. These are the verbs
// that describe ongoing work; a verdict (see VERDICT_RE) overrides this.
const PROGRESS_RE =
  /^(downloading|installing|running|compiling|building|fetching|cloning|loading|starting|waiting|connecting|resolving|descargando|instalando|ejecutando|compilando|construyendo|cargando|esperando|conectando)\b.*(…|\.\.\.)?\s*$/i

// ---- POSITIVE signals (any one match -> candidate insight) -------------------

// Decisions: "decided to", "we'll use", "let's go with", "use X", + Spanish.
const DECISION_RE =
  /\b(decided to|we(?:'ll| will| should)? (?:use|go with)|let'?s (?:use|go with)|going to use|i'?ll use|chose to|opted? for|use the\b|decidi(?:mos|do|ó)?\b|vamos a usar|usaremos|usemos|optamos por|elegimos|hay que usar)\b/i

// Findings / root cause / conclusions: the language of having figured something
// out. "turns out", "root cause", "the bug is", "the issue is", "because", etc.
const FINDING_RE =
  /\b(turns out|root cause|the (?:bug|issue|problem|error|cause) (?:is|was|lies)|it'?s (?:because|caused by)|caused by|because the|due to a|the fix (?:is|was)|the reason (?:is|was)|i found that|found the|discovered that|resulta que|la causa (?:es|era)|el (?:bug|error|problema|fallo) (?:est[áa]|es|era)|porque (?:el|la|los|las)\b|se debe a|el motivo es|encontr[ée] que)\b/i

// Definitions: "X is the …", "auth is bearer", "the API base is /v2", "el … es …".
// We require the predicate to look concrete (a value, path, identifier, or noun)
// so generic "this is great" doesn't match: the value must contain a slash, a
// digit, a dotted/identifier token, or a quoted/backticked snippet.
const DEFINITION_RE =
  /\b(?:is|are|=|:|es|son)\s+["'`]?\/?[\w@.\-/]*[\w\d/@][\w@.\-/]*/i
// A softer definition cue — "X is the Y", "the base is /v2" — that we still want
// to keep when it talks about API/auth/endpoint/base/url/port/token/key/config.
const DEFINITION_TOPIC_RE =
  /\b(api|auth|authentication|endpoint|base ?url|base|url|port|puerto|token|key|clave|secret|config|env|variable|schema|table|tabla|route|ruta|path|version|versi[óo]n)\b/i

// file:line locations: "src/main/pty.ts:240", "index.ts:88", "App.tsx:12:4".
const FILE_LINE_RE = /[\w./\\-]+\.[a-z0-9]{1,5}:\d+/i

// Verdicts: success/failure conclusions worth carrying to the next agent.
const VERDICT_RE =
  /\b(tests? (?:pass(?:ed|es)?|fail(?:ed|s)?)|all (?:\d+ )?tests? (?:pass|passed)|build (?:succeed(?:ed)?|pass(?:ed)?|fail(?:ed)?|broke)|compil(?:es|ed) (?:successfully|ok|clean)|fixed\b|resolved\b|works now|now works|it works|done\b|complete[d]?\b|deployed\b|merged\b|pruebas? (?:pasan|pasaron|fallan|fallaron)|compila (?:bien|correctamente|ok)|arreglad[oa]|resuelt[oa]|funciona(?:\b| ahora)|listo\b|terminad[oa]|desplegad[oa])\b/i

/** Collapse internal whitespace and trim. */
function squash(line: string): string {
  return line.replace(/\s+/g, ' ').trim()
}

/**
 * Strip leading chrome the agent renders before real content — list bullets,
 * tree glyphs, the leading status checkmark/cross/arrow — WITHOUT discarding the
 * checkmark when it is the only success signal (we keep a single leading ✓/✗ if
 * present, since "✓ tests pass" reads better with it). Returns the cleaned line.
 */
function cleanLeading(line: string): string {
  let t = line
  // Drop leading list/tree chrome (but not ✓/✗ which can be meaningful signal).
  t = t.replace(/^\s*[-*•·▸▹◦‣⁃|└├─\s]+/, '')
  return t.trim()
}

/**
 * Is this (already meaningful, ANSI-stripped) line a discovery-grade insight?
 * Pure predicate; applies the reject guards first, then requires at least one
 * positive signal. Conservative by design.
 */
export function isInsight(line: string): boolean {
  const raw = squash(line || '')
  if (!raw) return false

  // ---- reject guards (cheap, run first) ----
  if (FOOTER_RE.test(raw)) return false
  if (QUESTION_RE.test(raw)) return false
  if (PROMPT_SIGIL_RE.test(raw)) return false

  const t = cleanLeading(raw)
  if (t.length < MIN_LEN) return false

  // Verdicts win over the progress guard ("build succeeded" mustn't be eaten by
  // a "building…" style match), so check it before rejecting progress lines.
  const verdict = VERDICT_RE.test(t)
  if (!verdict && PROGRESS_RE.test(t)) return false

  // ---- positive signals ----
  if (verdict) return true
  if (FILE_LINE_RE.test(t)) return true
  if (DECISION_RE.test(t)) return true
  if (FINDING_RE.test(t)) return true
  // Definitions need both a concrete value-shaped predicate AND a topic word, so
  // we don't pin every "x is y" sentence — only ones that name a config/locus.
  if (DEFINITION_RE.test(t) && DEFINITION_TOPIC_RE.test(t)) return true

  return false
}

/**
 * Classify + clean. Returns a normalized, capped fact string when `line` is a
 * discovery-grade insight, or null otherwise. The caller (TerminalOverlay) is
 * responsible for the throttle, the settings gate, and the board.pin() write.
 */
export function harvestFrom(line: string): string | null {
  if (!isInsight(line)) return null
  let fact = cleanLeading(squash(line))
  if (!fact) return null
  if (fact.length > MAX_LEN) fact = fact.slice(0, MAX_LEN - 1) + '…'
  return fact
}
