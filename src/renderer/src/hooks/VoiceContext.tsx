import { createContext, useContext } from 'react'
import { useVoiceCapture, type VoiceCapture } from './useVoiceCapture'

const VoiceContext = createContext<VoiceCapture | null>(null)

/**
 * Instantiates the voice capture pipeline EXACTLY ONCE and shares it with every
 * consumer (the command bar and the floating FAB). This guarantees a single
 * MediaRecorder + a single in-flight guard, so the two UIs can never spawn
 * racing recorders or parallel AI orders.
 */
export function VoiceProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const voice = useVoiceCapture()
  return <VoiceContext.Provider value={voice}>{children}</VoiceContext.Provider>
}

// Inert capture used when a consumer renders outside <VoiceProvider>. Returning
// this (instead of throwing) means a provider-ordering mistake degrades voice to
// a no-op rather than crashing the whole React tree and tearing down the PTYs.
const NOOP_VOICE: VoiceCapture = {
  recording: false,
  busy: false,
  thinking: false,
  speaking: false,
  status: 'idle',
  caps: null,
  hint: '',
  transcript: '',
  modelPct: null,
  speakOn: false,
  setSpeakOn: () => {},
  startRec: async () => {},
  stopRec: () => {},
  toggleRec: () => {},
  run: async () => {},
  downloadModel: async () => {}
}

export function useVoice(): VoiceCapture {
  const ctx = useContext(VoiceContext)
  return ctx ?? NOOP_VOICE
}
