import { create } from 'zustand'

/**
 * One turn in the spoken exchange shown as a chat bubble over the canvas.
 * `role` distinguishes the user (right) from the assistant (left).
 */
export interface VoiceBubble {
  id: string
  role: 'user' | 'assistant'
  text: string
  ts: number
}

/** Keep only the most recent turns so old ones fade out instead of piling up. */
const MAX_BUBBLES = 6

interface VoiceChatState {
  bubbles: VoiceBubble[]
  /** Append a user/assistant bubble (no-op on empty text). */
  push: (role: VoiceBubble['role'], text: string) => void
  /** Drop all bubbles (used by "nueva conversación" / reset). */
  clear: () => void
}

let seq = 0

export const useVoiceChat = create<VoiceChatState>((set) => ({
  bubbles: [],
  push: (role, text) => {
    const t = (text || '').trim()
    if (!t) return
    const bubble: VoiceBubble = { id: `vb-${Date.now()}-${seq++}`, role, text: t, ts: Date.now() }
    set((s) => ({ bubbles: [...s.bubbles, bubble].slice(-MAX_BUBBLES) }))
  },
  clear: () => set({ bubbles: [] })
}))

/** Imperative helpers for non-React call sites (the aiActions/run pipeline). */
export function pushVoiceBubble(role: VoiceBubble['role'], text: string): void {
  useVoiceChat.getState().push(role, text)
}

export function clearVoiceBubbles(): void {
  useVoiceChat.getState().clear()
}
