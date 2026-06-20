/**
 * Path resolution for the voice-brain file/folder actions (open_markdown /
 * open_folder / create_markdown). Bridges the gap between the loose paths the
 * brain emits ("README.md", "src", "/Users/me/notes/todo.md") and the main-process
 * fs bridge, which is cwd-relative and REJECTS absolute first-arg paths
 * (validatePath in src/main/fs.ts resolves `path` against a `cwd` base and refuses
 * anything that escapes it).
 *
 * The markdown/folder NODES (MarkdownNode / FolderNode) store their path RELATIVE
 * to the node's `cwd` base and call fs.read/list(relativePath, cwd). So every
 * resolver here returns BOTH a relative `path` and the `cwd` base to store on the
 * node, in exactly that contract:
 *   - Absolute input  → cwd = dirname, path = basename.
 *   - Relative input  → cwd = active canvas cwd (or home), path = the input.
 *
 * Resolution is best-effort and fuzzy: if an exact name is missing we list the
 * base directory and match case/accent-insensitively (and add the .md extension
 * for markdown when the brain omits it). Returns null when nothing matches so the
 * caller can speak "No encontré …" instead of opening a broken node.
 */

import { activeCanvasCwd } from '../store/workspace'

// OS home dir, fetched ONCE from main — avoids a hardcoded /Users/<name> path so
// the app stays portable across machines/users. Empty until it resolves; in that
// rare window the fs bridge in main still falls back to homedir() when cwd is ''.
let cachedHome = ''
try {
  void window.canvasio?.home?.().then((h) => {
    if (typeof h === 'string' && h) cachedHome = h
  })
} catch {
  /* window.canvasio not ready — homeBase falls back to '' (main resolves homedir) */
}

/** What every resolver returns: a node-ready (relative path, cwd base) pair. */
export interface ResolvedPath {
  /** Path RELATIVE to `cwd`, ready for node.filePath / node.dirPath. */
  path: string
  /** The base directory to store as node.cwd (fs bridge resolves path against it). */
  cwd: string
}

/** Accent/case-insensitive normalization (mirrors aiActions.norm). */
const norm = (s: string): string =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()

/** Best-guess home dir fallback when the canvas has no working folder set. */
function homeBase(): string {
  // The fs bridge falls back to homedir() in main when cwd is undefined, but we
  // need a concrete base to store on the node so its later re-reads resolve the
  // SAME way. Derive it from the active cwd if any, else a sane macOS default.
  const cwd = activeCanvasCwd()
  if (cwd && cwd.trim()) return cwd
  // No canvas folder: use the OS home (fetched from main) so an absolute-ish
  // "Documents/x" still works. Empty until cachedHome resolves — main then falls
  // back to homedir() for an empty cwd.
  return cachedHome
}

/** Split a POSIX-ish path into { dir, base }. Trailing slashes are trimmed. */
function splitPath(p: string): { dir: string; base: string } {
  const clean = p.replace(/\/+$/, '')
  const idx = clean.lastIndexOf('/')
  if (idx < 0) return { dir: '', base: clean }
  return { dir: clean.slice(0, idx) || '/', base: clean.slice(idx + 1) }
}

/** Try a list of (relativePath, cwd) candidates; return the first that exists. */
async function firstExisting(
  candidates: Array<{ path: string; cwd: string }>
): Promise<ResolvedPath | null> {
  const fs = window.canvasio?.fs
  if (!fs?.exists) return candidates[0] ?? null // no bridge → optimistic first guess
  for (const c of candidates) {
    try {
      if (await fs.exists(c.path, c.cwd)) return c
    } catch {
      /* ignore — try the next candidate */
    }
  }
  return null
}

/**
 * Fuzzy-match a basename against the entries of `cwd`'s `dir`, optionally requiring
 * a directory (forDir) or a file. Returns the matched entry's name (relative to
 * `dir`) or null. Case/accent-insensitive: exact > startsWith > includes.
 */
async function fuzzyInDir(
  dir: string,
  base: string,
  cwd: string,
  forDir: boolean
): Promise<string | null> {
  const fs = window.canvasio?.fs
  if (!fs?.list) return null
  let entries: Array<{ name: string; isDir: boolean }> | null = null
  try {
    entries = (await fs.list(dir || '.', cwd)) as Array<{ name: string; isDir: boolean }> | null
  } catch {
    return null
  }
  if (!entries || !entries.length) return null
  const pool = entries.filter((e) => e.isDir === forDir)
  const q = norm(base)
  const exact = pool.find((e) => norm(e.name) === q)
  if (exact) return exact.name
  const starts = pool.find((e) => norm(e.name).startsWith(q))
  if (starts) return starts.name
  const includes = pool.find((e) => norm(e.name).includes(q))
  if (includes) return includes.name
  return null
}

/** Join two relative segments, skipping empties. */
function joinRel(a: string, b: string): string {
  if (!a || a === '.') return b
  if (!b) return a
  return `${a.replace(/\/+$/, '')}/${b}`
}

/**
 * Resolve a markdown file path. Absolute → (basename, dirname). Relative → resolved
 * against the active canvas cwd (or home). Tries the literal path, then the same
 * path with a .md suffix, then a fuzzy directory match (also tolerating a missing
 * extension). Returns a node-ready { path, cwd } or null when nothing matches.
 */
export async function resolveMarkdownPath(rawPath: string): Promise<ResolvedPath | null> {
  const raw = (rawPath || '').trim()
  if (!raw) return null

  if (raw.startsWith('/')) {
    const { dir, base } = splitPath(raw)
    const withMd = /\.(md|markdown|txt)$/i.test(base) ? base : `${base}.md`
    const hit = await firstExisting([
      { path: base, cwd: dir },
      { path: withMd, cwd: dir }
    ])
    if (hit) return hit
    const fuzzy = await fuzzyInDir('', /\.(md|markdown|txt)$/i.test(base) ? base : base, dir, false)
    return fuzzy ? { path: fuzzy, cwd: dir } : null
  }

  const cwd = homeBase()
  const { dir, base } = splitPath(raw)
  const withMd = /\.(md|markdown|txt)$/i.test(base) ? base : `${base}.md`
  const hit = await firstExisting([
    { path: raw, cwd },
    { path: /\.(md|markdown|txt)$/i.test(raw) ? raw : `${raw}.md`, cwd }
  ])
  if (hit) return hit
  const fuzzy = await fuzzyInDir(dir, withMd, cwd, false)
  return fuzzy ? { path: joinRel(dir, fuzzy), cwd } : null
}

/**
 * Resolve a folder path. Absolute → (basename, dirname); the EMPTY/"." case maps to
 * the dir itself. Relative → resolved against the active canvas cwd (or home); an
 * empty path means the cwd root ('.'). Tries the literal dir, then a fuzzy match.
 * Returns a node-ready { path, cwd } or null when nothing matches.
 */
export async function resolveFolderPath(rawPath: string): Promise<ResolvedPath | null> {
  const raw = (rawPath || '').trim()

  // No path → open the active canvas folder root.
  if (!raw || raw === '.' || raw === './') {
    const cwd = activeCanvasCwd()
    if (!cwd) return null
    return { path: '.', cwd }
  }

  if (raw.startsWith('/')) {
    const { dir, base } = splitPath(raw)
    // The directory itself: list it relative to its parent to confirm it exists.
    const hit = await firstExisting([{ path: base, cwd: dir }])
    if (hit) return hit
    const fuzzy = await fuzzyInDir('', base, dir, true)
    return fuzzy ? { path: fuzzy, cwd: dir } : null
  }

  const cwd = homeBase()
  const { dir, base } = splitPath(raw)
  const hit = await firstExisting([{ path: raw, cwd }])
  if (hit) return hit
  const fuzzy = await fuzzyInDir(dir, base, cwd, true)
  return fuzzy ? { path: joinRel(dir, fuzzy), cwd } : null
}
