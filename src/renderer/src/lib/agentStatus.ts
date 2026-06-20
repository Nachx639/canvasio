// agentStatus.ts
//
// Best-effort inference of an AI agent's status from streaming terminal output.
//
// We keep a small rolling buffer of recent, ANSI-stripped output per classifier
// and apply per-agent heuristics. The whole module is pure/testable: state is
// held in an explicit `Classifier` object you create with `createClassifier`,
// and `classifyChunk` returns the new status (or null when unchanged).

import type { AgentKind } from '../store/canvas'

/** Visual statuses understood by the store. */
export type NodeStatus = 'idle' | 'working' | 'done' | 'error'

/**
 * Richer internal status. `waiting` is a distinct logical state (the agent is
 * blocked on the user) which callers may map to a visual status of their choice.
 * The store only knows idle/working/done/error, so `mapToVisual` collapses
 * `waiting` -> `working` by default.
 */
export type AgentStatus = 'idle' | 'working' | 'waiting' | 'done' | 'error'

export function mapToVisual(s: AgentStatus): NodeStatus {
  // `waiting` is shown as `working` (a pulsing dot) unless the UI adds a state.
  if (s === 'waiting') return 'working'
  return s
}

// --- ANSI / control-sequence stripping -------------------------------------

// Covers CSI sequences (colors, cursor moves), OSC sequences (titles, hyperlinks)
// and lone control chars. Robust to the noise xterm-bound CLIs emit constantly.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '')
}

// --- Rolling buffer classifier ---------------------------------------------

const BUFFER_LIMIT = 4000 // chars of recent (clean) output we keep around
const WORKING_DEBOUNCE_MS = 600 // brief working flickers are smoothed out

export interface Classifier {
  agent: AgentKind
  /** rolling window of recent ANSI-stripped output (lower-cased copy below) */
  buffer: string
  /** last status we *returned* to the caller */
  status: AgentStatus
  /** timestamp we first observed a pending 'working' that we haven't emitted */
  pendingWorkingSince: number | null
}

export function createClassifier(agent: AgentKind, initial: AgentStatus = 'idle'): Classifier {
  return {
    agent,
    buffer: '',
    status: initial,
    pendingWorkingSince: null
  }
}

// Patterns shared across all agents. Order in the detector below encodes
// priority (error > waiting > done > working).

// STRONG error signals only. We deliberately do NOT match the bare substring
// "error" anywhere (it shows up constantly in banners, URLs, help text, "no
// errors", "error handling", tips, etc.). Instead we require line-anchored,
// high-confidence markers: a line that *starts* with an error keyword, a known
// fatal runtime crash, a missing-command shell error, or an explicit non-zero
// exit. Matching is line-by-line via the `m` flag and `^` anchors.
const ERROR_RE = new RegExp(
  [
    // A line beginning with Error / error: / fatal: / err: — require the colon
    // (or a bracket, e.g. "[error]") so prose like "Error handling is..." or
    // "fatal flaws aside" never matches.
    String.raw`^\s*(?:error|err|fatal)\s*[:\]]`,
    String.raw`^\s*\[\s*(?:error|fatal)\s*\]`,
    String.raw`^\s*fatal error\b`,
    // Python tracebacks
    String.raw`^traceback \(most recent call last\)`,
    // Shell "not found" style failures
    String.raw`^.*\bcommand not found\b`,
    String.raw`^\s*no such file or directory\b`,
    String.raw`^\s*permission denied\b`,
    // Native crashes
    String.raw`^panic:`,
    String.raw`^\s*segmentation fault\b`,
    String.raw`^\s*\w+error:`, // ReferenceError:, TypeError:, SyntaxError: at line start
    String.raw`^\s*(?:unhandled |uncaught )?exception\b`,
    // Explicit non-zero exit lines ("exited with code 1", "exit status 1", etc.)
    String.raw`\bexit(?:ed)?\s+(?:with\s+)?(?:code|status)\s+(?!0\b)\d+`,
    String.raw`\bexit code:?\s*(?!0\b)\d+`
  ].join('|'),
  'im'
)

// NOTE: we deliberately do NOT match "bypass permissions" here. Claude Code (and
// similar TUIs) render a *persistent* footer like
//   "⏵⏵ bypass permissions on (shift+tab to cycle)"
// on every frame while the agent is perfectly happy and working. Matching it
// would pin the node to 'waiting' forever. We also avoid a bare "allow" (it
// appears constantly in prose: "allow the user to…") and instead require it to
// be an actual interactive permission question.
const WAITING_RE =
  /(\(y\/n\)|\[y\/n\]|\(yes\/no\)|do you want|do you trust|allow this (?:command|action|tool|edit|request)\??|allow\?|press enter|press \[enter\]|continue\?|proceed\?|\? *$|❯ *(?:1\.|yes)|necesitas? (?:confirmar|aprobar)|¿(?:deseas|quieres|continuar))/i

// "done" — fresh idle shell prompt or explicit completion.
const DONE_RE =
  /(process exited|\bdone\b|completed successfully|all tests passed|✔ .*(done|complete)|terminado|listo|completado|finished)/i

// Idle shell prompt at the very end of the buffer (zsh/bash/p10k style).
const SHELL_PROMPT_RE = /(?:^|\n)[^\n]*(?:\$|➜|%|#)\s*$/

const WORKING_RE =
  /(esc to interrupt|interrupt\)|\bworking\b|nesting|cogitating|thinking|pondering|brewing|crunching|\brunning\b|compiling|installing|downloading|building|generating|analyz(?:e|ing)|↓ *\d+ *tokens?|↑ *\d+ *tokens?|\b\d+ *tokens?\b|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|⣾|⣽|⣻|⢿|⡿|⣟|⣯|⣷|[▁▂▃▄▅▆▇█])/i

// Bracketed tool calls Claude/agents emit: Read(...), Update(...), Bash(...), etc.
const TOOL_CALL_RE =
  /\b(Read|Write|Edit|Update|MultiEdit|Bash|Grep|Glob|Search|Task|WebFetch|WebSearch|NotebookEdit|TodoWrite|Run)\s*\(/

// The agent's own empty input box returning (a `>` prompt with nothing after it)
// signals it finished and is idle again. Only meaningful for the rich CLIs.
const AGENT_INPUT_IDLE_RE = /(?:^|\n)\s*(?:>|│ *>)\s*$/

/**
 * Inspect only the tail of the buffer for "the agent went idle" signals, since
 * a prompt only counts if it's the *last* thing on screen.
 */
function tailLooksIdle(buf: string, agent: AgentKind): boolean {
  const tail = buf.slice(-240)
  if (SHELL_PROMPT_RE.test(tail)) return true
  if ((agent === 'claude' || agent === 'codex' || agent === 'cursor') && AGENT_INPUT_IDLE_RE.test(tail))
    return true
  return false
}

/**
 * Core pure detector: given the current clean buffer + agent, return the raw
 * status implied by the *content*, ignoring debounce/transition rules.
 * Returns null when nothing conclusive is present.
 */
function detect(buf: string, agent: AgentKind): AgentStatus | null {
  // Look mainly at the recent tail so stale matches don't stick forever.
  const recent = buf.slice(-1200)

  if (ERROR_RE.test(recent)) return 'error'
  if (WAITING_RE.test(recent)) return 'waiting'

  // Active-work signals take precedence over an idle-looking prompt that may
  // just be the scrollback above a spinner.
  const working = WORKING_RE.test(recent) || TOOL_CALL_RE.test(recent)

  if (tailLooksIdle(buf, agent)) {
    // A trailing shell/input prompt means the foreground work has yielded.
    if (DONE_RE.test(recent)) return 'done'
    return working ? 'working' : 'done'
  }

  if (DONE_RE.test(recent)) return 'done'
  if (working) return 'working'
  return null
}

/**
 * Feed a streamed chunk into the classifier. Returns the new status if it
 * changed (already collapsed to a logical AgentStatus), or null if unchanged.
 *
 * `now` is injectable for deterministic tests.
 */
export function classifyChunk(
  prev: Classifier,
  dataChunk: string,
  agent: AgentKind = prev.agent,
  now: number = Date.now()
): AgentStatus | null {
  const clean = stripAnsi(dataChunk)
  if (clean.length) {
    prev.buffer = (prev.buffer + clean).slice(-BUFFER_LIMIT)
  }
  prev.agent = agent

  const detected = detect(prev.buffer, agent)
  if (detected === null) return null
  if (detected === prev.status) {
    // Already in this state; clear any stale pending-working timer.
    if (detected !== 'working') prev.pendingWorkingSince = null
    return null
  }

  // Debounce ONLY transitions *into* working, so a one-frame spinner between
  // two stable states doesn't spam updates. Terminal states (done/error/
  // waiting) are emitted immediately.
  if (detected === 'working') {
    if (prev.pendingWorkingSince == null) {
      prev.pendingWorkingSince = now
      return null
    }
    if (now - prev.pendingWorkingSince < WORKING_DEBOUNCE_MS) {
      return null
    }
    prev.pendingWorkingSince = null
    prev.status = 'working'
    return 'working'
  }

  prev.pendingWorkingSince = null
  prev.status = detected
  return detected
}

/** Convenience: classify and return the *visual* status change for the store. */
export function classifyChunkVisual(
  prev: Classifier,
  dataChunk: string,
  agent: AgentKind = prev.agent,
  now: number = Date.now()
): { logical: AgentStatus; visual: NodeStatus } | null {
  const logical = classifyChunk(prev, dataChunk, agent, now)
  if (logical === null) return null
  return { logical, visual: mapToVisual(logical) }
}
