// conductor.ts (store glue)
//
// The Conductor — store glue for the Next-Best-Action reasoner (lib/conductor.ts).
//
// This is a TINY zustand store that holds NOTHING persistent (IN-MEMORY ONLY,
// never added to canvas.ts loadLayout / serialization — the exact same contract
// as mission.ts). It exists only to:
//   1) getRecommendations() — lazily read useCanvas / useMission / useRelay /
//      useBoard / useLens / useEcho / useChangeset at CALL TIME ONLY (never at
//      module init), assemble the pure ConductorInput, and return recommend(...).
//   2) runAction(rec) — dispatch ONE recommendation to EXISTING store actions
//      only: 'fly' → centerOnNode, 'attention' → cycleAttention, 'open-board' /
//      'open-critical' → toggle the existing panels (via the same CustomEvents the
//      Command Palette + hotkeys already use). Zero new IPC, zero geometry mutation.
//
// CALL-TIME-ONLY DISCIPLINE: like mission.getBrief() and relay.criticalPath(),
// every cross-store read happens INSIDE the method, never at module init, so the
// ES-module import graph has no initialization-order hazard.

import { create } from 'zustand'
import { useCanvas, type CanvasNode } from './canvas'
import { useMission, latestEventByNode, type MissionEvent } from './mission'
import { useRelay } from './relay'
import { useBoard } from './board'
import { useLens } from './lens'
import { useEcho } from './echo'
import { useChangeset } from './changeset'
import { useScorecard } from './scorecard'
import { analyzeConsensus } from '../lib/consensus'
import { assessObjective } from '../lib/objective'
import { computeScorecard, type Scorecard } from '../lib/scorecard'
import {
  recommend,
  type Recommendation,
  type ConductorInput,
  type AgentSnapshot,
  type RelayReady
} from '../lib/conductor'

/** A live status narrowed to the Conductor's snapshot vocabulary. */
function statusOf(n: CanvasNode): AgentSnapshot['status'] {
  switch (n.status) {
    case 'working':
      return 'working'
    case 'done':
      return 'done'
    case 'error':
      return 'error'
    default:
      return 'idle'
  }
}

interface ConductorState {
  /**
   * Lazily assemble the pure ConductorInput from every existing in-memory surface
   * and return the ranked recommendations. Reads all stores via getState() INSIDE
   * the call only, so conductor.ts keeps its call-time-only import discipline
   * (no store is touched at module init). Pure downstream: recommend() never
   * mutates anything. Defensive — any unavailable store degrades to its empty form.
   */
  getRecommendations: () => Recommendation[]
  /**
   * Execute ONE recommendation by routing to an EXISTING store action / panel
   * toggle. No new IPC, no geometry mutation beyond the existing camera tween.
   * Returns true when it dispatched something.
   */
  runAction: (rec: Recommendation | undefined) => boolean
}

export const useConductor = create<ConductorState>(() => ({
  getRecommendations: () => {
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
    const consensus = (() => {
      try {
        return analyzeConsensus(useBoard.getState().facts)
      } catch {
        return { corroborated: [], conflicts: [] }
      }
    })()

    // Echo / Lens / Changeset for per-node objective assessment (drift detection).
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

    // --- terminal-only snapshots, folded from the latest mission event + objective ---
    const last = latestEventByNode(events)
    // Single O(E) forward pass to group events by node. A forward push preserves the
    // exact element order of `events.filter((e) => e.nodeId === n.id)`, so the arrays
    // handed to assessObjective are identical — drops per-node assessment from O(N*E)
    // to O(E+N).
    const eventsByNode = new Map<string, MissionEvent[]>()
    for (const e of events) {
      const a = eventsByNode.get(e.nodeId)
      if (a) a.push(e)
      else eventsByNode.set(e.nodeId, [e])
    }
    const terminals = nodes.filter((n) => n.kind === 'terminal')
    const agents: AgentSnapshot[] = terminals.map((n) => {
      const ev = last.get(n.id)
      // Live objective judgment (only when the node carries an objective). Reuses
      // the exact same inputs NodeView's ObjectiveChip assembles.
      let objective: AgentSnapshot['objective']
      if (n.objective?.text) {
        const echoLines = (echo[n.id] ?? []).map((l) => l.text)
        const lensLine = lens[n.id]?.text
        const cs = changeset[n.id] as
          | { files: { length: number }; adds: number; dels: number }
          | undefined
        const nodeEvents = eventsByNode.get(n.id) ?? []
        const assessment = assessObjective({
          objective: n.objective,
          status: n.status,
          echoLines,
          lensLine,
          events: nodeEvents,
          diff: cs ? { files: cs.files.length, adds: cs.adds, dels: cs.dels } : undefined
        })
        objective = assessment.judgment
      }
      return {
        nodeId: n.id,
        title: n.title || 'Agente',
        kind: n.agent,
        status: statusOf(n),
        lastKind: ev?.kind,
        lastTs: ev?.ts ?? 0,
        objective
      }
    })

    // --- relay readiness: a DONE source with armed downstream rules still waiting ---
    // Mirrors criticalPath()'s armed-edges-are-pending semantics: an armed rule
    // whose source has finished but hasn't been confirmed/looked-in is a baton the
    // operator can release. We count distinct still-armed downstream targets.
    const relayReady: RelayReady[] = (() => {
      try {
        const rules = useRelay.getState().rules
        const known = new Set(terminals.map((n) => n.id))
        const bySource = new Map<string, Set<string>>()
        for (const r of rules) {
          if (!r.armed) continue
          if (!known.has(r.sourceId) || !known.has(r.targetId)) continue
          const set = bySource.get(r.sourceId) ?? new Set<string>()
          set.add(r.targetId)
          bySource.set(r.sourceId, set)
        }
        const out: RelayReady[] = []
        for (const [sourceId, targets] of bySource) {
          out.push({ sourceId, waiting: targets.size })
        }
        return out
      } catch {
        return []
      }
    })()

    // Agent Scorecard — read the persisted cross-mission track record lazily at
    // call time (same call-time-only discipline as every other surface here), so
    // the Conductor can attach a 'prefer-reliable' hint. Defensive: any failure
    // degrades to an empty scorecard (no hints), never breaks the recommendations.
    const scorecard: Scorecard = (() => {
      try {
        return useScorecard.getState().getRanked()
      } catch {
        return computeScorecard([])
      }
    })()

    const input: ConductorInput = {
      agents,
      critical,
      consensus,
      relayReady,
      scorecard,
      now: Date.now()
    }
    return recommend(input)
  },

  runAction: (rec) => {
    if (!rec) return false
    switch (rec.actionKind) {
      case 'fly': {
        if (!rec.nodeId) return false
        try {
          useCanvas.getState().centerOnNode(rec.nodeId)
          return true
        } catch {
          return false
        }
      }
      case 'attention': {
        try {
          useCanvas.getState().cycleAttention('next')
          return true
        } catch {
          return false
        }
      }
      case 'open-board': {
        // The Brief Board listens for this CustomEvent (same as 'B' / the palette).
        window.dispatchEvent(new CustomEvent('canvasio:open-board'))
        // If the action is also node-scoped, fly there too so the conflict context
        // is on screen behind the panel.
        if (rec.nodeId) {
          try {
            useCanvas.getState().centerOnNode(rec.nodeId)
          } catch {
            /* camera optional */
          }
        }
        return true
      }
      case 'open-critical': {
        // Surface the Critical Path by flying along the chain via the existing
        // cycleAttention march, then nudging the camera to the bottleneck when one
        // is known — no new panel, reuses existing camera actions only.
        try {
          const cp = useRelay.getState().criticalPath()
          if (cp.bottleneckId) useCanvas.getState().centerOnNode(cp.bottleneckId)
          else useCanvas.getState().cycleAttention('next')
          return true
        } catch {
          return false
        }
      }
      case 'none':
      default:
        return false
    }
  }
}))
