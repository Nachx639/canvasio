// missionBrief.ts
//
// Mission Brief — the missing intelligence layer ON TOP of the Mission Pulse
// flight recorder. The mission store already records a rich, in-memory stream of
// MissionEvent[] (per-agent transitions, durations, errors, waiting, relay
// handoffs, spawn/close), but nothing ever ANALYZES it — it is only ever shown
// as a raw reverse-chronological list.
//
// This module folds that MissionEvent[] (plus the live canvas node statuses) into
// a deterministic, per-agent intelligence digest: total active time, completions,
// errors, current blockers, the longest single task, baton handoffs given /
// received, and a one-sentence Spanish headline. It is a PURE, side-effect-free
// synthesis layer:
//   - imports ONLY types (no zustand stores, no React, no IPC, no main process),
//   - never mutates its inputs,
//   - is fully deterministic given the same inputs (unit-testable).
//
// It surfaces two ways with zero new infrastructure:
//   1) a "Mission Brief" block at the top of the existing MissionLog panel, plus
//      a Beacon command + a spoken one-line standup through the existing
//      narration queue;
//   2) the same compact headline appended to the AI brain's per-turn context, so
//      voice/typed questions like "¿quién necesita ayuda?" / "resume la misión"
//      finally have temporal grounding over the session.

import type { CanvasNode } from '../store/canvas'
import type { AgentKind } from '../store/canvas'
import type { MissionEvent, MissionKind } from '../store/mission'
import { t } from '../store/i18n'

/** Per-agent rolled-up stats over the whole recorded session. */
export interface AgentBrief {
  nodeId: string
  /** node title at the most recent event we saw for it. */
  title: string
  agent?: AgentKind
  /** sum of durationMs across all terminal transitions OUT of working. */
  totalWorkMs: number
  /** count of 'done' transitions. */
  doneCount: number
  /** count of 'error' transitions. */
  errorCount: number
  /** count of relay rules this node was the SOURCE of (baton given). */
  batonsGiven: number
  /** count of relay rules this node was the TARGET of (baton received). */
  batonsReceived: number
  /** the most recent logical kind recorded for this node. */
  lastKind: MissionKind
  /** wall-clock ts of the most recent event for this node. */
  lastTs: number
  /** the single longest working stretch we saw, in ms (0 if none). */
  longestTaskMs: number
  /**
   * live blocker state, derived from the CURRENT canvas node status and the last
   * logical kind: a node is "blocked" when it is presently in error, or its last
   * recorded logical state was waiting (needs the user) / error.
   */
  blocked: boolean
  /** which kind of blocker: 'error' | 'waiting' | undefined when not blocked. */
  blockerKind?: 'error' | 'waiting'
  /** the node is still live on the canvas (not closed). */
  live: boolean
}

/** A live blocker entry, surfaced prominently in the panel + headline. */
export interface Blocker {
  nodeId: string
  title: string
  agent?: AgentKind
  kind: 'error' | 'waiting'
}

/** The full session digest. */
export interface MissionBrief {
  /** number of distinct agents (terminal nodes) seen in the session. */
  agentCount: number
  /** number of those still live on the canvas. */
  liveCount: number
  totalWorkMs: number
  doneCount: number
  errorCount: number
  batonCount: number
  /** per-agent rows, sorted blockers-first then by most recent activity. */
  agents: AgentBrief[]
  /** live blockers (error / waiting) — the "who needs help" list. */
  blockers: Blocker[]
  /** true when there is no recorded activity at all. */
  empty: boolean
}

// Tiny duplicate of MissionLog's humanDuration so this module stays import-free
// of any component (keeps it pure + unit-testable). Same formatting rules:
// "2m14s", "9s", "1h03m"; '' for undefined / <1s.
function humanDuration(ms?: number): string {
  if (ms == null || ms < 1000) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs ? `${m}m${String(rs).padStart(2, '0')}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return `${h}h${String(rm).padStart(2, '0')}m`
}

const isTerminalOut = (k: MissionKind): boolean =>
  k === 'done' || k === 'error' || k === 'waiting'

/**
 * Fold the recorded MissionEvent[] (and live canvas nodes) into a MissionBrief.
 * Pure and deterministic. `nodes` is used only to know which agents are still
 * live and their CURRENT status (for blocker detection); the historical numbers
 * all come from `events`.
 */
export function computeBrief(events: MissionEvent[], nodes: CanvasNode[]): MissionBrief {
  // Live status + liveness, keyed by nodeId, from the current canvas.
  const liveStatus = new Map<string, CanvasNode['status']>()
  for (const n of nodes) {
    if (n.kind === 'terminal') liveStatus.set(n.id, n.status)
  }

  const map = new Map<string, AgentBrief>()
  const ensure = (e: MissionEvent): AgentBrief => {
    let a = map.get(e.nodeId)
    if (!a) {
      a = {
        nodeId: e.nodeId,
        title: e.title,
        agent: e.agent,
        totalWorkMs: 0,
        doneCount: 0,
        errorCount: 0,
        batonsGiven: 0,
        batonsReceived: 0,
        lastKind: e.kind,
        lastTs: e.ts,
        longestTaskMs: 0,
        blocked: false,
        live: liveStatus.has(e.nodeId)
      }
      map.set(e.nodeId, a)
    }
    return a
  }

  for (const e of events) {
    const a = ensure(e)
    // Keep the freshest denormalized identity + last logical state.
    if (e.ts >= a.lastTs) {
      a.lastTs = e.ts
      a.lastKind = e.kind
      a.title = e.title
      if (e.agent) a.agent = e.agent
    }
    if (isTerminalOut(e.kind)) {
      const d = e.durationMs ?? 0
      if (d > 0) {
        a.totalWorkMs += d
        if (d > a.longestTaskMs) a.longestTaskMs = d
      }
      if (e.kind === 'done') a.doneCount++
      else if (e.kind === 'error') a.errorCount++
    } else if (e.kind === 'relay') {
      // The relay event is recorded against the SOURCE node; the target is named
      // in the detail. Source gives, target (best-effort, by title) receives.
      a.batonsGiven++
    }
  }

  // Resolve baton-received counts: a relay event names its target in `detail`.
  // We can't always map a free-text detail back to a nodeId, but when the detail
  // contains a known agent title we credit that agent. This stays best-effort and
  // never throws.
  const byTitle = new Map<string, AgentBrief>()
  for (const a of map.values()) byTitle.set(a.title.toLowerCase(), a)
  for (const e of events) {
    if (e.kind !== 'relay' || !e.detail) continue
    const detail = e.detail.toLowerCase()
    for (const [title, a] of byTitle) {
      if (title && a.nodeId !== e.nodeId && detail.includes(title)) {
        a.batonsReceived++
        break
      }
    }
  }

  // Blocker detection from live status + last logical kind.
  for (const a of map.values()) {
    a.live = liveStatus.has(a.nodeId)
    if (!a.live) continue
    const status = liveStatus.get(a.nodeId)
    if (status === 'error' || a.lastKind === 'error') {
      a.blocked = true
      a.blockerKind = 'error'
    } else if (a.lastKind === 'waiting') {
      a.blocked = true
      a.blockerKind = 'waiting'
    }
  }

  const agents = [...map.values()].sort((x, y) => {
    // Blockers first, then most recent activity.
    if (x.blocked !== y.blocked) return x.blocked ? -1 : 1
    return y.lastTs - x.lastTs
  })

  const blockers: Blocker[] = agents
    .filter((a) => a.blocked && a.blockerKind)
    .map((a) => ({ nodeId: a.nodeId, title: a.title, agent: a.agent, kind: a.blockerKind! }))

  let totalWorkMs = 0
  let doneCount = 0
  let errorCount = 0
  let batonCount = 0
  for (const a of agents) {
    totalWorkMs += a.totalWorkMs
    doneCount += a.doneCount
    errorCount += a.errorCount
    batonCount += a.batonsGiven
  }

  return {
    agentCount: agents.length,
    liveCount: agents.filter((a) => a.live).length,
    totalWorkMs,
    doneCount,
    errorCount,
    batonCount,
    agents,
    blockers,
    empty: events.length === 0 || agents.length === 0
  }
}

/** Spanish plural helper: "1 agente" / "3 agentes". */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * One Spanish sentence summarizing the session — for narration and for the AI
 * brain's per-turn context. Examples:
 *   "Sin actividad todavía."
 *   "3 agentes, 1 bloqueado en Iris, 2m14s de trabajo, 1 error en Nova."
 */
export function briefHeadline(brief: MissionBrief): string {
  if (brief.empty) return t('missionBrief.no_activity_yet')

  const parts: string[] = []
  parts.push(plural(brief.agentCount, t('missionBrief.agent_one'), t('missionBrief.agent_many')))

  if (brief.blockers.length > 0) {
    const names = brief.blockers.slice(0, 3).map((b) => b.title).join(', ')
    const word =
      brief.blockers.length === 1
        ? t('missionBrief.blocked_one')
        : t('missionBrief.blocked_many')
    parts.push(`${brief.blockers.length} ${word} (${names})`)
  } else {
    parts.push(t('missionBrief.none_blocked'))
  }

  const dur = humanDuration(brief.totalWorkMs)
  if (dur) parts.push(t('missionBrief.duration_of_work', { dur }))

  if (brief.doneCount > 0)
    parts.push(
      plural(brief.doneCount, t('missionBrief.task_done_one'), t('missionBrief.task_done_many'))
    )

  if (brief.errorCount > 0) {
    const withErr = brief.agents.filter((a) => a.errorCount > 0).map((a) => a.title)
    const where = withErr.length
      ? t('missionBrief.error_where', { agents: withErr.slice(0, 2).join(', ') })
      : ''
    parts.push(
      `${plural(brief.errorCount, t('missionBrief.error_one'), t('missionBrief.error_many'))}${where}`
    )
  }

  if (brief.batonCount > 0)
    parts.push(plural(brief.batonCount, t('missionBrief.relay_one'), t('missionBrief.relay_many')))

  return parts.join(', ') + '.'
}

/** A single panel row describing one agent. */
export interface BriefLine {
  /** stable key (nodeId). */
  nodeId: string
  /** the agent title. */
  agent: string
  agentKind?: AgentKind
  /** short status word: "bloqueado" / "trabajando" / "ok". */
  title: string
  /** the descriptive line, e.g. "2m14s · 1 hecha · 1 error · necesita ayuda". */
  text: string
  /** blocker kind for accent coloring, if any. */
  blockerKind?: 'error' | 'waiting'
}

/** Per-agent rows for the panel. Sorted blockers-first (same order as agents). */
export function briefLines(brief: MissionBrief): BriefLine[] {
  return brief.agents.map((a) => {
    const bits: string[] = []
    const dur = humanDuration(a.totalWorkMs)
    if (dur) bits.push(dur)
    if (a.doneCount > 0)
      bits.push(plural(a.doneCount, t('missionBrief.done_one'), t('missionBrief.done_many')))
    if (a.errorCount > 0)
      bits.push(plural(a.errorCount, t('missionBrief.error_one'), t('missionBrief.error_many')))
    if (a.batonsGiven > 0) bits.push(`${a.batonsGiven}→`)
    if (a.batonsReceived > 0) bits.push(`→${a.batonsReceived}`)

    let status = t('missionBrief.status_ok')
    if (a.blockerKind === 'error') status = t('missionBrief.status_error')
    else if (a.blockerKind === 'waiting') status = t('missionBrief.status_needs_you')
    else if (a.live && a.lastKind === 'work-start') status = t('missionBrief.status_working')
    else if (!a.live) status = t('missionBrief.status_closed')

    if (a.blockerKind === 'waiting') bits.push(t('missionBrief.needs_help'))

    return {
      nodeId: a.nodeId,
      agent: a.title,
      agentKind: a.agent,
      title: status,
      text: bits.length ? bits.join(' · ') : t('missionBrief.no_activity'),
      blockerKind: a.blockerKind
    }
  })
}
