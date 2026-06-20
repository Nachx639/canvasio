// mission.ts
//
// Mission Pulse — the live cross-agent activity timeline. A single chronological
// feed that records every meaningful event on the canvas: each agent's logical
// status transition (work-start / done / error / waiting, with how long it was
// working), every Agent Relay handoff, and node spawn / close. It is the
// canvas's flight recorder — the visible, persistent counterpart to the audible,
// ephemeral narration.
//
// Events are recorded at the SAME single transition chokepoint that already
// drives narration and relay (TerminalOverlay.applyStatus), plus the spawn/exit
// lifecycle points, so this adds intelligence without changing any existing
// behavior.
//
// IMPORTANT — persistence contract: this state lives ONLY in memory. It is
// NEVER added to canvas.ts loadLayout / serialization, so it cannot affect
// persistence or cold-start behavior. A fresh / restored canvas always starts
// with an empty log. Existing features are untouched.

import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type { AgentKind, CanvasNode } from './canvas'
// NOTE on imports: canvas.ts already statically imports THIS module (mission.ts)
// for resetRelayAndMission(), and uses it only at call-time (never at module
// init). To synthesize the Mission Brief we need the live canvas nodes, so we
// import useCanvas back — but, mirroring that same pattern, we only ever touch it
// INSIDE getBrief() (call-time), never at module-init. ES-module circular imports
// resolve cleanly under this deferred-usage discipline, so this introduces no
// initialization-order hazard.
import { useCanvas } from './canvas'
import { computeBrief, type MissionBrief } from '../lib/missionBrief'

/** Kinds of recorded events, ordered roughly by lifecycle. */
export type MissionKind = 'spawn' | 'work-start' | 'done' | 'error' | 'waiting' | 'relay' | 'close'

/** A single immutable entry in the mission timeline. */
export interface MissionEvent {
  id: string
  /** wall-clock ms when the event was recorded. */
  ts: number
  /** the node the event is about (source node for a relay). */
  nodeId: string
  /** node title at record time (denormalized so a closed node still reads well). */
  title: string
  /** agent persona, for accent coloring; undefined for non-agent nodes. */
  agent?: AgentKind
  kind: MissionKind
  /** optional free-text detail (e.g. relay instruction, target name). */
  detail?: string
  /**
   * for terminal transitions OUT of 'working': how long the agent was working,
   * in ms. Lets the feed read "Nova trabajó 2m14s -> hecho".
   */
  durationMs?: number
}

/**
 * Fold a flat event list to the latest event per node. Shared by every consumer
 * that needs a node's most-recent logical transition (attentionQueue,
 * buildReplyTargets, PulseRadar.waitingIds, ThermalOverlay.errorIds). Pure.
 *
 * Tie-break is `>=` so that, for equal timestamps, the later event in iteration
 * order wins (last-wins-on-tie) — preserved exactly from the inlined copies it
 * replaces. Iteration order over `events` is unchanged.
 */
export function latestEventByNode(events: MissionEvent[]): Map<string, MissionEvent> {
  const m = new Map<string, MissionEvent>()
  for (const e of events) {
    const prev = m.get(e.nodeId)
    if (!prev || e.ts >= prev.ts) m.set(e.nodeId, e)
  }
  return m
}

/** Hard cap to bound memory: a ring buffer that drops the oldest events. */
const MAX_EVENTS = 300

interface MissionState {
  events: MissionEvent[]
  /** Append one event (id/ts auto-filled if omitted). Caps the ring buffer. */
  record: (e: Omit<MissionEvent, 'id' | 'ts'> & { id?: string; ts?: number }) => void
  /** Drop every event for a node (call on node disposal, alongside resetNarration). */
  clearForNode: (nodeId: string) => void
  /** Wipe the whole log (call on new_canvas / clear). */
  clearAll: () => void
  /**
   * Lazily synthesize the Mission Brief (intelligence digest) from the current
   * events + live canvas nodes. Reads the canvas via getState() INSIDE the call
   * only, so mission.ts keeps its one-directional-import contract (canvas.ts is
   * never statically imported here — it imports US). Pure: never mutates state.
   */
  getBrief: () => MissionBrief
}

export const useMission = create<MissionState>((set, get) => ({
  events: [],

  record: (e) =>
    set((s) => {
      const ev: MissionEvent = {
        id: e.id ?? nanoid(8),
        ts: e.ts ?? Date.now(),
        nodeId: e.nodeId,
        title: e.title,
        agent: e.agent,
        kind: e.kind,
        detail: e.detail,
        durationMs: e.durationMs
      }
      const next = [...s.events, ev]
      // Bound memory: keep only the newest MAX_EVENTS.
      if (next.length > MAX_EVENTS) next.splice(0, next.length - MAX_EVENTS)
      return { events: next }
    }),

  clearForNode: (nodeId) => set((s) => ({ events: s.events.filter((ev) => ev.nodeId !== nodeId) })),

  clearAll: () => set({ events: [] }),

  getBrief: () => {
    // Read the live canvas nodes lazily, only here (call-time). Defensive: if the
    // canvas store isn't available for any reason, fall back to no nodes.
    let nodes: CanvasNode[] = []
    try {
      nodes = useCanvas.getState().nodes
    } catch {
      /* no canvas available — compute over an empty node set */
    }
    return computeBrief(get().events, nodes)
  }
}))
