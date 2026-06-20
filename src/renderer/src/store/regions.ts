// regions.ts
//
// Districts — Spatial Regions & Territory. A Region is a labeled, colored
// rectangle drawn directly on the infinite world: a soft tinted area with a
// title chip ("Frontend", "Research", "Bug triage") that lives BEHIND the nodes
// and gives a part of the canvas persistent meaning (like Figma Sections /
// FigJam areas / Miro frames).
//
// PURE DATA — this store mirrors the Waypoint store profile exactly: it holds a
// tiny {id,name,x,y,w,h,color} record and never stores which nodes a region
// "contains" (that is computed on demand by lib/territory.ts via a bbox test, so
// it can never desync from live node geometry). It is PERSISTED to canvasio:layout
// (same safety profile as waypoints) and never sent over IPC.
//
// IMPORTANT — one-directional import contract: regions.ts imports NOTHING from
// canvas.ts, so canvas.ts (or any consumer) may statically import this store
// without creating a cycle (mirroring relay.ts / waypoints).

import { create } from 'zustand'
import { nanoid } from 'nanoid'

/** A labeled, colored spatial region painted behind the nodes. */
export interface Region {
  id: string
  name: string
  x: number
  y: number
  w: number
  h: number
  /** CSS color (hex). Used at low alpha for the fill and full for the chip. */
  color: string
}

/** A soft, distinct palette cycled when no explicit color is given. */
export const DISTRICT_COLORS = [
  '#7aa2ff', // blue
  '#d97757', // claude-orange
  '#10a37f', // codex-green
  '#c084fc', // purple
  '#f2c84b', // amber
  '#5bd1c0' // teal
] as const

let colorIdx = 0
function nextColor(): string {
  const c = DISTRICT_COLORS[colorIdx % DISTRICT_COLORS.length]
  colorIdx++
  return c
}

interface RegionsState {
  regions: Region[]
  /**
   * Add a District. Normalizes negative w/h (so a drag in any direction lands a
   * positive box), cycles the palette when no color is given, and returns the
   * new region id. Geometry is the only required input.
   */
  addRegion: (r: { name?: string; x: number; y: number; w: number; h: number; color?: string }) => string
  /** Rename a District (pure data; keeps the old name if the new one is blank). */
  renameRegion: (id: string, name: string) => void
  /** Recolor a District (pure data). */
  recolorRegion: (id: string, color: string) => void
  /** Delete a District (pure data; never touches nodes). */
  removeRegion: (id: string) => void
  /** Translate a District by (dx,dy). Pure region-geometry write; the contained
   *  nodes are moved separately by the caller via canvas.updateNode. */
  moveRegion: (id: string, dx: number, dy: number) => void
  /**
   * Replace the whole set (used by "Map my territory" and persistence restore).
   * Sanitizes every entry (finite geometry, usable id/name/color) so a
   * hand-edited / imported layout can never inject a NaN box or a duplicate id.
   */
  setRegions: (regions: Region[]) => void
  /** Wipe every District (called on a full canvas reset). */
  clear: () => void
}

/** Coerce one raw entry into a safe Region, or null if it's unusable. */
function sanitize(r: unknown, seen: Set<string>): Region | null {
  if (!r || typeof r !== 'object') return null
  const o = r as Partial<Region>
  if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) return null
  if (!Number.isFinite(o.w) || !Number.isFinite(o.h) || (o.w as number) <= 0 || (o.h as number) <= 0)
    return null
  const id = o.id && !seen.has(o.id) ? o.id : nanoid(8)
  seen.add(id)
  return {
    id,
    name: (typeof o.name === 'string' && o.name.trim()) || 'Distrito',
    x: o.x as number,
    y: o.y as number,
    w: o.w as number,
    h: o.h as number,
    color: (typeof o.color === 'string' && o.color.trim()) || nextColor()
  }
}

export const useRegions = create<RegionsState>((set) => ({
  regions: [],

  addRegion: ({ name, x, y, w, h, color }) => {
    // Normalize negative size so a drag in any direction lands a positive box.
    const nx = w < 0 ? x + w : x
    const ny = h < 0 ? y + h : y
    const nw = Math.abs(w)
    const nh = Math.abs(h)
    const id = nanoid(8)
    const region: Region = {
      id,
      name: (name && name.trim()) || 'Distrito',
      x: nx,
      y: ny,
      w: nw,
      h: nh,
      color: color || nextColor()
    }
    set((s) => ({ regions: [...s.regions, region] }))
    return id
  },

  renameRegion: (id, name) =>
    set((s) => ({
      regions: s.regions.map((r) => (r.id === id ? { ...r, name: name.trim() || r.name } : r))
    })),

  recolorRegion: (id, color) =>
    set((s) => ({ regions: s.regions.map((r) => (r.id === id ? { ...r, color } : r)) })),

  removeRegion: (id) => set((s) => ({ regions: s.regions.filter((r) => r.id !== id) })),

  moveRegion: (id, dx, dy) =>
    set((s) => ({
      regions: s.regions.map((r) => (r.id === id ? { ...r, x: r.x + dx, y: r.y + dy } : r))
    })),

  setRegions: (regions) =>
    set(() => {
      const seen = new Set<string>()
      const clean: Region[] = []
      for (const r of regions) {
        const ok = sanitize(r, seen)
        if (ok) clean.push(ok)
      }
      return { regions: clean }
    }),

  clear: () => set({ regions: [] })
}))
