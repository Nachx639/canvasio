// commandTrail.ts
//
// Pure classifier for Command Trail — the executed-command audit layer. CanvasIO
// already observes agent STATE, latest OUTPUT line, scrollback, DIFFS, and TIME,
// but never the single most consequential thing an agent DOES: the shell commands
// it runs on your machine. This module recognizes the command an agent is about
// to run from one ANSI-stripped output line and tags it with a RISK class, so a
// keyboard-first panel can show a unified, filterable audit timeline across the
// whole fleet.
//
// Discipline (mirrors lensExcerpt.ts / tripwireMatch.ts / insightHarvest.ts):
// import-free, deterministic, holds no state, NEVER throws. Precision over recall
// — when the line isn't recognizably a command invocation we return null rather
// than guess, so prose, URLs, and ordinary output don't pollute the trail. The
// input line is assumed already ANSI-stripped + squashed by the caller (the same
// chokepoint that feeds Lens/Echo/Tripwire), so we never re-run that pass.

/** Risk taxonomy for a recognized command, worst-first in display priority. */
export type CommandRisk = 'destructive' | 'network' | 'vcs' | 'buildtest' | 'benign'

/** A recognized command invocation plus its risk classification. */
export interface DetectedCommand {
  /** the command text as it will run (prompt sigil / wrapper stripped). */
  cmd: string
  /** the risk class assigned by classifyRisk. */
  risk: CommandRisk
}

/** Hard cap on stored command text so one giant line can't bloat the ring/UI. */
const MAX_LEN = 200

// A shell prompt line: an optional short user@host/path/(venv) preamble followed
// by a prompt sigil ($, ❯, ›, ▶, », or a bare > used as a prompt) and the command.
// We anchor on the sigil being followed by a space + non-space so we don't match
// redirections (`foo > bar`) or comparisons in prose. The preamble is kept short
// and free of spaces-before-sigil tricks to avoid matching arbitrary sentences.
const PROMPT_RE = /^(?:[\w@~./:\-+()]{1,40}(?:\s+[\w@~./:\-+()]{1,40}){0,3}\s+)?[$❯›▶»](?:\s+)(\S.*)$/

// A bare `> cmd` prompt (continuation / minimal PS1). Stricter than the sigil set
// above because `>` is overloaded; require the rest to look like a command token
// (starts with a word char or recognized leading symbol), not prose punctuation.
const GT_PROMPT_RE = /^>\s+([A-Za-z_./][\w./\- ]*.*)$/

// Claude Code's tool-call line: `Bash(<cmd>)` — optionally prefixed by a bullet/
// tree glyph the TUI draws (●, ⏺, •, -, *). The inner text is the literal command.
const BASH_TOOL_RE = /(?:^|\s)Bash\((.+?)\)\s*$/

// "Running `cmd`…" / "Executing `cmd`" / Spanish "Ejecutando `cmd`" — many CLIs
// and agents announce the command in backticks. Capture the backticked body.
const RUNNING_RE = /\b(?:running|executing|ejecutando|ejecuta(?:ndo)?|run)\b[:\s]+`([^`]+)`/i

/** Strip trailing ellipsis/punctuation a wrapper may append after a command. */
function tidy(raw: string): string {
  let s = raw.trim()
  // Drop a trailing "…" or "..." many "Running …" announcers add.
  s = s.replace(/(?:…|\.\.\.)\s*$/, '').trim()
  if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN - 1) + '…'
  return s
}

// Common executables we confidently treat as command first-tokens even with no
// other shell signal present (so a bare `git status` / `ls` is recognized while
// prose like "the build finally passed" is not). Not exhaustive — it just needs
// to cover the everyday tools an agent invokes; anything else still passes when it
// carries a shell SIGNAL (a flag, path, pipe, separator, glob, or env-assignment).
const KNOWN_TOOLS = new Set([
  'ls', 'cd', 'cat', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'touch', 'echo', 'pwd',
  'grep', 'rg', 'find', 'sed', 'awk', 'sort', 'uniq', 'head', 'tail', 'wc', 'cut',
  'tr', 'tee', 'xargs', 'chmod', 'chown', 'ln', 'tar', 'zip', 'unzip', 'gzip',
  'git', 'gh', 'hg', 'svn', 'diff', 'patch',
  'npm', 'pnpm', 'yarn', 'npx', 'bun', 'node', 'deno', 'tsc', 'tsx', 'vite',
  'python', 'python3', 'pip', 'pip3', 'poetry', 'uv', 'pytest', 'tox',
  'cargo', 'rustc', 'go', 'gofmt', 'make', 'cmake', 'gradle', 'mvn', 'rake', 'bundle',
  'vitest', 'jest', 'mocha', 'eslint', 'prettier',
  'docker', 'docker-compose', 'kubectl', 'helm', 'terraform',
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'netcat', 'ftp', 'ping',
  'sudo', 'doas', 'env', 'export', 'source', 'kill', 'killall', 'ps', 'top',
  'dd', 'mkfs', 'mount', 'umount', 'systemctl', 'service', 'brew', 'apt', 'apt-get',
  'yum', 'dnf', 'pacman', 'open', 'code', 'vim', 'nano', 'less', 'more', 'man',
  'dd', 'truncate', 'shutdown', 'reboot', 'halt', 'clear', 'history', 'which', 'whoami'
])

// A "shell signal": something prose almost never contains but commands routinely
// do — a flag, a path/relative-path, a pipe/redirect/background/separator, a glob,
// a subshell/quote, a backtick, or an env-assignment (FOO=bar). Its presence lets
// an UNKNOWN first token through (precision-preserving — real commands carry one).
const SIGNAL_RE = /(?:^|\s)-{1,2}[A-Za-z]|[|&;`*]|>>?|<|\$\(|\.\/|\//

/**
 * A recognized command must look like a real invocation, not a fragment of prose
 * that happened to follow a sigil. Heuristic, conservative, precision-over-recall:
 *  - the first token must START like a program/path/assignment/subshell;
 *  - then accept if the line carries a shell SIGNAL, OR the first token is a known
 *    tool, OR it's an env-assignment, OR it's a single bare token (e.g. `ls`).
 * Multi-word lowercase prose with no signal and no known tool (e.g.
 * "the build finally passed") is rejected. Pure / total.
 */
function looksLikeCommand(cmd: string): boolean {
  if (!cmd) return false
  // Must start with a program-ish token: word char, path, ./ , ~/, /, (, env=,
  // or a quote (for `"$VAR"` style). Reject leading punctuation / prose openers.
  if (!/^[A-Za-z0-9_./~("'$]/.test(cmd)) return false
  const tokens = cmd.split(/\s+/)
  const first = tokens[0] ?? ''
  // The first token shouldn't end with sentence punctuation — guard "Done." lines.
  if (/[.!?:,]$/.test(first) && !/^\.{1,2}\//.test(first)) return false

  // Strong positives that override the prose check below.
  if (/^[A-Za-z_][\w]*=/.test(first)) return true // FOO=bar env-assignment
  // Strip a leading sudo/env wrapper to look at the REAL program token.
  const prog = (first === 'sudo' || first === 'env' ? tokens[1] : first) ?? first
  const base = prog.replace(/^.*\//, '') // basename of a path like /usr/bin/git
  if (KNOWN_TOOLS.has(base) || KNOWN_TOOLS.has(first)) return true
  if (SIGNAL_RE.test(cmd)) return true
  // A single bare token (no args) that's a plain identifier is plausibly a command
  // (`make`, `ls`); but a single capitalized English word ("Done") is not.
  if (tokens.length === 1) return /^[a-z][\w-]*$/.test(first)

  // Otherwise it's multi-word with no signal and no known tool → treat as prose.
  return false
}

/**
 * Try to extract the command from one already-stripped, squashed output line.
 * Recognizes shell-prompt commands, Claude Code `Bash(...)` tool lines, and
 * "Running `cmd`" announcements. Returns the detected command + risk, or null
 * when the line isn't a recognizable invocation (precision over recall).
 * Pure / total — never throws.
 */
export function detectCommand(line: string): DetectedCommand | null {
  if (!line) return null
  const t = line.trim()
  if (!t || t.length < 2) return null

  let cmd: string | null = null

  // 1) Claude Code Bash(...) tool-call line — highest confidence, check first so a
  //    `❯` rendered alongside it doesn't shadow the literal inner command.
  const bash = BASH_TOOL_RE.exec(t)
  if (bash) {
    cmd = tidy(bash[1])
  }

  // 2) "Running `cmd`" / "Ejecutando `cmd`" announcement.
  if (!cmd) {
    const run = RUNNING_RE.exec(t)
    if (run) cmd = tidy(run[1])
  }

  // 3) Shell prompt line with a sigil ($, ❯, ›, ▶, »).
  if (!cmd) {
    const p = PROMPT_RE.exec(t)
    if (p) {
      const candidate = tidy(p[1])
      if (looksLikeCommand(candidate)) cmd = candidate
    }
  }

  // 4) Bare `> cmd` prompt (stricter).
  if (!cmd) {
    const g = GT_PROMPT_RE.exec(t)
    if (g) {
      const candidate = tidy(g[1])
      if (looksLikeCommand(candidate)) cmd = candidate
    }
  }

  if (!cmd) return null
  // Final guard for the backtick/Bash paths too: reject empty or non-command text.
  if (!looksLikeCommand(cmd)) return null

  return { cmd, risk: classifyRisk(cmd) }
}

// ── Risk classification ──────────────────────────────────────────────────────

// Irreversible / system-altering / arbitrary-remote-code patterns. Matching ANY
// of these tags the command `destructive` — the chip + extra re-run confirm hinge
// on this set, so it is deliberately specific (force-push, hard reset, recursive
// remove, disk writes, privilege escalation, curl|sh, redirect-to-device).
const DESTRUCTIVE_RE: RegExp[] = [
  /\brm\s+(?:-\w*\s+)*-\w*[rf]/i, // rm -rf / rm -fr / rm -r -f
  /\brm\s+-[rf]/i,
  /\bgit\s+push\b[^\n]*\s(?:--force|-f|--force-with-lease)\b/i,
  /\bgit\s+reset\b[^\n]*--hard/i,
  /\bgit\s+clean\b[^\n]*-[a-z]*[fd]/i,
  /\bgit\s+checkout\b[^\n]*--\s+\./i,
  /\bdd\b[^\n]*\bof=/i,
  /\bmkfs\b/i,
  /\bsudo\b/i,
  /\bdoas\b/i,
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  /\b(?:chmod|chown)\s+-R\b/i,
  /\btruncate\b[^\n]*-s\s*0/i,
  /[>|]\s*\/dev\/(?:sd|disk|null\/)/i, // writing to a device (not /dev/null read)
  /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python\d?|node)\b/i, // curl | sh
  /:\(\)\s*\{.*\};:/ // fork bomb
]

const NETWORK_RE = /\b(?:curl|wget|ssh|scp|sftp|rsync|nc|netcat|telnet|ftp)\b/i
const VCS_RE = /^(?:git|gh|hg|svn)\b/i
const BUILDTEST_RE =
  /\b(?:npm|pnpm|yarn|npx|bun|make|cargo|go|pytest|vitest|jest|mocha|tox|gradle|mvn|cmake|tsc|deno|rake|bundle|pip|poetry|uv|docker|docker-compose|kubectl)\b/i

/**
 * Classify a command string into a risk tier. Order matters: destructive wins
 * over everything, then network, then vcs, then build/test, else benign. Pure /
 * total — never throws.
 */
export function classifyRisk(cmd: string): CommandRisk {
  const c = (cmd ?? '').trim()
  if (!c) return 'benign'
  for (const re of DESTRUCTIVE_RE) {
    if (re.test(c)) return 'destructive'
  }
  if (NETWORK_RE.test(c)) return 'network'
  if (VCS_RE.test(c)) return 'vcs'
  if (BUILDTEST_RE.test(c)) return 'buildtest'
  return 'benign'
}
