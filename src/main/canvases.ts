import { app, ipcMain } from 'electron'
import { join, basename } from 'path'
import { mkdir, readdir, readFile, writeFile, rename, unlink } from 'fs/promises'
import { writeFileSync, mkdirSync } from 'fs'
import { log } from './logger'

// =============================================================================
// Multi-Canvas Workspace — fs-backed canvas document store (MAIN process).
//
// Each named canvas is persisted as its OWN JSON file under Electron userData:
//   <userData>/canvases/<id>.json
// The JSON shape below is the BINDING WIRE CONTRACT shared with the renderer +
// preload. Per the pinned design contract we DUPLICATE the literal types on each
// side (no src/shared import) — the JSON shape, the 5 channel names, and the
// window.canvasio.canvases.* signatures are the integration contract.
//
// Safety discipline mirrors the bg:/git: handlers: every handler is wrapped in
// try/catch and NEVER throws across IPC — it resolves to the null/{ok:false}/[]
// fallback instead. Writes are atomic-ish (write tmp, then rename). Ids are
// validated against ID_RE (no path traversal) before any join().
// =============================================================================

// --- Wire types (structurally identical to the renderer copy) ----------------

interface CanvasData {
  nodes: unknown[]
  waypoints: unknown[]
  regions: unknown[]
  stages: unknown[]
  shapes: unknown[]
}

interface CanvasDoc {
  id: string
  name: string
  createdTs: number
  updatedTs: number
  schema: 1
  cwd?: string
  data: CanvasData
}

interface CanvasMeta {
  id: string
  name: string
  updatedTs: number
  cwd?: string
}

// --- Id validation (defense against path traversal) --------------------------
//
// A renderer-supplied id is UNTRUSTED. It must be a safe slug/uuid: lowercase
// alnum start, then alnum/_/- up to 64 chars total. Reject anything containing a
// dot, slash, backslash or '..'. Defense-in-depth: the resolved filename's
// basename must equal `${id}.json` (mirrors the bg: protocol handler guard).
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

function isValidId(id: unknown): id is string {
  if (typeof id !== 'string') return false
  if (!ID_RE.test(id)) return false
  if (id.includes('.') || id.includes('/') || id.includes('\\') || id.includes('..')) return false
  return true
}

// --- Paths -------------------------------------------------------------------

function canvasesDir(): string {
  return join(app.getPath('userData'), 'canvases')
}

function docPath(id: string): string {
  return join(canvasesDir(), `${id}.json`)
}

async function ensureDir(): Promise<void> {
  await mkdir(canvasesDir(), { recursive: true })
}

// Build a path for `id` only if it is valid AND its basename matches `${id}.json`
// (defense-in-depth, mirroring the bg: handler). Returns null on any violation.
function safeDocPath(id: string): string | null {
  if (!isValidId(id)) return null
  const full = docPath(id)
  if (basename(full) !== `${id}.json`) return null
  return full
}

// --- Atomic-ish write --------------------------------------------------------
//
// Write to `${id}.json.tmp` then rename over `${id}.json`. rename is atomic on
// the same filesystem, so a reader never observes a half-written file.
async function atomicWrite(full: string, contents: string): Promise<void> {
  const tmp = `${full}.tmp`
  await writeFile(tmp, contents, 'utf8')
  await rename(tmp, full)
}

// --- Handlers ----------------------------------------------------------------

export function registerCanvasHandlers(): void {
  // canvases:list -> CanvasMeta[] sorted by updatedTs DESC; [] on any error.
  ipcMain.handle('canvases:list', async (): Promise<CanvasMeta[]> => {
    try {
      await ensureDir()
      let entries: string[] = []
      try {
        entries = await readdir(canvasesDir())
      } catch {
        return []
      }
      const metas: CanvasMeta[] = []
      for (const f of entries) {
        if (!f.endsWith('.json') || f.endsWith('.tmp')) continue
        try {
          const raw = await readFile(join(canvasesDir(), f), 'utf8')
          const doc = JSON.parse(raw) as Partial<CanvasDoc>
          const idFromName = f.slice(0, -'.json'.length)
          metas.push({
            id: typeof doc.id === 'string' && doc.id ? doc.id : idFromName,
            name: typeof doc.name === 'string' && doc.name ? doc.name : idFromName,
            updatedTs: typeof doc.updatedTs === 'number' ? doc.updatedTs : 0,
            cwd: typeof doc.cwd === 'string' ? doc.cwd : undefined
          })
        } catch {
          // Skip files that fail to read/parse — never let one bad file break list.
          continue
        }
      }
      metas.sort((a, b) => b.updatedTs - a.updatedTs)
      return metas
    } catch (err) {
      log('warn', 'main', 'canvases:list:error', { error: (err as Error)?.message ?? String(err) })
      return []
    }
  })

  // canvases:read(id) -> CanvasDoc | null (null if missing/invalid/parse-fail).
  ipcMain.handle('canvases:read', async (_e, id: unknown): Promise<CanvasDoc | null> => {
    try {
      const full = safeDocPath(id as string)
      if (!full) return null
      const raw = await readFile(full, 'utf8')
      const doc = JSON.parse(raw) as CanvasDoc
      if (!doc || typeof doc !== 'object') return null
      return doc
    } catch {
      // Missing file (ENOENT), parse failure, invalid id -> null.
      return null
    }
  })

  // canvases:write({ id, doc }) -> { ok }. Validates id, stamps updatedTs +
  // schema:1, writes atomically.
  ipcMain.handle(
    'canvases:write',
    async (_e, payload: { id?: unknown; doc?: unknown }): Promise<{ ok: boolean }> => {
      try {
        const id = payload?.id
        const full = safeDocPath(id as string)
        if (!full) return { ok: false }
        const incoming = payload?.doc as Partial<CanvasDoc> | undefined
        if (!incoming || typeof incoming !== 'object') return { ok: false }
        const now = Date.now()
        // MAIN is the authority for updatedTs + schema. Preserve createdTs from
        // the incoming doc (renderer read-modify-writes), default to now.
        const doc: CanvasDoc = {
          id: id as string,
          name: typeof incoming.name === 'string' ? incoming.name : (id as string),
          createdTs: typeof incoming.createdTs === 'number' ? incoming.createdTs : now,
          updatedTs: now,
          schema: 1,
          cwd: typeof incoming.cwd === 'string' ? incoming.cwd : undefined,
          data: (incoming.data ?? {
            nodes: [],
            waypoints: [],
            regions: [],
            stages: [],
            shapes: []
          }) as CanvasData
        }
        await ensureDir()
        await atomicWrite(full, JSON.stringify(doc))
        return { ok: true }
      } catch (err) {
        log('warn', 'main', 'canvases:write:error', {
          error: (err as Error)?.message ?? String(err)
        })
        return { ok: false }
      }
    }
  )

  // canvases:write-sync({ id, doc }) -> e.returnValue { ok }. SYNCHRONOUS mirror
  // of canvases:write, used ONLY by the renderer quit / window-close flush
  // (App.tsx). A normal async invoke is NOT guaranteed to reach disk while the
  // renderer tears down on quit, so the last <=600ms of layout edits (node
  // positions, added/removed nodes, waypoints, regions, shapes) could be lost
  // (audit #1). Mirrors the proven fs:write-sync precedent.
  ipcMain.on('canvases:write-sync', (e, payload: { id?: unknown; doc?: unknown }) => {
    try {
      const id = payload?.id
      const full = safeDocPath(id as string)
      if (!full) {
        e.returnValue = { ok: false }
        return
      }
      const incoming = payload?.doc as Partial<CanvasDoc> | undefined
      if (!incoming || typeof incoming !== 'object') {
        e.returnValue = { ok: false }
        return
      }
      const now = Date.now()
      const doc: CanvasDoc = {
        id: id as string,
        name: typeof incoming.name === 'string' ? incoming.name : (id as string),
        createdTs: typeof incoming.createdTs === 'number' ? incoming.createdTs : now,
        updatedTs: now,
        schema: 1,
        cwd: typeof incoming.cwd === 'string' ? incoming.cwd : undefined,
        data: (incoming.data ?? {
          nodes: [],
          waypoints: [],
          regions: [],
          stages: [],
          shapes: []
        }) as CanvasData
      }
      mkdirSync(canvasesDir(), { recursive: true })
      writeFileSync(full, JSON.stringify(doc), 'utf-8')
      e.returnValue = { ok: true }
    } catch (err) {
      log('warn', 'main', 'canvases:write-sync:error', {
        error: (err as Error)?.message ?? String(err)
      })
      e.returnValue = { ok: false }
    }
  })

  // canvases:delete(id) -> { ok }. ok:true even if already absent.
  ipcMain.handle('canvases:delete', async (_e, id: unknown): Promise<{ ok: boolean }> => {
    try {
      const full = safeDocPath(id as string)
      if (!full) return { ok: false }
      try {
        await unlink(full)
      } catch (err) {
        // Already absent (ENOENT) is success; anything else is a failure.
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true }
        throw err
      }
      return { ok: true }
    } catch (err) {
      log('warn', 'main', 'canvases:delete:error', {
        error: (err as Error)?.message ?? String(err)
      })
      return { ok: false }
    }
  })

  // canvases:rename({ id, name }) -> { ok }. Read-modify-write: preserves
  // id/createdTs/schema/data; updates name (slice 120, trimmed, keep old if blank)
  // + updatedTs; atomic write.
  ipcMain.handle(
    'canvases:rename',
    async (_e, payload: { id?: unknown; name?: unknown }): Promise<{ ok: boolean }> => {
      try {
        const id = payload?.id
        const full = safeDocPath(id as string)
        if (!full) return { ok: false }
        const raw = await readFile(full, 'utf8')
        const doc = JSON.parse(raw) as CanvasDoc
        if (!doc || typeof doc !== 'object') return { ok: false }
        const nextName =
          typeof payload?.name === 'string' ? payload.name.slice(0, 120).trim() : ''
        if (nextName) doc.name = nextName // keep old name if blank
        doc.updatedTs = Date.now()
        doc.schema = 1
        await ensureDir()
        await atomicWrite(full, JSON.stringify(doc))
        return { ok: true }
      } catch (err) {
        log('warn', 'main', 'canvases:rename:error', {
          error: (err as Error)?.message ?? String(err)
        })
        return { ok: false }
      }
    }
  )

  log('info', 'main', 'canvases:handlers-registered', {})
}
