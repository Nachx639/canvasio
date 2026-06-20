// calendar.ts (store glue)
//
// Calendar Annotations — a PERSISTED, CROSS-CANVAS notes store keyed by ISO date
// (YYYY-MM-DD). It backs every CALENDAR node: the annotations live HERE in a
// single global store, not on any individual canvas node, so the SAME notes show
// up in any calendar node on any canvas and survive app restarts.
//
// PERSISTENCE CONTRACT — the same inversion Scorecard/Recall use:
//   * persists to its OWN key 'canvasio:calendar' (load lazily at store init, save
//     synchronously on each mutation, all inside try/catch — quota/blocked/
//     malformed storage degrades silently to defaults; a mutation must NEVER
//     throw into a caller running beside live UI),
//   * NEVER added to canvasio:layout / App.tsx canvas serialization, NEVER sent over
//     IPC, and deliberately NOT registered into resetRelayAndMission(): New
//     Canvas wipes the live board but these annotations PERSIST. clearAll() is
//     the only way to forget them.
//   * imports NOTHING from canvas.ts (no cycle): notes are pure data.
//
// React #185 guard: selectors that return arrays/objects MUST be wrapped in
// useShallow at the call site (CalendarNode subscribes via useShallow over the
// notes array for the open day). The notesFor() getter returns a defensive COPY.

import { create } from 'zustand'
import { nanoid } from 'nanoid'

/** The localStorage key. Its OWN key, untouched by canvasio:layout serialization. */
const STORAGE_KEY = 'canvasio:calendar'
/** Defensive per-note text cap so a single annotation can't bloat storage. */
const MAX_NOTE_LEN = 10000

/** One annotation on a given day. `id` is a nanoid; `text` is a trimmed string. */
export interface CalendarNote {
  id: string
  text: string
}

/** annotations[dateISO] = ordered list of notes for that day. */
type Annotations = Record<string, CalendarNote[]>

/** True for a well-formed ISO YYYY-MM-DD date string. */
function isIsoDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

/** Coerce + clamp an unknown to a clean note text (trimmed, capped). */
function cleanText(v: unknown): string {
  if (typeof v !== 'string') return ''
  const t = v.trim()
  return t.length > MAX_NOTE_LEN ? t.slice(0, MAX_NOTE_LEN) : t
}

/** Defensively load + sanitize the persisted annotations (malformed → empty). */
function load(): Annotations {
  const out: Annotations = {}
  try {
    if (typeof localStorage === 'undefined') return out
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return out
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return out
    for (const [date, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isIsoDate(date) || !Array.isArray(list)) continue
      const notes: CalendarNote[] = []
      for (const item of list) {
        if (!item || typeof item !== 'object') continue
        const it = item as { id?: unknown; text?: unknown }
        const text = cleanText(it.text)
        if (!text) continue
        notes.push({ id: typeof it.id === 'string' && it.id ? it.id : nanoid(8), text })
      }
      if (notes.length > 0) out[date] = notes
    }
    return out
  } catch {
    return {}
  }
}

/** Persist synchronously. Defensive: quota/blocked storage is ignored. */
function save(annotations: Annotations): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(annotations))
  } catch {
    /* ignore quota/blocked storage */
  }
}

interface CalendarState {
  /** annotations[dateISO] = ordered notes for that day. */
  annotations: Annotations
  /** Append a new note to a day (no-op for empty text / bad date). */
  addNote: (date: string, text: string) => void
  /** Replace a note's text (removes it if the new text trims to empty). */
  editNote: (date: string, noteId: string, text: string) => void
  /** Remove one note from a day. */
  removeNote: (date: string, noteId: string) => void
  /** Read the notes for a day as a defensive COPY (safe to map/render). */
  notesFor: (date: string) => CalendarNote[]
  /** Wipe every annotation (the only way to forget the calendar). */
  clearAll: () => void
}

export const useCalendar = create<CalendarState>((set, get) => ({
  // Lazily loaded ONCE at store creation (first import), mirroring scorecard.ts.
  annotations: load(),

  addNote: (date, text) => {
    if (!isIsoDate(date)) return
    const t = cleanText(text)
    if (!t) return
    set((s) => {
      const list = s.annotations[date] ?? []
      const next = [...list, { id: nanoid(8), text: t }]
      return { annotations: { ...s.annotations, [date]: next } }
    })
    save(get().annotations)
  },

  editNote: (date, noteId, text) => {
    if (!isIsoDate(date)) return
    const t = cleanText(text)
    set((s) => {
      const list = s.annotations[date]
      if (!list) return s
      // An edit that empties the text deletes the note.
      const next = t
        ? list.map((n) => (n.id === noteId ? { ...n, text: t } : n))
        : list.filter((n) => n.id !== noteId)
      const annotations = { ...s.annotations }
      if (next.length > 0) annotations[date] = next
      else delete annotations[date]
      return { annotations }
    })
    save(get().annotations)
  },

  removeNote: (date, noteId) => {
    if (!isIsoDate(date)) return
    set((s) => {
      const list = s.annotations[date]
      if (!list) return s
      const next = list.filter((n) => n.id !== noteId)
      const annotations = { ...s.annotations }
      if (next.length > 0) annotations[date] = next
      else delete annotations[date]
      return { annotations }
    })
    save(get().annotations)
  },

  // Defensive COPY so callers can never mutate the live store array in place
  // (and so a non-useShallow read still gets a stable-enough snapshot).
  notesFor: (date) => (get().annotations[date] ?? []).slice(),

  clearAll: () => {
    set({ annotations: {} })
    save(get().annotations)
  }
}))
