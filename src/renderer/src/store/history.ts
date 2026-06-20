import { create } from 'zustand'
import type { CanvasNode } from './canvas'

/**
 * Layout Time Machine — spatial undo/redo for the canvas.
 *
 * A thin, RENDERER-ONLY linear-history store of `nodes`-array snapshots taken
 * right BEFORE the four destructive spatial operations:
 *   • drag-move (one snapshot per gesture)
 *   • resize    (one snapshot per gesture)
 *   • arrange() / flowLayout() (bulk auto-layout)
 *   • node close (removeNode)
 *
 * Contract (mirrors replay.ts / the camHistory module-scope stacks):
 *   • PURE IN-MEMORY — never persisted to canvasio:layout, never sent over IPC.
 *     App.tsx only serializes nodes/waypoints, so nothing here survives reload.
 *   • One-directional imports: history.ts imports ONLY the CanvasNode TYPE from
 *     canvas.ts (a type-only import, erased at build time → no runtime cycle).
 *     canvas.ts imports the runtime `useHistory` to push/reset.
 *   • Standard linear semantics: pushing a new action clears the redo (`future`)
 *     branch. undo() moves the top of `past` onto `future` and asks canvas.ts to
 *     apply the snapshot; redo() does the reverse.
 *   • Bounded: `past` is capped at MAX_DEPTH so memory can't grow without bound.
 *
 * A snapshot is a shallow copy of the node array with each node shallow-cloned
 * and the TRANSIENT `fresh` flag stripped (same strip the persistence path does)
 * so a restored node never spuriously re-runs its agent command.
 */

export type HistoryLabel =
  | 'move'
  | 'resize'
  | 'arrange'
  | 'flow'
  | 'declutter'
  | 'cascade'
  | 'close'

export interface HistorySnapshot {
  label: HistoryLabel
  nodes: CanvasNode[]
}

/** Max retained undo steps. Bounds memory; older steps drop off the bottom. */
const MAX_DEPTH = 30

interface HistoryState {
  past: HistorySnapshot[]
  future: HistorySnapshot[]
  /**
   * Monotonic tick bumped on every push/undo/redo/reset so React consumers
   * (CommandPalette rows, HistoryToast) re-render and re-read canUndo/canRedo.
   */
  tick: number
  /**
   * Last applied action label + direction, for the transient toast. Bumped on
   * undo()/redo() (consumed via `tick`); null after a reset.
   */
  lastAction: { label: HistoryLabel; dir: 'undo' | 'redo'; remaining: number } | null
}

/** Strip the transient `fresh` flag and shallow-clone each node so later
 *  in-place edits to the live array can't mutate a captured snapshot. */
function snapshotNodes(nodes: CanvasNode[]): CanvasNode[] {
  return nodes.map(({ fresh: _fresh, ...rest }) => ({ ...rest }))
}

export const useHistory = create<HistoryState>(() => ({
  past: [],
  future: [],
  tick: 0,
  lastAction: null
}))

/**
 * Capture the pre-mutation `nodes` array under `label`. Called at the TOP of the
 * four destructive operations (and the gesture-start hooks). Clears the redo
 * branch (linear history) and caps depth. Pure data; never persisted/IPC.
 */
export function pushHistory(label: HistoryLabel, nodes: CanvasNode[]): void {
  useHistory.setState((s) => {
    const next = [...s.past, { label, nodes: snapshotNodes(nodes) }]
    // Cap depth by dropping the oldest entries.
    const past = next.length > MAX_DEPTH ? next.slice(next.length - MAX_DEPTH) : next
    return { past, future: [], tick: s.tick + 1 }
  })
}

/**
 * Pop the most recent snapshot off `past`, pushing the CURRENT (pre-undo) nodes
 * onto `future` so redo() can return to it. Returns the snapshot to apply, or
 * null when there is nothing to undo. The caller (canvas.undo) applies it.
 */
export function takeUndo(currentNodes: CanvasNode[]): HistorySnapshot | null {
  const { past, future } = useHistory.getState()
  if (!past.length) return null
  const snap = past[past.length - 1]
  // The label on the redo entry describes what redo would re-apply (i.e. the
  // action we are undoing), so the toast reads symmetrically.
  const redoEntry: HistorySnapshot = { label: snap.label, nodes: snapshotNodes(currentNodes) }
  useHistory.setState((s) => ({
    past: s.past.slice(0, -1),
    future: [...future, redoEntry],
    tick: s.tick + 1,
    lastAction: { label: snap.label, dir: 'undo', remaining: s.past.length - 1 }
  }))
  return snap
}

/**
 * Pop the most recent snapshot off `future` (a previously-undone state),
 * pushing the CURRENT nodes back onto `past`. Returns the snapshot to apply, or
 * null when there is nothing to redo.
 */
export function takeRedo(currentNodes: CanvasNode[]): HistorySnapshot | null {
  const { past, future } = useHistory.getState()
  if (!future.length) return null
  const snap = future[future.length - 1]
  const undoEntry: HistorySnapshot = { label: snap.label, nodes: snapshotNodes(currentNodes) }
  useHistory.setState((s) => ({
    past: [...past, undoEntry],
    future: s.future.slice(0, -1),
    tick: s.tick + 1,
    lastAction: { label: snap.label, dir: 'redo', remaining: s.future.length - 1 }
  }))
  return snap
}

/** Wipe both stacks (new canvas / loaded layout / boot recipe). */
export function resetHistory(): void {
  useHistory.setState((s) => ({ past: [], future: [], tick: s.tick + 1, lastAction: null }))
}

/** Read-only availability for command rows / keybindings. */
export function canUndo(): boolean {
  return useHistory.getState().past.length > 0
}
export function canRedo(): boolean {
  return useHistory.getState().future.length > 0
}
