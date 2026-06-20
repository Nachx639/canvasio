// horizon.ts (store glue)
//
// Mission Horizon — store glue for the swarm-level completion forecaster
// (lib/horizon.ts).
//
// This is a TINY zustand store that holds ONLY the declared mission goal — a single
// in-memory string that is NEVER serialized / NEVER added to canvas.ts loadLayout
// (the exact same persistence contract as mission.ts / conductor.ts). It exists only
// to:
//   1) setGoal / clearGoal — declare or clear the ONE overarching mission goal.
//   2) getForecast() — lazily read useCanvas / useMission / useRelay / useLens /
//      useEcho / useChangeset at CALL TIME ONLY (never at module init), assemble the
//      pure HorizonInput (per-agent objective percents via the SAME assessObjective
//      inputs ConductorChip / NodeView build, finished-task durations from Mission
//      Pulse, on-critical membership from the relay critical path), and return
//      computeHorizon(...).
//
// CALL-TIME-ONLY DISCIPLINE: like mission.getBrief(), relay.criticalPath() and
// conductor.getRecommendations(), every cross-store read happens INSIDE the method,
// never at module init, so the ES-module import graph has no initialization-order
// hazard.
//
// clearGoal() is registered into canvas.resetRelayAndMission() (alongside the
// existing board/mission/lens clears) so a new / loaded canvas always starts with no
// declared mission goal.

import { create } from 'zustand'
import { useCanvas, type CanvasNode } from './canvas'
import { useMission } from './mission'
import { useRelay } from './relay'
import { useLens } from './lens'
import { useEcho } from './echo'
import { useChangeset } from './changeset'
import { assessObjective } from '../lib/objective'
import { computeHorizon, type HorizonForecast, type HorizonAgent, type HorizonInput } from '../lib/horizon'

interface HorizonState {
  /**
   * The ONE declared overarching mission goal (in-memory only, NEVER serialized).
   * Empty string = no goal declared (the forecast reads a calm idle state).
   */
  goal: string
  /** Declare / replace the mission goal (trimmed). */
  setGoal: (goal: string) => void
  /** Clear the mission goal (also called from resetRelayAndMission on canvas reset). */
  clearGoal: () => void
  /**
   * Lazily assemble the pure HorizonInput from every existing in-memory surface and
   * return the swarm-level forecast. Reads all stores via getState() INSIDE the call
   * only, so horizon.ts keeps its call-time-only import discipline. Pure downstream:
   * computeHorizon() never mutates anything. Defensive — any unavailable store
   * degrades to its empty form.
   */
  getForecast: () => HorizonForecast
}

export const useHorizon = create<HorizonState>((set, get) => ({
  goal: '',

  setGoal: (goal) => set({ goal: (goal || '').trim() }),

  clearGoal: () => set({ goal: '' }),

  getForecast: () => {
    const goal = get().goal
    // No goal → don't even read the stores; computeHorizon returns idle anyway, but
    // this keeps the calm idle path allocation-free.
    if (!goal) return computeHorizon({ goal: '', agents: [], finishedDurationsMs: [], now: Date.now() })

    // --- read every surface lazily (call-time only) ---
    let nodes: CanvasNode[] = []
    try {
      nodes = useCanvas.getState().nodes
    } catch {
      /* no canvas */
    }
    const events = (() => {
      try {
        return useMission.getState().events
      } catch {
        return []
      }
    })()
    const critical = (() => {
      try {
        return useRelay.getState().criticalPath()
      } catch {
        return { blocked: [], bottleneckId: null, bottleneckHeld: 0, chain: [] }
      }
    })()
    const echo = (() => {
      try {
        return useEcho.getState().entries
      } catch {
        return {} as Record<string, { text: string }[]>
      }
    })()
    const lens = (() => {
      try {
        return useLens.getState().lines
      } catch {
        return {} as Record<string, { text: string }>
      }
    })()
    const changeset = (() => {
      try {
        return useChangeset.getState().byNode
      } catch {
        return {} as Record<string, { files: { length: number }; adds: number; dels: number }>
      }
    })()

    // On-critical membership: the relay critical chain ∪ every blocked target. Same
    // structure the Conductor uses for leverage.
    const onCritical = new Set<string>(critical.chain)
    for (const b of critical.blocked) onCritical.add(b.nodeId)

    // --- per-agent objective contributions (terminals only) ---
    // Reuses the EXACT same assessObjective inputs ConductorChip / NodeView build:
    // echo ring + latest lens line + this node's mission events + changeset diffstat.
    const terminals = nodes.filter((n) => n.kind === 'terminal')
    const agents: HorizonAgent[] = terminals.map((n) => {
      const hasObjective = !!n.objective?.text
      let percent = 0
      let judgment: HorizonAgent['judgment'] = 'idle'
      if (hasObjective) {
        const echoLines = (echo[n.id] ?? []).map((l) => l.text)
        const lensLine = lens[n.id]?.text
        const cs = changeset[n.id] as
          | { files: { length: number }; adds: number; dels: number }
          | undefined
        const nodeEvents = events.filter((e) => e.nodeId === n.id)
        const assessment = assessObjective({
          objective: n.objective,
          status: n.status,
          echoLines,
          lensLine,
          events: nodeEvents,
          diff: cs ? { files: cs.files.length, adds: cs.adds, dels: cs.dels } : undefined
        })
        percent = assessment.percent
        judgment = assessment.judgment
      }
      return {
        nodeId: n.id,
        title: n.title || 'Agente',
        percent,
        judgment,
        onCritical: onCritical.has(n.id),
        hasObjective
      }
    })

    // --- velocity sample: durationMs of every FINISHED task Mission Pulse recorded ---
    // A 'done' event carries durationMs (how long the agent worked before finishing);
    // that is the per-task work velocity the forecaster extrapolates from. We only
    // count terminals still on the canvas so a stale, closed node's old durations
    // don't skew the live forecast (denormalized titles aside, this matches the
    // mission timeline's live-agent intent).
    const known = new Set(terminals.map((n) => n.id))
    const finishedDurationsMs: number[] = []
    for (const e of events) {
      if (e.kind !== 'done') continue
      if (typeof e.durationMs !== 'number' || !(e.durationMs > 0)) continue
      if (!known.has(e.nodeId)) continue
      finishedDurationsMs.push(e.durationMs)
    }

    const input: HorizonInput = {
      goal,
      agents,
      finishedDurationsMs,
      now: Date.now()
    }
    return computeHorizon(input)
  }
}))
