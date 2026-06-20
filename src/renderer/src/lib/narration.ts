// narration.ts
//
// Ambient Spanish narration of agent status changes. Speaks a short sentence
// only on *meaningful* transitions and serializes all utterances through a
// single async queue so multiple agents never talk over each other.

import { useCanvas } from '../store/canvas'
import type { AgentKind } from '../store/canvas'
import type { AgentStatus } from './agentStatus'
import { t } from '../store/i18n'

const STORAGE_KEY = 'canvasio:narrate'

// --- enabled flag (persisted) ----------------------------------------------

let enabled: boolean = readEnabled()

function readEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw == null) return true // default on
    return raw === '1' || raw === 'true'
  } catch {
    return true
  }
}

export function isNarrationEnabled(): boolean {
  return enabled
}

export function setNarrationEnabled(v: boolean): void {
  enabled = v
  try {
    localStorage.setItem(STORAGE_KEY, v ? '1' : '0')
  } catch {
    /* ignore */
  }
}

// --- transition -> phrase ---------------------------------------------------

/**
 * Returns the Spanish sentence to speak for a given transition, or null if the
 * transition is not worth narrating. We only announce the moments that matter:
 * completion, error and "needs you" (waiting). Transitions *into* working/idle
 * are intentionally silent to keep the canvas calm.
 */
export function phraseForTransition(
  title: string,
  _oldStatus: AgentStatus | undefined,
  newStatus: AgentStatus
): string | null {
  const name = (title || t('narration.defaultAgent')).trim()
  switch (newStatus) {
    case 'done':
      return t('narration.done', { name })
    case 'error':
      return t('narration.error', { name })
    case 'waiting':
      return t('narration.waiting', { name })
    default:
      return null
  }
}

// --- startup-phase suppression ---------------------------------------------

// How long after a node spawns we stay completely silent. Boot banners, help
// text and the agent CLI's normal startup chatter can briefly look like an
// error/done state; we never want to narrate any of that.
const STARTUP_SILENCE_MS = 6000

interface NodeLifecycle {
  /** wall-clock time the node's terminal/pty spawned */
  spawnedAt: number
  /** the node entered 'working' at least once (the agent actually did something) */
  hasWorked: boolean
}

const lifecycles = new Map<string, NodeLifecycle>()

/**
 * Register that a node has just spawned. Resets its lifecycle so the next
 * ~STARTUP_SILENCE_MS of transitions are suppressed and done/error/waiting are
 * only narrated once the node has genuinely entered 'working'.
 */
export function registerNodeSpawn(nodeId: string, now: number = Date.now()): void {
  lifecycles.set(nodeId, { spawnedAt: now, hasWorked: false })
  lastSpokenStatus.delete(nodeId)
}

// --- sequential utterance queue --------------------------------------------

interface QueueItem {
  text: string
  voice?: string
}

const queue: QueueItem[] = []
let draining = false

// Throttling: keep the canvas calm even when many agents change state at once.
// 1) A minimum gap between the *start* of consecutive utterances so we never
//    machine-gun phrases back-to-back.
// 2) A hard cap on the queue depth — if a burst of transitions piles up we drop
//    the oldest pending phrases (they're already stale by the time we'd reach
//    them) rather than narrate a long out-of-date backlog.
const MIN_GAP_MS = 1200
const MAX_QUEUE = 4
let lastSpokenAt = 0

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

// Per-node de-dupe: avoid announcing the same status twice in a row for the
// same node (e.g. repeated 'done' detections while idle at a prompt).
const lastSpokenStatus = new Map<string, AgentStatus>()

function enqueue(item: QueueItem): void {
  queue.push(item)
  // Drop the oldest stale phrases under a burst so we never read a long backlog.
  while (queue.length > MAX_QUEUE) queue.shift()
  if (!draining) void drain()
}

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    while (queue.length) {
      const item = queue.shift()!
      // Re-check live conditions at play time: the user may have muted or
      // disabled narration while items were waiting in the queue.
      if (!enabled) continue
      const volume = useCanvas.getState().appVolume
      if (volume <= 0) continue
      // Throttle: enforce a minimum gap since the previous utterance started.
      const wait = MIN_GAP_MS - (Date.now() - lastSpokenAt)
      if (wait > 0) await sleep(wait)
      // Re-check after sleeping — the user may have muted in the meantime.
      if (!enabled || useCanvas.getState().appVolume <= 0) continue
      lastSpokenAt = Date.now()
      try {
        await speak(item.text, item.voice, useCanvas.getState().appVolume)
      } catch {
        /* swallow — one bad utterance shouldn't stall the queue */
      }
    }
  } finally {
    draining = false
  }
}

async function speak(text: string, voice: string | undefined, volume: number): Promise<void> {
  const res = await window.canvasio.voice.tts(text, voice)
  if (!res || !res.ok || !res.wavBase64) return
  await new Promise<void>((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    try {
      const audio = new Audio('data:audio/wav;base64,' + res.wavBase64)
      audio.volume = Math.min(1, Math.max(0, volume))
      audio.onended = done
      audio.onerror = done
      // Safety: never let a stuck audio element block the queue forever.
      const guard = window.setTimeout(done, 15000)
      const clear = (): void => window.clearTimeout(guard)
      audio.onended = () => {
        clear()
        done()
      }
      audio.onerror = () => {
        clear()
        done()
      }
      void audio.play().catch(() => {
        clear()
        done()
      })
    } catch {
      done()
    }
  })
}

// --- public entry point -----------------------------------------------------

/**
 * Notify the narrator of a status transition for a node. Speaks (asynchronously,
 * via the queue) only when narration is enabled, volume > 0, and the transition
 * is meaningful. Safe to call on every status change.
 */
export function narrateTransition(
  nodeId: string,
  title: string,
  _agent: AgentKind | undefined,
  oldStatus: AgentStatus | undefined,
  newStatus: AgentStatus,
  voice?: string,
  now: number = Date.now()
): void {
  // Always keep lifecycle bookkeeping up to date, even when we end up silent —
  // otherwise a node could "miss" its working transition and never speak again.
  const life = lifecycles.get(nodeId)
  if (newStatus === 'working' && life) life.hasWorked = true

  if (!enabled) {
    lastSpokenStatus.set(nodeId, newStatus)
    return
  }
  if (useCanvas.getState().appVolume <= 0) {
    lastSpokenStatus.set(nodeId, newStatus)
    return
  }

  // --- startup-phase suppression ---
  // 1) Stay silent for the first ~STARTUP_SILENCE_MS after the node spawned.
  //    Boot banners / help text can transiently look like error/done/waiting.
  // 2) Only narrate done/error/waiting once the node has actually been in
  //    'working' at least once (the agent really started doing something). A
  //    banner that briefly looks finished or failed must not speak.
  if (life) {
    if (now - life.spawnedAt < STARTUP_SILENCE_MS) {
      lastSpokenStatus.set(nodeId, newStatus)
      return
    }
    if (newStatus !== 'working' && !life.hasWorked) {
      lastSpokenStatus.set(nodeId, newStatus)
      return
    }
  }

  // De-dupe identical consecutive announcements for the same node.
  if (lastSpokenStatus.get(nodeId) === newStatus) return

  const phrase = phraseForTransition(title, oldStatus, newStatus)
  lastSpokenStatus.set(nodeId, newStatus)
  if (!phrase) return

  enqueue({ text: phrase, voice })
}

/**
 * Speak a short "baton passed" line when Agent Relay hands work to `targetTitle`.
 * Reuses the same throttled, mute/volume-aware utterance queue as
 * narrateTransition, so a relay narration never talks over status narration.
 * Unconditional of per-node lifecycle suppression (it is an explicit user-
 * choreographed handoff, not boot chatter), but still respects enabled/volume.
 */
export function narrateBaton(targetTitle: string): void {
  if (!enabled) return
  try {
    if (useCanvas.getState().appVolume <= 0) return
  } catch {
    return
  }
  const name = (targetTitle || t('narration.defaultAgent')).trim()
  enqueue({ text: t('narration.baton', { name }) })
}

/**
 * Speak the one-line Mission Brief standup (e.g. "3 agentes, 1 bloqueado en
 * Iris, 2m14s de trabajo, 1 error en Nova"). Goes through the SAME throttled,
 * mute/volume-aware utterance queue as status/relay narration, so a brief can
 * never talk over other narration. Respects enabled/volume/MAX_QUEUE. The
 * headline string is computed by the caller (lib/missionBrief.briefHeadline) and
 * passed in, keeping this module free of any store/synthesis dependency.
 */
export function narrateBrief(headline: string): void {
  if (!enabled) return
  try {
    if (useCanvas.getState().appVolume <= 0) return
  } catch {
    return
  }
  const text = (headline || '').trim()
  if (!text) return
  enqueue({ text })
}

/**
 * Speak an arbitrary one-off line through the SAME throttled, mute/volume-aware
 * utterance queue as status/relay/brief narration, so it can never talk over
 * other narration. Used by the Voice Standup Loop to voice a blocking question
 * and confirm a routed reply. Respects enabled/volume/MAX_QUEUE; no-op when off
 * or empty. A thin public wrapper over the module-private `enqueue`.
 */
export function speakLine(text: string, voice?: string): void {
  if (!enabled) return
  try {
    if (useCanvas.getState().appVolume <= 0) return
  } catch {
    return
  }
  const body = (text || '').trim()
  if (!body) return
  enqueue({ text: body, voice })
}

/** Forget remembered state for a node (call when a node/terminal is disposed). */
export function resetNarration(nodeId: string): void {
  lastSpokenStatus.delete(nodeId)
  lifecycles.delete(nodeId)
}
