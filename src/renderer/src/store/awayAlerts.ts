// awayAlerts.ts (store glue)
//
// Away Alerts — the PERSISTED preferences for native OS notifications. CanvasIO
// had rich in-window attention surfaces but ZERO native OS integration: you fire
// off several agents, alt-tab to your editor, and never learn when one finishes,
// errors, or goes `waiting` on your input. The watcher in App.tsx closes that loop
// (debounced native Notification + dock badge via a one-way IPC channel); THIS tiny
// store holds the user's preferences — a master toggle plus per-event-type flags.
//
// PERSISTENCE CONTRACT — the same inversion Recall / Scorecard use:
//   * persists to its OWN localStorage key 'canvasio:awayAlerts' (load lazily at store
//     init, save synchronously on each mutation, all inside try/catch — quota /
//     blocked / malformed storage degrades silently to defaults),
//   * NEVER added to canvasio:layout / App.tsx canvas serialization, NEVER sent over
//     IPC, and deliberately NOT registered into the full-reset surface: like Recall,
//     New Canvas wipes the live board but these PREFERENCES persist.
//   * imports NOTHING from canvas.ts (no cycle) — the decision logic + Spanish copy
//     live in the PURE lib/awayAlerts.ts.
//
// Defaults: enabled, with waiting + error ON (the two states that actually need
// you) and done OFF (a finished agent is good news, not an interruption) — the
// user can flip any of them in Settings / the command palette.

import { create } from 'zustand'

/** The localStorage key. Its OWN key, untouched by canvasio:layout serialization. */
const STORAGE_KEY = 'canvasio:awayAlerts'

/** The persisted preference shape. */
interface AwayPrefs {
  /** master switch — when off, no native notification ever fires. */
  enabled: boolean
  /** notify when an agent finishes (done). Default OFF — good news isn't urgent. */
  notifyDone: boolean
  /** notify when an agent goes waiting (needs your input). Default ON. */
  notifyWaiting: boolean
  /** notify when an agent hits an error. Default ON. */
  notifyError: boolean
}

const DEFAULTS: AwayPrefs = {
  enabled: true,
  notifyDone: false,
  notifyWaiting: true,
  notifyError: true
}

/** Coerce an unknown to a boolean with a fallback (defensive load). */
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

/** Load persisted prefs. Defensive: any malformed/blocked storage → defaults. */
function load(): AwayPrefs {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULTS }
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULTS }
    const o = parsed as Record<string, unknown>
    return {
      enabled: bool(o.enabled, DEFAULTS.enabled),
      notifyDone: bool(o.notifyDone, DEFAULTS.notifyDone),
      notifyWaiting: bool(o.notifyWaiting, DEFAULTS.notifyWaiting),
      notifyError: bool(o.notifyError, DEFAULTS.notifyError)
    }
  } catch {
    return { ...DEFAULTS }
  }
}

/** Persist synchronously. Defensive: quota/blocked storage is ignored. */
function save(prefs: AwayPrefs): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    /* ignore quota/blocked storage — preferences must never throw into a caller */
  }
}

interface AwayAlertsState extends AwayPrefs {
  /** Flip the master switch and persist. */
  toggle: () => void
  setEnabled: (v: boolean) => void
  toggleDone: () => void
  toggleWaiting: () => void
  toggleError: () => void
}

export const useAwayAlerts = create<AwayAlertsState>((set, get) => {
  // Lazily loaded ONCE at store creation (first import), mirroring recall.ts.
  const initial = load()

  /** Apply a partial mutation, persist the full prefs, and return the patch. */
  const commit = (patch: Partial<AwayPrefs>): void => {
    set(patch as Partial<AwayAlertsState>)
    const s = get()
    save({
      enabled: s.enabled,
      notifyDone: s.notifyDone,
      notifyWaiting: s.notifyWaiting,
      notifyError: s.notifyError
    })
  }

  return {
    ...initial,
    toggle: () => commit({ enabled: !get().enabled }),
    setEnabled: (v) => commit({ enabled: v }),
    toggleDone: () => commit({ notifyDone: !get().notifyDone }),
    toggleWaiting: () => commit({ notifyWaiting: !get().notifyWaiting }),
    toggleError: () => commit({ notifyError: !get().notifyError })
  }
})
