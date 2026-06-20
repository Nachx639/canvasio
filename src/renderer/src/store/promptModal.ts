// promptModal.ts (store)
//
// A tiny in-app replacement for window.prompt(), which Electron does NOT support
// (it returns null and shows no dialog, so any feature relying on it silently
// does nothing). This store holds at most ONE pending prompt request and exposes
// a PROMISE-based imperative helper `promptText(message, defaultValue?)` that
// opens the modal and resolves with the entered string (or null if cancelled) —
// a near drop-in for `const x = window.prompt(msg, def)` rewritten as
// `const x = await promptText(msg, def)`.
//
// React #185 discipline: the state shape is a single nullable object plus two
// stable action fns. Consumers (PromptModal.tsx) select the `request` ref and
// the two actions directly — no derived/new-ref selectors — so no extra-render
// crash. The `request.resolve` closure is created once per open() and lives on
// the stored object, never recreated on render.

import { create } from 'zustand'

export interface PromptRequest {
  message: string
  defaultValue: string
  /** Settles the promise returned by promptText and is called exactly once. */
  resolve: (value: string | null) => void
}

interface PromptModalState {
  request: PromptRequest | null
  /** Opens the modal, replacing (and cancelling) any already-pending request. */
  open: (req: PromptRequest) => void
  /** Settle the pending request with `value` and clear it. No-op if none. */
  settle: (value: string | null) => void
}

export const usePromptModal = create<PromptModalState>((set, get) => ({
  request: null,
  open: (req) => {
    // If a request is somehow already pending, cancel it before replacing so
    // its promise never dangles.
    const prev = get().request
    if (prev) prev.resolve(null)
    set({ request: req })
  },
  settle: (value) => {
    const req = get().request
    if (!req) return
    set({ request: null })
    req.resolve(value)
  }
}))

/**
 * Promise-based, near drop-in replacement for window.prompt().
 * Opens the in-app PromptModal and resolves with the entered string, or null
 * if the user cancelled (Escape / Cancelar / click-outside).
 */
export function promptText(message: string, defaultValue = ''): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    usePromptModal.getState().open({ message, defaultValue, resolve })
  })
}
