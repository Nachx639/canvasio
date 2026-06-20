// termRegistry.ts
//
// A module-level registry of live-terminal scrollback readers, mirroring the
// existing module-level Map pattern in TerminalOverlay (lastHarvestAt /
// lastQuestionAt). Each live <TerminalOverlay> registers a closure that, when
// called, reads its xterm buffer line-by-line into a string[]. Beacon takes a
// one-shot snapshot() of every reader to run a pure content search across the
// whole canvas without any new IPC, store wiring, or per-terminal subscription.
//
// Lifecycle: register on terminal open, unregister on unmount/dispose. Because
// the registry self-prunes on unmount, a closed node can never appear in a
// snapshot, and a reader for a terminal whose buffer isn't ready yet simply
// returns [] (its node is skipped). Pure runtime state: never persisted, never
// sent over IPC, insertion-ordered = node spawn/reading order (which Beacon
// relies on for deterministic ranking).

/** A reader returns this terminal's scrollback as plain text lines, newest last. */
export type ScrollbackReader = () => string[]

const readers = new Map<string, ScrollbackReader>()

/** Register (or replace) the scrollback reader for a node's live terminal. */
export function register(nodeId: string, read: ScrollbackReader): void {
  readers.set(nodeId, read)
}

/** Remove a node's reader (call on terminal unmount/dispose). */
export function unregister(nodeId: string): void {
  readers.delete(nodeId)
}

/** True when a node currently has a registered reader (a live terminal). */
export function has(nodeId: string): boolean {
  return readers.has(nodeId)
}

/** Number of live terminals currently registered. */
export function size(): number {
  return readers.size
}

/**
 * Take a one-shot snapshot: invoke every registered reader and collect its
 * lines into a fresh Map<nodeId, string[]> in registration (reading) order.
 * A reader that throws or yields nothing is skipped so a half-mounted terminal
 * never breaks a search. The returned Map is owned by the caller (Beacon).
 */
export function snapshot(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [nodeId, read] of readers) {
    try {
      const lines = read()
      if (lines && lines.length > 0) out.set(nodeId, lines)
    } catch {
      /* skip a terminal whose buffer isn't readable right now */
    }
  }
  return out
}
