// git.ts
//
// Changeset Lens — read-only main-process git helpers. The renderer asks, per
// terminal node (keyed by its existing node.cwd), "what files has this agent
// CHANGED, with how many adds/dels" and "show me the diff for one file". This
// module answers via `git` subprocesses and NOTHING ELSE: it never writes, never
// commits, never resets — every call is a pure read over the working tree.
//
// Safety contract (mirrors the Doctor's careful subprocess use):
//   • Every git invocation goes through execFile('git', [...]) — NO shell, so a
//     cwd or path can never be interpreted as a command.
//   • Hard 4s timeout per call so a stuck git (e.g. an index.lock prompt, a huge
//     repo) can never hang the IPC handler.
//   • All errors are swallowed -> null / empty, so on any failure the feature
//     simply shows nothing (badges absent) and existing behavior is untouched.
//   • cwd is validated to a non-empty string and confirmed to be inside a git
//     work tree before any status/diff command runs.
//   • file paths handed to `git diff` are passed AFTER `--` (pathspec) and only
//     ever as a single explicit argument, never globbed/expanded.

import { execFile } from 'child_process'
import { isAbsolute, resolve, sep, dirname } from 'path'
import { existsSync, realpathSync } from 'fs'

/**
 * Resolve symlinks on the longest existing prefix of `abs` and re-append the
 * non-existing tail, then confirm the REAL location stays inside `rootReal`.
 * Lexical containment alone is bypassable via a symlink that points out of the
 * repo; this closes that hole for raw-path git operations. Returns null on escape.
 */
function realInsideRoot(abs: string, rootReal: string): boolean {
  try {
    let existing = abs
    const tail: string[] = []
    while (!existsSync(existing)) {
      const parent = dirname(existing)
      if (parent === existing) return false
      tail.unshift(existing.slice(parent.length + 1))
      existing = parent
    }
    const real = tail.length ? resolve(realpathSync(existing), ...tail) : realpathSync(existing)
    return real === rootReal || real.startsWith(rootReal + sep)
  } catch {
    return false
  }
}

const GIT_TIMEOUT_MS = 4000
const MAX_BUFFER = 4 * 1024 * 1024 // 4MB — generous for a single-file diff.

/** One changed file: working-tree status code + add/del line counts. */
export interface ChangedFile {
  /** repo-relative path (posix-style, as git prints it). */
  path: string
  /** two-char porcelain status (e.g. ' M', '??', 'A ', 'MM'). */
  status: string
  /** lines added per `git diff --numstat` (0 for untracked/binary). */
  adds: number
  /** lines deleted per `git diff --numstat` (0 for untracked/binary). */
  dels: number
}

/** A node's full changeset summary returned to the renderer. */
export interface ChangesetSummary {
  files: ChangedFile[]
  adds: number
  dels: number
}

/** Promise wrapper over execFile that resolves to stdout, or null on ANY error
 *  (non-zero exit, timeout, missing git, …). Never rejects. */
function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        args,
        { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
        (err, stdout) => {
          if (err) resolve(null)
          else resolve(stdout ?? '')
        }
      )
    } catch {
      resolve(null)
    }
  })
}

/** Variant of git() for `git diff --no-index`, which exits 1 (not 0) whenever the
 *  two inputs differ — the normal, expected outcome when diffing /dev/null vs a
 *  non-empty untracked file. Returns stdout for exit 0 OR exit 1 (the diff is
 *  valid in both cases), and null on any other failure (timeout, git missing,
 *  exit code > 1), preserving the null-on-real-error contract. Never rejects. */
function gitAllowDiff(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        args,
        { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
        (err, stdout) => {
          // execFile reports a non-zero exit via err.code (a number for a clean
          // process exit). `--no-index` uses 1 to mean "inputs differ", so that
          // is success here; anything else (signals, spawn errors, code > 1) is
          // a real failure.
          if (err && err.code !== 1) resolve(null)
          else resolve(stdout ?? '')
        }
      )
    } catch {
      resolve(null)
    }
  })
}

/** True iff `cwd` is a usable string that resolves inside a git work tree. A type
 *  predicate can't be wrapped in Promise<>, so callers narrow `cwd` themselves
 *  (string check) before using it after an awaited true. */
async function insideWorkTree(cwd: unknown): Promise<boolean> {
  if (typeof cwd !== 'string' || !cwd.trim()) return false
  const out = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  return out != null && out.trim() === 'true'
}

/**
 * Read the working-tree changeset for one cwd. Combines `git status
 * --porcelain=v1` (the authoritative list of changed/untracked paths + their
 * status codes) with `git diff --numstat` (per-file add/del counts for tracked
 * changes). Returns null when cwd is not a git work tree or git fails entirely;
 * returns an empty summary (no files) for a clean tree.
 */
export async function porcelainStatus(cwd: unknown): Promise<ChangesetSummary | null> {
  try {
    if (typeof cwd !== 'string' || !cwd.trim()) return null
    if (!(await insideWorkTree(cwd))) return null

    const statusOut = await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])
    if (statusOut == null) return null

    // Parse numstat (tracked changes only) into a path -> {adds,dels} map.
    // `git diff --numstat HEAD` covers both staged and unstaged tracked edits in
    // one pass; on a repo with no commits yet HEAD is invalid, so fall back to a
    // plain (unstaged) numstat. Binary files print "-\t-" -> counted as 0.
    let numstatOut = await git(cwd, ['diff', '--numstat', 'HEAD'])
    if (numstatOut == null) numstatOut = await git(cwd, ['diff', '--numstat'])
    const counts = new Map<string, { adds: number; dels: number }>()
    if (numstatOut) {
      for (const line of numstatOut.split('\n')) {
        if (!line.trim()) continue
        const parts = line.split('\t')
        if (parts.length < 3) continue
        const a = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0
        const d = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0
        // For renames git prints "old => new"; key on the new path tail.
        const p = parts.slice(2).join('\t')
        counts.set(p, { adds: a, dels: d })
      }
    }

    const files: ChangedFile[] = []
    let adds = 0
    let dels = 0
    for (const raw of statusOut.split('\n')) {
      if (!raw) continue
      // Porcelain v1: XY<space>path  (path may be quoted / contain " -> " for renames).
      const status = raw.slice(0, 2)
      let path = raw.slice(3)
      if (!path) continue
      // Renamed/copied entries: "orig -> dest" — keep the destination.
      const arrow = path.indexOf(' -> ')
      if (arrow >= 0) path = path.slice(arrow + 4)
      // Git quotes paths with unusual chars; strip surrounding quotes best-effort.
      if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
      const c = counts.get(path) ?? { adds: 0, dels: 0 }
      adds += c.adds
      dels += c.dels
      files.push({ path, status, adds: c.adds, dels: c.dels })
    }

    return { files, adds, dels }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Checkpoints — one-key restorable savepoints per agent.
//
// This is the ONE place in the git bridge that can WRITE, and only ever through
// a single explicit, gated call (restoreCheckpoint -> `git stash apply`). All
// the rest is non-mutating:
//   • createCheckpoint runs `git stash create`, which builds a DANGLING commit
//     object and prints its SHA while leaving the working tree, index, and HEAD
//     completely untouched. We then `git stash store` it (anchors it under
//     refs/stash so it survives GC) AND tag it under our own isolated
//     refs/canvasio/checkpoints/<sha> namespace so our checkpoints are trivially
//     listable WITHOUT depending on / polluting the user's `git stash list`.
//   • listCheckpoints / checkpointDiff are pure reads.
//   • restoreCheckpoint validates the sha shape AND confirms the ref exists in
//     OUR namespace before issuing `git stash apply <sha>` — never pop/drop/reset,
//     so a restore never destroys the checkpoint itself.
// ---------------------------------------------------------------------------

/** Our isolated ref namespace for checkpoints. Keeps them off `git stash list`. */
const CHECKPOINT_REF_PREFIX = 'refs/canvasio/checkpoints/'

/** A captured savepoint's metadata, derived from git refs + `show --stat`. */
export interface CheckpointMeta {
  /** full 40-char commit sha of the dangling stash commit. */
  sha: string
  /** short (12-char) sha for display. */
  short: string
  /** capture wall-clock ms (from the commit's author date). */
  ts: number
  /** files captured in this checkpoint. */
  files: number
  /** lines added captured. */
  adds: number
  /** lines deleted captured. */
  dels: number
}

/** Validate a checkpoint sha is a bare lowercase hex blob of plausible length.
 *  Exported so the unit tests can lock the regex without spawning git. */
export function isValidCheckpointSha(sha: unknown): sha is string {
  return typeof sha === 'string' && /^[0-9a-f]{7,40}$/.test(sha)
}

/**
 * Parse `git show --stat --format=%at` output for one checkpoint commit into its
 * timestamp + diffstat totals. PURE (no IO) so it is unit-testable. The format we
 * request is: a first non-empty line that is the author epoch seconds (%at), then
 * the standard `--stat` body whose final " N files changed, A insertions(+), D
 * deletions(-)" summary line we scan for totals. Returns null if the epoch line
 * is missing/garbage.
 */
export function parseCheckpointStat(
  out: string
): { ts: number; files: number; adds: number; dels: number } | null {
  const lines = out.split('\n')
  let ts = NaN
  for (const ln of lines) {
    const t = ln.trim()
    if (!t) continue
    ts = parseInt(t, 10)
    break
  }
  if (!Number.isFinite(ts)) return null
  // Scan the summary line: "N files changed, A insertions(+), D deletions(-)".
  let files = 0
  let adds = 0
  let dels = 0
  for (const ln of lines) {
    const fm = ln.match(/(\d+)\s+files?\s+changed/)
    if (!fm) continue
    files = parseInt(fm[1], 10) || 0
    const am = ln.match(/(\d+)\s+insertions?\(\+\)/)
    const dm = ln.match(/(\d+)\s+deletions?\(-\)/)
    adds = am ? parseInt(am[1], 10) || 0 : 0
    dels = dm ? parseInt(dm[1], 10) || 0 : 0
    break
  }
  return { ts: ts * 1000, files, adds, dels }
}

/**
 * Capture the ENTIRE working tree of `cwd` as a named, timestamped checkpoint.
 * Non-mutating: `git stash create` builds a dangling commit and prints its SHA
 * without touching WT/index/HEAD. We then anchor it (stash store) and tag it in
 * our isolated namespace so it survives GC and is trivially listable. Returns the
 * new CheckpointMeta, or null on a clean tree (nothing to capture) or any error.
 */
export async function createCheckpoint(cwd: unknown, label?: unknown): Promise<CheckpointMeta | null> {
  try {
    if (!(await insideWorkTree(cwd))) return null
    const root = cwd as string
    const msg =
      typeof label === 'string' && label.trim()
        ? `canvasio checkpoint: ${label.trim().slice(0, 80)}`
        : 'canvasio checkpoint'
    const createOut = await git(root, ['stash', 'create', msg])
    if (createOut == null) return null
    const sha = createOut.trim()
    // Empty stdout => clean tree, nothing was stashed. Not an error; just no-op.
    if (!sha || !isValidCheckpointSha(sha)) return null
    // Anchor under refs/stash so the dangling commit can't be garbage-collected.
    await git(root, ['stash', 'store', '-m', msg, sha])
    // Tag under our isolated namespace so listing never depends on stash order.
    await git(root, ['update-ref', `${CHECKPOINT_REF_PREFIX}${sha}`, sha])
    const meta = await checkpointMeta(root, sha)
    return meta
  } catch {
    return null
  }
}

/** Read one checkpoint's metadata (ts + diffstat). null on failure. */
async function checkpointMeta(cwd: string, sha: string): Promise<CheckpointMeta | null> {
  const out = await git(cwd, ['show', '--stat', '--format=%at', sha])
  if (out == null) return null
  const parsed = parseCheckpointStat(out)
  if (!parsed) return null
  return { sha, short: sha.slice(0, 12), ...parsed }
}

/**
 * List every checkpoint captured for `cwd`, newest-first. Reads our isolated
 * refs/canvasio/checkpoints namespace (so the user's `git stash list` is never
 * consulted or disturbed) and derives each entry's diffstat. Returns [] when
 * there are none, null only when cwd is not a usable git work tree.
 */
export async function listCheckpoints(cwd: unknown): Promise<CheckpointMeta[] | null> {
  try {
    if (!(await insideWorkTree(cwd))) return null
    const root = cwd as string
    const refsOut = await git(root, [
      'for-each-ref',
      '--format=%(objectname)',
      CHECKPOINT_REF_PREFIX
    ])
    if (refsOut == null) return []
    const shas = refsOut
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => isValidCheckpointSha(s))
    const metas: CheckpointMeta[] = []
    for (const sha of shas) {
      const m = await checkpointMeta(root, sha)
      if (m) metas.push(m)
    }
    // newest-first
    metas.sort((a, b) => b.ts - a.ts)
    return metas
  } catch {
    return null
  }
}

/** Read-only preview of a checkpoint's full diff (`git stash show -p`). */
export async function checkpointDiff(cwd: unknown, sha: unknown): Promise<string | null> {
  try {
    if (!isValidCheckpointSha(sha)) return null
    if (!(await insideWorkTree(cwd))) return null
    const root = cwd as string
    // Confirm the sha is one of OURS before showing it.
    if (!(await checkpointRefExists(root, sha))) return null
    const out = await git(root, ['-c', 'color.ui=never', 'stash', 'show', '-p', sha])
    return out ?? ''
  } catch {
    return null
  }
}

/** True iff `sha` is anchored under our checkpoint namespace in `cwd`. */
async function checkpointRefExists(cwd: string, sha: string): Promise<boolean> {
  const out = await git(cwd, [
    'for-each-ref',
    '--format=%(objectname)',
    CHECKPOINT_REF_PREFIX
  ])
  if (out == null) return false
  return out
    .split('\n')
    .map((s) => s.trim())
    .includes(sha)
}

/** Result of a restore attempt. `conflicted` is true when `git stash apply`
 *  succeeded but produced merge conflicts the user must resolve. */
export interface RestoreResult {
  ok: boolean
  conflicted: boolean
}

/**
 * Restore a checkpoint into the working tree with `git stash apply <sha>` — the
 * ONLY mutating call in this module. It is non-destructive of the checkpoint
 * itself (never pop/drop/reset), so the savepoint remains available afterward.
 * Guards: the sha must match the strict hex shape AND exist under our namespace
 * before apply. `apply` exits non-zero on merge conflicts but still applies the
 * patch, so a non-zero exit whose output mentions conflicts is reported as
 * {ok:true, conflicted:true} rather than a failure.
 */
export async function restoreCheckpoint(cwd: unknown, sha: unknown): Promise<RestoreResult> {
  try {
    if (!isValidCheckpointSha(sha)) return { ok: false, conflicted: false }
    if (!(await insideWorkTree(cwd))) return { ok: false, conflicted: false }
    const root = cwd as string
    if (!(await checkpointRefExists(root, sha))) return { ok: false, conflicted: false }
    return await new Promise<RestoreResult>((resolve) => {
      try {
        execFile(
          'git',
          ['stash', 'apply', sha],
          { cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
          (err, stdout, stderr) => {
            const blob = `${stdout ?? ''}\n${stderr ?? ''}`
            const conflicted = /conflict/i.test(blob)
            if (err && !conflicted) resolve({ ok: false, conflicted: false })
            else resolve({ ok: true, conflicted })
          }
        )
      } catch {
        resolve({ ok: false, conflicted: false })
      }
    })
  } catch {
    return { ok: false, conflicted: false }
  }
}

/**
 * Return the colorless unified diff for a SINGLE file in cwd's work tree, or null
 * on failure. Tries the unstaged diff first, then the staged (--cached) diff, so
 * a file the agent already `git add`ed still shows its changes. The path is
 * always passed as an explicit pathspec after `--` so it can never be treated as
 * a flag. `color.ui=never` keeps the output clean for the renderer to colorize.
 */
export async function fileDiff(cwd: unknown, path: unknown): Promise<string | null> {
  try {
    if (typeof path !== 'string' || !path.trim()) return null
    if (!(await insideWorkTree(cwd))) return null
    // Path containment: `git diff --no-index` (the untracked-file fallback below)
    // operates on raw filesystem paths, NOT repo-scoped pathspecs, so a renderer-
    // supplied absolute path or `../` traversal would be read verbatim and its
    // full contents disclosed. Require `path` to be repo-relative and resolve to
    // a location inside cwd before issuing any diff.
    const root = cwd as string
    if (isAbsolute(path)) return null
    const abs = resolve(root, path)
    const rootResolved = resolve(root)
    if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) return null
    // Symlink-safe containment: reject if the real target escapes the repo root.
    let rootReal: string
    try {
      rootReal = realpathSync(rootResolved)
    } catch {
      rootReal = rootResolved
    }
    if (!realInsideRoot(abs, rootReal)) return null
    const base = ['-c', 'color.ui=never', 'diff']
    let out = await git(cwd as string, [...base, '--', path])
    if (out && out.trim()) return out
    // Nothing unstaged — try the staged diff (file was `git add`ed).
    out = await git(cwd as string, [...base, '--cached', '--', path])
    if (out && out.trim()) return out
    // Untracked file: `git diff` shows nothing; surface it via /dev/null diff.
    // `--no-index` exits 1 when the inputs differ (always, here), so use the
    // exit-1-tolerant variant or the diff would be silently dropped.
    out = await gitAllowDiff(cwd as string, [...base, '--no-index', '--', '/dev/null', path])
    return out ?? ''
  } catch {
    return null
  }
}
