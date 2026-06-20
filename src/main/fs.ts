import { ipcMain, BrowserWindow } from 'electron'
import { readFile, writeFile, readdir, mkdir, stat } from 'fs/promises'
import { watch, FSWatcher, writeFileSync, mkdirSync, existsSync, realpathSync } from 'fs'
import { join, normalize, resolve, isAbsolute, dirname, sep } from 'path'
import { homedir } from 'os'
import { log } from './logger'

// =============================================================================
// File-system bridge (MAIN process) — backs the Markdown note + Folder browser
// nodes. Mirrors the safety discipline of canvases.ts / git.ts / pty.ts:
//   - every handler is wrapped in try/catch and NEVER throws across IPC; it
//     resolves to the documented null / { ok:false } / [] / { error } fallback;
//   - all caller-supplied paths are UNTRUSTED — they are normalized + resolved
//     against an absolute base (cwd, defaulting to the user's home dir) and any
//     attempt to escape the base ('..', absolute paths) is rejected.
//
// WIRE CONTRACT (duplicated structurally in src/preload/index.ts; renderer reads
// it via window.canvasio.fs.*):
//   fs:read(path, cwd?)            -> string | null
//   fs:write(path, content, cwd?)  -> { ok: boolean }
//   fs:list(dirPath, cwd?)         -> FsListEntry[] | null   (name,path,isDir,size)
//   fs:exists(path, cwd?)          -> boolean
//   fs:watch:start(path, cwd?)     -> { token: string } | { error: string }
//   fs:watch:stop(token)           -> { ok: boolean }
//   fs:changed:<token>             (one-way event -> renderer; live-reload)
// =============================================================================

export interface FsListEntry {
  name: string
  path: string
  isDir: boolean
  size: number
}

// --- Watcher registry: token -> { watcher, debounce } (memory-only, per-session)
interface WatchEntry {
  watcher: FSWatcher
  debounce: NodeJS.Timeout | null
}
const watchers = new Map<string, WatchEntry>()
let nextWatchToken = 0

// Resolve `requestedPath` against the absolute `basePath` and confirm it stays
// inside it. Returns the absolute path on success, or null on any violation
// (non-absolute base, traversal escape, malformed input).
// Allowlisted roots for ALL fs IPC. Even a caller-supplied `cwd` cannot escape
// these, so the AI brain / untrusted content can never read system secrets like
// /etc/passwd via a crafted path (audit #2: cwd defeated home confinement). Home
// covers ~/Projects, ~/Desktop, etc.; /Volumes covers external drives the user
// legitimately works in. Anything else (/etc, /System, /usr, /private, …) is
// rejected.
const ALLOWED_ROOTS = [resolve(homedir()), '/Volumes']
// Canonical (symlink-resolved) forms of the roots, so the realpath check below
// compares like-for-like even if a root itself contains a symlinked component.
const REAL_ALLOWED_ROOTS = ALLOWED_ROOTS.map((r) => {
  try {
    return realpathSync(r)
  } catch {
    return r
  }
})
function underAllowedRoot(full: string): boolean {
  return ALLOWED_ROOTS.some((root) => full === root || full.startsWith(root + sep))
}
function underRealAllowedRoot(real: string): boolean {
  return REAL_ALLOWED_ROOTS.some((root) => real === root || real.startsWith(root + sep))
}

// Credential / secret locations that live UNDER an allowed root (home) but must
// never be readable/writable through the renderer-facing fs bridge — the AI brain
// can emit model-chosen paths, so these stay off-limits regardless of allowlist.
const DENY_DIRS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.config/gcloud',
  'Library/Keychains'
].map((d) => join(resolve(homedir()), d))
const DENY_FILES = ['.netrc', '.npmrc', '.claude.json', '.git-credentials'].map((f) =>
  join(resolve(homedir()), f)
)
function isDenied(real: string): boolean {
  if (DENY_FILES.includes(real)) return true
  if (DENY_DIRS.some((d) => real === d || real.startsWith(d + sep))) return true
  // Private keys by name, anywhere under the allowed roots.
  const base = real.slice(real.lastIndexOf(sep) + 1)
  return base.startsWith('id_rsa') || base.startsWith('id_ed25519') || base === '.env'
}

// Resolve symlinks on the longest EXISTING prefix of `full` and re-append the
// non-existing tail (so writes to a not-yet-created file still get checked via
// their real parent dir). Returns the canonical path iff its REAL location stays
// inside an allowlisted root — defeating a symlink planted inside home/Volumes
// that points at /etc, ~/.ssh, etc. Returns null on any escape/error.
function resolveRealContained(full: string): string | null {
  try {
    let existing = full
    const tail: string[] = []
    while (!existsSync(existing)) {
      const parent = dirname(existing)
      if (parent === existing) return null
      tail.unshift(existing.slice(parent.length + 1))
      existing = parent
    }
    const realBase = realpathSync(existing)
    const realFull = tail.length ? resolve(realBase, ...tail) : realBase
    if (!underRealAllowedRoot(realFull)) return null
    if (isDenied(realFull)) return null
    return realFull
  } catch {
    return null
  }
}

function validatePath(basePath: string, requestedPath: string): string | null {
  if (typeof requestedPath !== 'string' || typeof basePath !== 'string') return null
  if (!isAbsolute(basePath)) return null
  try {
    // Reject absolute requested paths outright — they would jump out of basePath.
    if (isAbsolute(requestedPath)) return null
    const normalized = normalize(requestedPath)
    // Quick reject of obvious traversal before resolving.
    if (normalized === '..' || normalized.startsWith(`..${sep}`)) return null
    const full = resolve(basePath, normalized)
    const baseResolved = resolve(basePath)
    // Final containment check: `full` must equal baseResolved or live beneath it.
    if (full !== baseResolved && !full.startsWith(baseResolved + sep)) return null
    // AND it must stay inside an allowlisted root regardless of `basePath`/`cwd`.
    if (!underAllowedRoot(full)) return null
    // Lexical containment is not enough: a symlink inside the allowed area can
    // point OUT of it. Resolve symlinks and re-check the REAL location, returning
    // the canonical path so the fs op acts on the resolved target.
    return resolveRealContained(full)
  } catch {
    return null
  }
}

// Resolve the base dir for a request. A caller `cwd` is honoured only when it is
// itself inside an allowlisted root; otherwise we fall back to home so a rogue
// absolute cwd can never widen access (audit #2).
function baseFor(cwd?: string): string {
  if (typeof cwd === 'string' && cwd && isAbsolute(cwd)) {
    const c = resolve(cwd)
    if (underAllowedRoot(c)) return c
  }
  return homedir()
}

export function registerFsHandlers(getWindow: () => BrowserWindow | null): void {
  // fs:read(path, cwd?) -> string | null. Reads UTF-8. null on any error.
  ipcMain.handle('fs:read', async (_e, path: unknown, cwd?: unknown): Promise<string | null> => {
    try {
      const full = validatePath(baseFor(cwd as string | undefined), path as string)
      if (!full) {
        log('warn', 'main', 'fs:read:invalid-path', { path, cwd })
        return null
      }
      return await readFile(full, 'utf-8')
    } catch (err) {
      log('warn', 'main', 'fs:read:error', { error: (err as Error)?.message ?? String(err) })
      return null
    }
  })

  // fs:write(path, content, cwd?) -> { ok }. Writes UTF-8, mkdir -p parent.
  ipcMain.handle(
    'fs:write',
    async (_e, path: unknown, content: unknown, cwd?: unknown): Promise<{ ok: boolean }> => {
      try {
        const full = validatePath(baseFor(cwd as string | undefined), path as string)
        if (!full) {
          log('warn', 'main', 'fs:write:invalid-path', { path, cwd })
          return { ok: false }
        }
        const text = typeof content === 'string' ? content : ''
        await mkdir(dirname(full), { recursive: true })
        await writeFile(full, text, 'utf-8')
        return { ok: true }
      } catch (err) {
        log('warn', 'main', 'fs:write:error', { error: (err as Error)?.message ?? String(err) })
        return { ok: false }
      }
    }
  )

  // fs:write-sync(path, content, cwd?) -> { ok }. SYNCHRONOUS variant used ONLY for
  // the last-chance flush on app close (beforeunload/pagehide): a normal async IPC
  // is not guaranteed to complete while the renderer is tearing down, so the final
  // unsaved markdown edit could be lost. sendSync blocks the renderer until the
  // write lands. Same path validation as fs:write.
  ipcMain.on('fs:write-sync', (e, path: unknown, content: unknown, cwd?: unknown) => {
    try {
      const full = validatePath(baseFor(cwd as string | undefined), path as string)
      if (!full) {
        e.returnValue = { ok: false }
        return
      }
      const text = typeof content === 'string' ? content : ''
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, text, 'utf-8')
      e.returnValue = { ok: true }
    } catch (err) {
      log('warn', 'main', 'fs:write-sync:error', { error: (err as Error)?.message ?? String(err) })
      e.returnValue = { ok: false }
    }
  })

  // fs:list(dirPath, cwd?) -> FsListEntry[] | null. Dirs first, then alpha.
  ipcMain.handle(
    'fs:list',
    async (_e, dirPath: unknown, cwd?: unknown): Promise<FsListEntry[] | null> => {
      try {
        const full = validatePath(baseFor(cwd as string | undefined), dirPath as string)
        if (!full) {
          log('warn', 'main', 'fs:list:invalid-path', { dirPath, cwd })
          return null
        }
        const entries = await readdir(full, { withFileTypes: true })
        const result = await Promise.all(
          entries.map(async (ent): Promise<FsListEntry> => {
            const isDir = ent.isDirectory()
            try {
              const stats = await stat(join(full, ent.name))
              return { name: ent.name, path: ent.name, isDir: stats.isDirectory(), size: stats.size }
            } catch {
              // Broken symlink / permission — surface the entry with size 0.
              return { name: ent.name, path: ent.name, isDir, size: 0 }
            }
          })
        )
        result.sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        return result
      } catch (err) {
        log('warn', 'main', 'fs:list:error', { error: (err as Error)?.message ?? String(err) })
        return null
      }
    }
  )

  // fs:exists(path, cwd?) -> boolean. false on invalid path / missing / error.
  ipcMain.handle('fs:exists', async (_e, path: unknown, cwd?: unknown): Promise<boolean> => {
    try {
      const full = validatePath(baseFor(cwd as string | undefined), path as string)
      if (!full) return false
      await stat(full)
      return true
    } catch {
      return false
    }
  })

  // fs:watch:start(path, cwd?) -> { token } | { error }. Arms an fs.watch on the
  // resolved path; emits a debounced `fs:changed:<token>` to all windows on each
  // change (fs.watch fires multiple times per write).
  ipcMain.handle(
    'fs:watch:start',
    async (_e, path: unknown, cwd?: unknown): Promise<{ token: string } | { error: string }> => {
      try {
        const full = validatePath(baseFor(cwd as string | undefined), path as string)
        if (!full) return { error: 'Invalid path' }

        const token = String(nextWatchToken++)
        const channel = `fs:changed:${token}`
        const entry: WatchEntry = { watcher: watch(full), debounce: null }
        watchers.set(token, entry)

        entry.watcher.on('change', () => {
          if (entry.debounce) clearTimeout(entry.debounce)
          entry.debounce = setTimeout(() => {
            entry.debounce = null
            const win = getWindow()
            if (win && !win.isDestroyed()) {
              try {
                win.webContents.send(channel)
              } catch {
                // Window may have been torn down between the guard and the send.
              }
            }
          }, 50)
        })
        // A watcher error (e.g. the watched file is removed) must not crash main;
        // just log it and leave the token in place so stop() can still clean up.
        entry.watcher.on('error', (err) => {
          log('warn', 'main', 'fs:watch:error', {
            token,
            error: (err as Error)?.message ?? String(err)
          })
        })

        return { token }
      } catch (err) {
        return { error: (err as Error)?.message ?? String(err) }
      }
    }
  )

  // fs:watch:stop(token) -> { ok }. Closes + de-registers the watcher.
  ipcMain.handle('fs:watch:stop', async (_e, token: unknown): Promise<{ ok: boolean }> => {
    try {
      const entry = watchers.get(token as string)
      if (!entry) return { ok: false }
      if (entry.debounce) clearTimeout(entry.debounce)
      entry.watcher.close()
      watchers.delete(token as string)
      return { ok: true }
    } catch (err) {
      log('warn', 'main', 'fs:watch:stop:error', { error: (err as Error)?.message ?? String(err) })
      return { ok: false }
    }
  })

  log('info', 'main', 'fs:handlers-registered', {})
}

// Close every active watcher (called on app shutdown, mirrors killAllPtys).
export function closeAllFsWatchers(): void {
  for (const [token, entry] of watchers) {
    try {
      if (entry.debounce) clearTimeout(entry.debounce)
      entry.watcher.close()
    } catch {
      // best-effort
    }
    watchers.delete(token)
  }
}
