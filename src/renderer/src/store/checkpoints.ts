// checkpoints.ts
//
// Checkpoints — one-key restorable savepoints per agent. The first WRITE-capable
// quick-action on top of the app's deep read-only OBSERVE layer (Chronoscope,
// Thermal, Agent Lens, Changeset Lens). Press K on a terminal node to capture
// that agent's ENTIRE working tree as a named, timestamped savepoint, implemented
// on `git stash create` (a dangling commit; WT/index/HEAD untouched). Saved
// checkpoints appear as a stacked chip on the node; selecting one previews its
// diff and offers Restore (`git stash apply`) behind the Doctor's confirm gate.
//
// IMPORTANT — persistence contract: this state lives ONLY in memory, exactly like
// changeset.ts / lens.ts / mission.ts / relay.ts. It is NEVER added to canvas.ts
// loadLayout / App.tsx serialization, so it cannot affect persistence or
// cold-start. The checkpoints THEMSELVES persist in the repo's git refs (under
// refs/canvasio/checkpoints), so they survive restart even though this store is
// ephemeral — they are re-listed live by the poll, exactly like changesets.

import { create } from 'zustand'

/** One captured savepoint's metadata (mirrors main/git.ts CheckpointMeta). */
export interface CheckpointMeta {
  /** full commit sha of the dangling stash commit. */
  sha: string
  /** short sha for display. */
  short: string
  /** capture wall-clock ms. */
  ts: number
  /** files captured. */
  files: number
  /** lines added captured. */
  adds: number
  /** lines deleted captured. */
  dels: number
}

interface CheckpointState {
  /** per-nodeId list of checkpoints, newest-first. */
  byNode: Record<string, CheckpointMeta[]>
  /** Overwrite the checkpoint list for a node (from a fresh list() poll). An
   *  empty list clears the entry so a node with no checkpoints drops its chip. */
  set: (nodeId: string, list: CheckpointMeta[]) => void
  /** Drop checkpoints for one node (call on terminal disposal). */
  clearForNode: (nodeId: string) => void
  /** Wipe all (call on new_canvas / clear). */
  clearAll: () => void
  /**
   * Capture a checkpoint for one node via the read-only-by-construction git
   * bridge (window.canvasio.git.checkpoints.create — non-mutating `git stash create`),
   * then refresh that node's list. Resolves to the new CheckpointMeta or null
   * (clean tree / non-git / failure). The canvas node is read lazily at call-time
   * (getState) so this store keeps no canvas import; the caller passes cwd+label.
   */
  captureFor: (nodeId: string, cwd: string, label?: string) => Promise<CheckpointMeta | null>
  /** Re-list a node's checkpoints from git into the store. Best-effort. */
  refresh: (nodeId: string, cwd: string) => Promise<void>
}

/** Cheap structural equality so an unchanged poll doesn't re-render the chip. */
function sameList(prev: CheckpointMeta[] | undefined, next: CheckpointMeta[]): boolean {
  if (!prev) return next.length === 0
  if (prev.length !== next.length) return false
  for (let i = 0; i < next.length; i++) {
    if (prev[i].sha !== next[i].sha) return false
  }
  return true
}

export const useCheckpoints = create<CheckpointState>((set, get) => ({
  byNode: {},

  set: (nodeId, list) =>
    set((s) => {
      if (!list.length) {
        if (!(nodeId in s.byNode)) return {}
        const { [nodeId]: _drop, ...rest } = s.byNode
        return { byNode: rest }
      }
      if (sameList(s.byNode[nodeId], list)) return {}
      return { byNode: { ...s.byNode, [nodeId]: list } }
    }),

  clearForNode: (nodeId) =>
    set((s) => {
      if (!(nodeId in s.byNode)) return {}
      const { [nodeId]: _drop, ...rest } = s.byNode
      return { byNode: rest }
    }),

  clearAll: () => set({ byNode: {} }),

  captureFor: async (nodeId, cwd, label) => {
    const bridge = window.canvasio?.git?.checkpoints
    if (!bridge || !cwd) return null
    try {
      const meta = await bridge.create(cwd, label)
      // Always re-list afterward so the store reflects the authoritative git
      // state (and picks up the new ref even if `meta` raced a concurrent poll).
      await get().refresh(nodeId, cwd)
      return meta
    } catch {
      return null
    }
  },

  refresh: async (nodeId, cwd) => {
    const bridge = window.canvasio?.git?.checkpoints
    if (!bridge || !cwd) return
    try {
      const list = await bridge.list(cwd)
      if (list) get().set(nodeId, list)
    } catch {
      /* best-effort; leave existing list untouched */
    }
  }
}))
