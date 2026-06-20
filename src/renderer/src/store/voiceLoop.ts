// voiceLoop.ts
//
// Voice Standup Loop — hands-free, closed-loop Q&A with the swarm.
//
// CanvasIO already has four proven primitives that have never been wired into a
// single loop:
//   1) DETECTION — useQuestions (store/questions.ts) pools live "an agent is
//      BLOCKED on you" cards, attributed to the asking node.
//   2) SPEECH    — narration.ts speaks Spanish through Piper via a throttled,
//      mute/volume-aware utterance queue (speakLine).
//   3) CAPTURE   — useVoiceCapture (hooks/useVoiceCapture.ts) records your spoken
//      reply and transcribes it (STT).
//   4) DELIVERY  — useRelay.enqueueForTarget(targetId, text) routes text straight
//      into ONE specific agent's terminal through the readiness-gated drain.
//
// Voice Standup Loop closes the circle: when ARMED and an Open Question fires for
// node N, the canvas SPEAKS it to you ("Iris pregunta: ¿uso Postgres o Redis?")
// and arms a ONE-SHOT voice reply. Your very next push-to-talk answer is diverted
// (in useVoiceCapture) to consumeReply(), routed verbatim back to N via
// enqueueForTarget, and the card is auto-resolved. You keep coding in another
// window; a voice asks, you answer out loud, the agent unblocks.
//
// DESIGN CONTRACT (mirrors director.ts / stall.ts / relay.ts / questions.ts):
//   - PURE RENDERER, IN-MEMORY ONLY. Never persisted, never serialized into
//     canvasio:layout, never sent over IPC, never registered into canvas reset (it
//     holds no orphanable geometry — only a transient pending target id that is
//     re-validated against live nodes at consume time).
//   - SELF-CANCELLING. The module-scope questions subscription is ALWAYS torn
//     down on disarm(), so it can never leak or double-run (stall.ts discipline).
//   - ONE-AT-A-TIME / NO-SPAM. At most ONE pending reply target; while a reply is
//     pending, newly-detected questions do not overwrite it (no question-spam).
//   - ALL CROSS-STORE READS ARE CALL-TIME-ONLY (inside methods, via getState()),
//     so there is no module-init cross import, no init-order hazard, no cycle.
//
// One-directional imports only (voiceLoop -> questions / relay / canvas /
// narration); none of those import voiceLoop, so there is no cycle.

import { create } from 'zustand'
import { useQuestions } from './questions'
import { useRelay } from './relay'
import { useCanvas } from './canvas'
import { speakLine, isNarrationEnabled } from '../lib/narration'
import { pickNextQuestion } from '../lib/voiceLoop'

/** A single armed one-shot reply target. */
export interface PendingReply {
  /** id of the open-question card we will resolve once answered. */
  questionId: string
  /** node id of the agent that asked (delivery target for enqueueForTarget). */
  targetId: string
  /** the asking node's title at detect time (for the "respondiendo a <X>" chip). */
  askingTitle: string
  /** the question text (for the chip / debugging). */
  text: string
}

interface VoiceLoopState {
  /** True while the loop is live-watching for blocking questions. */
  armed: boolean
  /** The single armed one-shot reply, or null when nothing is awaiting an answer. */
  pending: PendingReply | null

  arm: () => void
  disarm: () => void
  toggle: () => void
  /**
   * Divert a freshly-transcribed spoken reply to the pending target. Routes the
   * transcript verbatim to useRelay.enqueueForTarget, resolves the matching
   * question card, clears the pending slot and narrates a one-line confirmation.
   * Returns true when the transcript was consumed (so the caller short-circuits
   * its normal interpret()/run() path), false when there was nothing pending or
   * the transcript was empty (caller proceeds normally).
   */
  consumeReply: (transcript: string) => boolean
}

// Module-scope subscription handle, mirroring stall.ts/director.ts. Only ONE is
// ever live; teardown() clears it.
let unsubQuestions: (() => void) | null = null

function teardown(): void {
  if (unsubQuestions) {
    unsubQuestions()
    unsubQuestions = null
  }
}

/** The set of question ids we've already spoken, so a re-emitted questions array
 *  (zustand fires the listener on every set) never re-speaks the same card. */
const announced = new Set<string>()

export const useVoiceLoop = create<VoiceLoopState>((set, get) => {
  /**
   * Scan the live questions for a NEW unresolved card with a real asking node.
   * Fires at most one speak + one pending arm per pass, and never while a reply
   * is already pending (one-at-a-time, no spam).
   */
  const onQuestions = (): void => {
    if (!get().armed) return
    // Live node existence: only voice a question whose asking node still exists,
    // so we never arm a reply for a now-closed agent (criticalPath snapshot
    // discipline — read live nodes at decision time).
    const liveIds = new Set(
      useCanvas
        .getState()
        .nodes.filter((n) => n.kind === 'terminal')
        .map((n) => n.id)
    )
    // Deterministic selection lives in the pure helper (lib/voiceLoop). It also
    // enforces one-at-a-time (skips entirely when a reply is already pending).
    const pick = pickNextQuestion(
      useQuestions.getState().questions,
      liveIds,
      announced,
      get().pending != null
    )
    if (!pick) return
    announced.add(pick.questionId)
    set({
      pending: {
        questionId: pick.questionId,
        targetId: pick.targetId,
        askingTitle: pick.askingTitle,
        text: pick.text
      }
    })
    // Speak the question out loud (gated by narration enabled + volume inside
    // speakLine's shared throttled queue). No-op when narration is off.
    if (isNarrationEnabled()) speakLine(`${pick.askingTitle} pregunta: ${pick.text}`)
  }

  return {
    armed: false,
    pending: null,

    arm: () => {
      if (get().armed) return
      teardown()
      announced.clear()
      set({ armed: true, pending: null })
      // Live feed: every questions mutation may add a brand-new card to voice.
      unsubQuestions = useQuestions.subscribe(() => {
        if (get().armed) onQuestions()
      })
      // Seed once in case a question is already on the bus at arm time.
      onQuestions()
    },

    disarm: () => {
      teardown()
      announced.clear()
      set({ armed: false, pending: null })
    },

    toggle: () => {
      if (get().armed) get().disarm()
      else get().arm()
    },

    consumeReply: (transcript) => {
      const pending = get().pending
      if (!pending) return false
      const body = (transcript || '').replace(/\s+/g, ' ').trim()
      if (!body) return false

      // Re-validate the target still exists at consume time (the asking node may
      // have closed while you composed your reply). If it's gone, drop the pending
      // slot and DON'T consume — let the caller's normal path handle the speech.
      const liveIds = new Set(
        useCanvas
          .getState()
          .nodes.filter((n) => n.kind === 'terminal')
          .map((n) => n.id)
      )
      if (!liveIds.has(pending.targetId)) {
        set({ pending: null })
        return false
      }

      // Deliver the spoken answer verbatim into the asking agent's terminal via
      // the SAME readiness-gated relay drain handoffs use.
      const ok = useRelay.getState().enqueueForTarget(pending.targetId, body)
      // Auto-resolve the question card (idempotent — resolve() no-ops if gone).
      useQuestions.getState().resolve(pending.questionId)
      set({ pending: null })
      // Confirm out loud (one line, through the shared throttled narration queue).
      if (ok && isNarrationEnabled()) speakLine(`Respuesta enviada a ${pending.askingTitle}`)
      // Consumed regardless of enqueue success: the operator clearly intended this
      // utterance as the answer, so we never fall through to interpret() with it.
      return true
    }
  }
})
