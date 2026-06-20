import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { useCanvas, registerActiveCwd } from './canvas'
import { useRegions } from './regions'
import { useDrawing } from './drawing'

/**
 * Multi-canvas workspace orchestrator.
 *
 * SINGLE SOURCE OF TRUTH for the LIVE canvas remains the existing `useCanvas`
 * store. This store only holds METADATA (the list of docs on disk), the open
 * TABS, the active id and a loading flag, and saves/loads AROUND useCanvas via
 * useCanvas.loadLayout / useDrawing.setShapes. Each canvas is a NAMED JSON doc on
 * disk under <userData>/canvases/<id>.json, accessed through window.canvasio.canvases.
 *
 * The wire shape (CanvasData/CanvasDoc/CanvasMeta) is the binding contract with
 * the MAIN process; the literal types below are a structurally-identical renderer
 * copy (the preload re-declares its own; both must match the JSON on disk).
 */

// ---------------------------------------------------------------------------
// Wire types (structurally identical to main + preload; JSON shape is binding)
// ---------------------------------------------------------------------------
export interface CanvasData {
  nodes: unknown[]
  waypoints: unknown[]
  regions: unknown[]
  stages: unknown[]
  shapes: unknown[]
}

export interface CanvasDoc {
  id: string
  name: string
  createdTs: number
  updatedTs: number
  schema: 1
  cwd?: string
  data: CanvasData
}

export interface CanvasMeta {
  id: string
  name: string
  updatedTs: number
  cwd?: string
}

// ---------------------------------------------------------------------------
// serializeActiveData — the CANONICAL "current live canvas -> CanvasData".
// Lifted VERBATIM from App.tsx's writeNow node-stripping, EXTENDED with shapes.
// Used in BOTH the active-canvas autosave AND the switch-out save so they can
// never diverge (the App.tsx serialization contract).
// ---------------------------------------------------------------------------
export function serializeActiveData(): CanvasData {
  const persistedNodes = useCanvas.getState().nodes.map((n) => {
    // Strip transient runtime state so a restored node never auto-runs its agent
    // command (no `fresh`/`pendingPrompt`) and never resurrects a stale status.
    const { fresh: _fresh, pendingPrompt: _pp, ...rest } = n
    return { ...rest, status: 'idle' as const }
  })
  return {
    nodes: persistedNodes,
    waypoints: useCanvas.getState().waypoints,
    regions: useRegions.getState().regions,
    stages: useCanvas.getState().stages,
    // NEW: the drawing layer (post-its/rects/arrows/pen). Stored RAW — setShapes()
    // re-runs sanitizeShapes() on the way back in.
    shapes: useDrawing.getState().shapes
  }
}

// ---------------------------------------------------------------------------
// id generation + fuzzy name match
// ---------------------------------------------------------------------------

/** Same id contract MAIN validates against: /^[a-z0-9][a-z0-9_-]{0,63}$/. */
function makeId(): string {
  // nanoid's alphabet includes uppercase + '_' '-'; lowercase + strip anything
  // outside the allowed class, and guarantee a valid leading char.
  const raw = nanoid(16).toLowerCase().replace(/[^a-z0-9_-]/g, '')
  const body = raw.replace(/^[^a-z0-9]+/, '') || 'c'
  return body.slice(0, 64)
}

/** Accent/case-insensitive normalize (mirrors voiceCommands.ts / aiActions.ts). */
const norm = (s: string): string =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()

/**
 * Fuzzy-match a spoken/typed canvas name against the on-disk list: exact ->
 * startsWith -> includes (all accent/case-insensitive). Returns the matching
 * CanvasMeta or null. Exported so aiActions can resolve "ve al lienzo X".
 */
export function matchCanvasByName(name: string, list: CanvasMeta[]): CanvasMeta | null {
  const q = norm(name)
  if (!q) return null
  const exact = list.find((c) => norm(c.name) === q)
  if (exact) return exact
  const starts = list.find((c) => norm(c.name).startsWith(q))
  if (starts) return starts
  const includes = list.find((c) => norm(c.name).includes(q))
  return includes ?? null
}

// ---------------------------------------------------------------------------
// Autosave guard. The App.tsx autosave subscribers fire on EVERY node/region/
// shape change, including the BULK mutations loadLayout/clear/setShapes cause
// during a switch. We set activeId BEFORE loading so a mid-switch write lands
// under the correct (target) id, but we also expose a module-scope `switching`
// flag the autosave can read to skip writes entirely while a switch is in
// flight (belt-and-suspenders against a half-loaded snapshot being persisted).
// ---------------------------------------------------------------------------
let switching = false
export function isSwitching(): boolean {
  return switching
}

// createdTs is NOT carried in CanvasMeta (the list payload), but MAIN preserves
// whatever createdTs we send on write. To avoid clobbering the true creation
// time on every save-out (which would happen if we always sent Date.now()), we
// cache the createdTs we learn whenever a doc is created or read, keyed by id,
// and replay it into rebuildDoc on save-out. A cache miss just falls back to now
// (no data loss — only the createdTs cosmetic drifts in the rare unseen case).
const createdTsCache = new Map<string, number>()
function rememberCreatedTs(doc: CanvasDoc): void {
  if (doc && typeof doc.createdTs === 'number') createdTsCache.set(doc.id, doc.createdTs)
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
interface WorkspaceState {
  canvases: CanvasMeta[]
  openTabs: string[]
  activeId: string | null
  loading: boolean
  refresh: () => Promise<void>
  newCanvas: (name?: string) => Promise<string>
  openCanvas: (id: string) => Promise<void>
  switchTo: (id: string) => Promise<void>
  closeTab: (id: string) => void
  renameCanvas: (id: string, name: string) => Promise<void>
  deleteCanvas: (id: string) => Promise<void>
  setActiveCwd: (cwd: string | null) => Promise<void>
}

/** Build a fresh empty CanvasData snapshot. */
function emptyData(): CanvasData {
  return { nodes: [], waypoints: [], regions: [], stages: [], shapes: [] }
}

/**
 * Empty ALL live canvas stores. useCanvas.clear() only resets nodes/waypoints/
 * stages — it does NOT touch useRegions or useDrawing — so a bare clear() leaks
 * the previous canvas's regions (and shapes) into the next/empty canvas, which
 * the next autosave then writes permanently into that canvas's file. This helper
 * is the single place that fully resets the live layer.
 */
function resetLive(): void {
  useCanvas.getState().clear()
  useRegions.getState().setRegions([])
  useDrawing.getState().clearShapes()
}

/** Load a CanvasDoc's data into the LIVE stores (the destructive-replacement). */
function loadIntoLive(doc: CanvasDoc): void {
  const data = doc.data ?? emptyData()
  // loadLayout EARLY-RETURNS on empty nodes (canvas.ts), so for an empty target
  // we must reset explicitly — otherwise the previous canvas's nodes/regions
  // survive into a "new" empty one. clear() resets nodes + relay/mission/etc.,
  // but NOT regions, so resetLive() also clears useRegions/useDrawing.
  if (Array.isArray(data.nodes) && data.nodes.length) {
    // loadLayout's typed signature wants concrete arrays; the on-disk data is the
    // exact shape it serializes, so the cast is sound (it re-sanitizes inside).
    useCanvas.getState().loadLayout(
      data as unknown as Parameters<ReturnType<typeof useCanvas.getState>['loadLayout']>[0]
    )
  } else {
    resetLive()
  }
  // Always swap the drawing layer (loadLayout/clear never touch useDrawing).
  useDrawing.getState().setShapes((data.shapes ?? []) as never[])
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  canvases: [],
  openTabs: [],
  activeId: null,
  loading: false,

  refresh: async () => {
    try {
      const list = await window.canvasio.canvases.list()
      set({ canvases: Array.isArray(list) ? list : [] })
    } catch {
      set({ canvases: [] })
    }
  },

  newCanvas: async (name) => {
    const id = makeId()
    const now = Date.now()
    const displayName = (name && name.trim()) || `Lienzo ${get().canvases.length + 1}`
    const doc: CanvasDoc = {
      id,
      name: displayName,
      createdTs: now,
      updatedTs: now,
      schema: 1,
      data: emptyData()
    }
    rememberCreatedTs(doc)
    try {
      await window.canvasio.canvases.write(id, doc)
    } catch {
      /* best-effort; the in-memory tab still works until next write */
    }
    // Save the OUTGOING canvas, then empty the live stores. This REPLACES the old
    // destructive clear()/new_canvas wipe — the old canvas survives on disk.
    switching = true
    try {
      const prev = get().activeId
      if (prev && prev !== id) {
        const data = serializeActiveData()
        const meta = get().canvases.find((c) => c.id === prev)
        await window.canvasio.canvases.write(prev, rebuildDoc(prev, meta, data))
      }
      resetLive()
    } finally {
      switching = false
    }
    set((s) => ({
      activeId: id,
      openTabs: s.openTabs.includes(id) ? s.openTabs : [...s.openTabs, id],
      canvases: [
        { id, name: displayName, updatedTs: now },
        ...s.canvases.filter((c) => c.id !== id)
      ]
    }))
    return id
  },

  openCanvas: async (id) => {
    set((s) => ({
      openTabs: s.openTabs.includes(id) ? s.openTabs : [...s.openTabs, id]
    }))
    await get().switchTo(id)
  },

  switchTo: async (id) => {
    if (id === get().activeId) return
    switching = true
    try {
      // 1) Save the OUTGOING canvas BEFORE any load mutates the live stores.
      const prev = get().activeId
      if (prev) {
        const data = serializeActiveData()
        const meta = get().canvases.find((c) => c.id === prev)
        try {
          await window.canvasio.canvases.write(prev, rebuildDoc(prev, meta, data))
        } catch {
          /* best-effort */
        }
      }
      // 2) Read the target doc.
      const doc = await window.canvasio.canvases.read(id)
      if (doc) rememberCreatedTs(doc)
      if (!doc) {
        // Target gone (deleted out from under us): drop the tab, resync.
        set((s) => ({ openTabs: s.openTabs.filter((t) => t !== id) }))
        await get().refresh()
        return
      }
      // 3) Set activeId BEFORE loading so any debounced autosave fired by the bulk
      //    load mutations writes under the TARGET id, not the old one.
      set((s) => ({
        activeId: id,
        openTabs: s.openTabs.includes(id) ? s.openTabs : [...s.openTabs, id]
      }))
      // 4) Load into the live stores (loadLayout-or-clear, then setShapes).
      loadIntoLive(doc)
    } finally {
      switching = false
    }
    // Bump ordering so the just-touched canvas floats to the top of the picker.
    await get().refresh()
  },

  closeTab: (id) => {
    const { openTabs, activeId } = get()
    const idx = openTabs.indexOf(id)
    const nextTabs = openTabs.filter((t) => t !== id)
    set({ openTabs: nextTabs })
    if (id !== activeId) return
    // Closing the active tab: switch to a neighbor (prefer the one to the left),
    // or fall to an empty live canvas with no active doc.
    const neighbor = nextTabs[idx - 1] ?? nextTabs[idx] ?? nextTabs[nextTabs.length - 1]
    if (neighbor) {
      void get().switchTo(neighbor)
    } else {
      // Zero tabs: leave an empty live canvas, activeId=null. The app keeps
      // working (bootRecipe still reachable from the menu). Do NOT persist under
      // a now-closed id.
      switching = true
      try {
        resetLive()
      } finally {
        switching = false
      }
      set({ activeId: null })
    }
  },

  renameCanvas: async (id, name) => {
    const trimmed = name.slice(0, 120).trim()
    if (!trimmed) return
    try {
      await window.canvasio.canvases.rename(id, trimmed)
    } catch {
      /* best-effort */
    }
    set((s) => ({
      canvases: s.canvases.map((c) => (c.id === id ? { ...c, name: trimmed } : c))
    }))
  },

  deleteCanvas: async (id) => {
    // Guard the destructive on-disk delete the SAME way newCanvas/switchTo/closeTab
    // do: while `await remove(id)` is in flight `activeId` is still `id`, so a stray
    // debounced autosave (writeActiveCanvas) would pass its `!switching`/`activeId`
    // guards and re-create `<id>.json` AFTER the unlink — resurrecting a ghost file.
    // Hold `switching` across the delete + meta-removal set; the neighbor-switch
    // paths below (openCanvas/switchTo) manage their own `switching` from there.
    const wasActive = get().activeId === id
    const remainingTabs = get().openTabs.filter((t) => t !== id)
    switching = true
    try {
      try {
        await window.canvasio.canvases.remove(id)
      } catch {
        /* best-effort */
      }
      set((s) => ({
        canvases: s.canvases.filter((c) => c.id !== id),
        openTabs: remainingTabs
      }))
    } finally {
      switching = false
    }
    if (!wasActive) return
    // Deleting the active canvas: switch to a neighbor tab, else any remaining
    // canvas on disk, else clear to an empty live canvas.
    const neighbor = remainingTabs[remainingTabs.length - 1]
    if (neighbor) {
      // neighbor is still active? no — activeId still === id; force switch.
      set({ activeId: null })
      await get().openCanvas(neighbor)
    } else {
      switching = true
      try {
        resetLive()
      } finally {
        switching = false
      }
      set({ activeId: null })
    }
  },

  setActiveCwd: async (cwd) => {
    const { activeId } = get()
    if (!activeId) return
    // Optimistic meta update so the UI reflects the new folder immediately AND so
    // rebuildDoc (which reads meta.cwd) persists it on the next write below.
    set((s) => ({
      canvases: s.canvases.map((c) =>
        c.id === activeId ? { ...c, cwd: cwd ?? undefined } : c
      )
    }))
    // Persist through the SAME rebuildDoc path autosave/switch-out use so the
    // folder lands in the on-disk doc (cwd === null => undefined => omitted).
    const meta = get().canvases.find((c) => c.id === activeId)
    try {
      void window.canvasio.canvases.write(activeId, rebuildDoc(activeId, meta, serializeActiveData()))
    } catch {
      /* best-effort */
    }
  }
}))

/**
 * Persist the CURRENT live canvas to the ACTIVE doc file (the autosave path used
 * by App.tsx). No-op while a switch is in flight or when there is no active id.
 * Reuses serializeActiveData() + the createdTs-preserving rebuildDoc so autosave
 * and switch-out save never diverge. Fire-and-forget (debounced caller).
 */
export function writeActiveCanvas(sync = false): void {
  if (switching) return
  const { activeId, canvases } = useWorkspace.getState()
  if (!activeId) return
  const meta = canvases.find((c) => c.id === activeId)
  try {
    const doc = rebuildDoc(activeId, meta, serializeActiveData())
    // On the quit/window-close path use the SYNCHRONOUS write so the doc reaches
    // disk before the renderer tears down (audit #1 — async invoke can be lost).
    if (sync) window.canvasio.canvases.writeSync(activeId, doc)
    else void window.canvasio.canvases.write(activeId, doc)
  } catch {
    /* best-effort */
  }
}

/**
 * Read-modify-write helper: rebuild a CanvasDoc for a save-out, PRESERVING
 * id/name/createdTs/schema from the known meta (or sane defaults if unknown) and
 * only swapping in fresh `data`. MAIN re-stamps updatedTs + schema on write, so
 * those are advisory here. Preserving createdTs/name matters (a from-scratch
 * rebuild would lose them).
 */
function rebuildDoc(id: string, meta: CanvasMeta | undefined, data: CanvasData): CanvasDoc {
  const now = Date.now()
  return {
    id,
    name: meta?.name ?? id,
    // Preserve the real creation time from the cache (learned on create/read) so
    // a save-out never clobbers it; fall back to now only on a cache miss.
    createdTs: createdTsCache.get(id) ?? now,
    updatedTs: now,
    schema: 1,
    // Carry the per-canvas working folder so every save-out (autosave + switch-out)
    // preserves it. meta.cwd is hydrated from canvases:list on refresh() and set
    // optimistically by setActiveCwd, so it never silently regresses to undefined.
    cwd: meta?.cwd,
    data
  }
}

/**
 * The active canvas's working folder (cwd), or undefined when unset. Read lazily
 * at terminal-spawn call sites to inject node.cwd so new terminals spawn in the
 * canvas's folder. Returns a PRIMITIVE (no new ref) — safe to call anywhere.
 */
export function activeCanvasCwd(): string | undefined {
  const { activeId, canvases } = useWorkspace.getState()
  if (!activeId) return undefined
  return canvases.find((c) => c.id === activeId)?.cwd
}

// Register the active-cwd getter with canvas.ts so its recipe spawns
// (bootRecipe/runRecipe) can inject the active canvas folder into new terminal
// nodes without a static workspace<->canvas import cycle (canvas.ts holds the hook).
registerActiveCwd(activeCanvasCwd)
