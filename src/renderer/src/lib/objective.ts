// objective.ts
//
// Agent Objectives — Goal-vs-Actual Progress Intelligence.
//
// Every existing intelligence surface in CanvasIO (Mission Pulse/Brief, Agent
// Lens, Echo, Changeset/Collision Watch, Stall Watch, Director) is REACTIVE
// observability about an agent IN ISOLATION FROM ITS GOAL: it tells you what an
// agent IS (idle/working/error, last output line, files touched, time spent) but
// never what it is SUPPOSED to be doing, nor whether it is getting there. The one
// question a multi-agent operator asks all day — "is Atlas actually making
// progress on what I asked, or spinning?" — has no answer on the canvas.
//
// This module makes the goal a first-class citizen. Given a node's Objective (a
// one-line mission + an optional tiny checklist of done-signals), it folds
// together signals CanvasIO ALREADY captures in memory — the Echo ring of recent
// output lines, the live Lens excerpt, mission events for that node, and the
// changeset diffstat — into a deterministic PROGRESS reading: a 0-100% percent, a
// per-checklist-item ticked[] (auto-ticked as matching signals appear in the
// agent's own output), and a calm judgment ('on-track' | 'drifting' | 'met' |
// 'idle').
//
// PURITY CONTRACT (mirrors missionBrief.ts / insightHarvest.ts / stallRescue.ts):
//   - imports ONLY types (no zustand stores, no React, no IPC, no main process),
//   - never mutates its inputs,
//   - is fully deterministic given the same inputs (trivially unit-testable),
//   - precision over recall: when unsure, return a neutral reading.
//
// The objective TEXT persists with the node (it rides App.tsx's existing `...rest`
// spread, exactly like cwd/command). The DERIVED reading produced here is
// in-memory-only like every other intelligence surface — nothing here is stored.

import type { CanvasNode } from '../store/canvas'
import type { MissionEvent } from '../store/mission'
import { t } from '../store/i18n'

/** One checklist done-signal for an objective. */
export interface ChecklistItem {
  /** human-facing label, also the keyword source matched against output. */
  label: string
  /**
   * Persisted manual override: when the user explicitly ticks/unticks an item by
   * hand it stays that way. assessObjective never mutates this; it derives the
   * LIVE ticked[] separately (manual OR auto-detected from output).
   */
  done: boolean
}

/** An agent's goal: a one-line mission plus an optional tiny checklist. */
export interface Objective {
  /** the one-line mission, e.g. "ship the login form". */
  text: string
  /** optional small set of done-signals. */
  checklist?: ChecklistItem[]
}

/** The calm goal-aware judgment for an objective. */
export type ObjectiveJudgment = 'on-track' | 'drifting' | 'met' | 'idle'

/** The deterministic live reading produced by assessObjective. */
export interface ObjectiveAssessment {
  /** 0-100 progress toward the goal. */
  percent: number
  judgment: ObjectiveJudgment
  /**
   * per-checklist-item satisfaction (manual `done` OR auto-detected in output),
   * index-aligned with objective.checklist. Empty when there is no checklist.
   */
  ticked: boolean[]
  /** true when every checklist item is satisfied (or a strong done-signal with no checklist). */
  met: boolean
}

/** The inputs assessObjective folds together (all already in memory elsewhere). */
export interface ObjectiveInput {
  objective: Objective | undefined
  /** the node's current status (for activity / drift detection). */
  status: CanvasNode['status']
  /** recent Echo lines for this node, oldest-first (the searchable ring). */
  echoLines: string[]
  /** the single latest Agent Lens line for this node, if any. */
  lensLine?: string
  /** mission events for THIS node only (used for activity + completions). */
  events: MissionEvent[]
  /** changeset diffstat for this node: files changed + lines added/deleted. */
  diff?: { files: number; adds: number; dels: number }
  /** wall-clock now (injected for determinism in tests). Defaults to Date.now(). */
  now?: number
}

// --- built-in done-signal phrases (English + Spanish) ------------------------
// A line that contains one of these is a strong "objective progressed" signal,
// independent of any checklist. Mirrors insightHarvest.VERDICT_RE in spirit but
// is narrower (we only want clear DONE / GREEN verdicts, not generic chatter).
const DONE_SIGNAL_RE =
  /\b(tests?\s+pass(?:ed|es)?|all\s+(?:\d+\s+)?tests?\s+pass(?:ed)?|build\s+(?:succeed(?:ed)?|pass(?:ed)?|green|ok)|compil(?:es|ed)\s+(?:successfully|ok|clean)|0\s+errors?|no\s+errors?|pushed\b|merged\b|deployed\b|fixed\b|resolved\b|done\b|complete[d]?\b|works\s+now|now\s+works|it\s+works|pruebas?\s+(?:pasan|pasaron)|compila\s+(?:bien|correctamente|ok)|sin\s+errores|cero\s+errores|0\s+errores|subid[oa]\b|push\s+hecho|desplegad[oa]|arreglad[oa]|resuelt[oa]|listo\b|terminad[oa]|funciona(?:\b|\s+ahora))\b/i

/** Collapse whitespace + lowercase for keyword matching. */
function normLine(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Tokenize a checklist label into meaningful keywords for matching. Drops tiny
 * stop-words so "build is green" doesn't tick on a stray "is". Accent-folded so
 * "versión" matches "version".
 */
const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'be', 'to', 'of', 'and', 'or', 'in', 'on', 'at',
  'el', 'la', 'los', 'las', 'un', 'una', 'es', 'son', 'de', 'y', 'o', 'en'
])
function labelKeywords(label: string): string[] {
  return normLine(label)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
}

/**
 * Does any recent output line satisfy this checklist item? A built-in done-signal
 * phrase (e.g. "tests pass") satisfies an item whose label is ABOUT that signal;
 * otherwise we require ALL of the label's keywords to appear in a single line
 * (precision over recall — a partial keyword overlap is not a tick).
 */
function itemSatisfied(label: string, lines: string[]): boolean {
  const kws = labelKeywords(label)
  if (kws.length === 0) return false
  for (const raw of lines) {
    const line = normLine(raw)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
    if (!line) continue
    if (kws.every((kw) => line.includes(kw))) return true
  }
  return false
}

/** Index of the most recent line that contains ANY built-in done-signal, or -1. */
function lastDoneSignalIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (DONE_SIGNAL_RE.test(lines[i])) return i
  }
  return -1
}

/**
 * How many of the last N lines carried NO objective signal at all (no checklist
 * keyword hit, no done-signal). High count while busy = "drifting": lots of
 * output, none of it relevant to the goal.
 */
const DRIFT_WINDOW = 10

/**
 * Assess an objective against the signals CanvasIO already captured. PURE and
 * deterministic. Returns a neutral 'idle' reading when there is no objective or
 * no activity to reason about.
 */
export function assessObjective(input: ObjectiveInput): ObjectiveAssessment {
  const obj = input.objective
  // No objective set → nothing to reason about.
  if (!obj || !obj.text.trim()) {
    return { percent: 0, judgment: 'idle', ticked: [], met: false }
  }

  const checklist = obj.checklist ?? []
  // Combine the recent output the agent itself produced: the Echo ring + the
  // single latest Lens line (the lens line may be newer than the ring's tail).
  const lines = [...input.echoLines]
  if (input.lensLine && input.lensLine.trim()) lines.push(input.lensLine)

  // (1) ticked[]: an item is satisfied if the user manually ticked it OR a
  //     matching signal appears in the agent's own recent output.
  const ticked = checklist.map(
    (it) => it.done || itemSatisfied(it.label, lines)
  )
  const doneCount = ticked.filter(Boolean).length

  // (2) activity: did this node do anything we can measure progress against?
  const completions = input.events.filter((e) => e.kind === 'done').length
  const errored =
    input.status === 'error' || input.events.some((e) => e.kind === 'error')
  const churn = (input.diff?.files ?? 0) > 0 || (input.diff?.adds ?? 0) + (input.diff?.dels ?? 0) > 0
  const hasMissionActivity = input.events.length > 0
  const hasActivity =
    input.status === 'working' || hasMissionActivity || churn || lines.length > 0

  // No objective signal and no activity at all → idle (don't invent progress).
  if (!hasActivity) {
    return { percent: 0, judgment: 'idle', ticked, met: false }
  }

  const doneSignalIdx = lastDoneSignalIndex(lines)
  const hasDoneSignal = doneSignalIdx >= 0

  // (3) "met":
  //   - with a checklist: every item satisfied.
  //   - without a checklist: a strong done-signal AND the node isn't currently
  //     in an error state (a verdict line trumps a stale earlier error).
  const met =
    checklist.length > 0
      ? doneCount === checklist.length
      : hasDoneSignal && input.status !== 'error'

  // (4) percent:
  //   - checklist completion fraction, OR
  //   - a capped ACTIVITY-derived floor (so checklist-free objectives still move):
  //       each completion / a chunk of diff churn nudges it up, capped at 80%
  //       until a real done-signal pushes it to 100%.
  let percent: number
  if (checklist.length > 0) {
    percent = Math.round((doneCount / checklist.length) * 100)
    // A done-signal with all items ticked guarantees 100; otherwise floor the
    // checklist percent with the activity floor so a half-ticked-but-busy agent
    // never reads lower than a purely-idle one.
  } else {
    percent = 0
  }
  if (!met) {
    // Activity floor: completions + churn move the needle, capped below 100.
    let floor = 0
    floor += Math.min(2, completions) * 25 // up to 50 from completions
    if (churn) floor += 20
    if (hasDoneSignal) floor += 25
    if (input.status === 'working') floor += 10
    floor = Math.min(80, floor)
    percent = Math.max(percent, floor)
  }
  if (met) percent = 100
  percent = Math.max(0, Math.min(100, percent))

  // (5) judgment:
  //   - 'met'      → objective satisfied.
  //   - 'drifting' → busy (working / churn / mission activity) but the recent
  //                  output window shows NO objective signal (no checklist hit,
  //                  no done-signal) for a sustained stretch.
  //   - 'on-track' → there is at least some recent objective signal, or it's
  //                  simply active without enough evidence to call drift.
  //   - 'idle'     → handled above.
  let judgment: ObjectiveJudgment
  if (met) {
    judgment = 'met'
  } else {
    // Recent output relevance: among the last DRIFT_WINDOW lines, was there ANY
    // objective signal (a checklist keyword hit OR a done-signal phrase)?
    const recent = lines.slice(-DRIFT_WINDOW)
    let recentSignal = hasDoneSignal && doneSignalIdx >= lines.length - DRIFT_WINDOW
    if (!recentSignal && checklist.length > 0) {
      recentSignal = checklist.some((it) => itemSatisfied(it.label, recent))
    }
    const busy = input.status === 'working' || churn || hasMissionActivity
    // Drift only when genuinely busy with a meaningful output window but zero
    // recent objective signal. Require enough lines so a just-started agent that
    // hasn't printed much isn't prematurely flagged.
    if (busy && !recentSignal && recent.length >= 4 && doneCount === 0 && !errored) {
      judgment = 'drifting'
    } else {
      judgment = 'on-track'
    }
  }

  return { percent, judgment, ticked, met }
}

/** Localized label for a judgment chip. */
export function judgmentLabel(j: ObjectiveJudgment): string {
  switch (j) {
    case 'met':
      return t('objective.judgment_met')
    case 'drifting':
      return t('objective.judgment_drifting')
    case 'on-track':
      return t('objective.judgment_on_track')
    case 'idle':
    default:
      return t('objective.judgment_idle')
  }
}

/** Accent color for a judgment chip — reuses the calm/amber/green convention
 *  CollisionWatch / TriageChip use. */
export function judgmentColor(j: ObjectiveJudgment): string {
  switch (j) {
    case 'met':
      return '#48d597' // green
    case 'drifting':
      return '#f2c84b' // amber
    case 'on-track':
      return '#7aa2ff' // calm blue
    case 'idle':
    default:
      return '#5b6887' // muted
  }
}

/**
 * Seed an objective TEXT from a free-form prompt (the node's pendingPrompt or a
 * Crew Recipe role-prompt). Truncated to a single readable line. Pure helper so
 * the auto-seed logic in canvas.addNode / runRecipe stays trivial and testable.
 */
export function objectiveTextFromPrompt(prompt: string, max = 90): string {
  const oneLine = (prompt || '').replace(/\s+/g, ' ').trim()
  if (!oneLine) return ''
  // Prefer the first sentence if it's short enough; else hard-truncate.
  const firstSentence = oneLine.split(/(?<=[.!?¡¿])\s/)[0] ?? oneLine
  const base = firstSentence.length <= max ? firstSentence : oneLine
  return base.length > max ? base.slice(0, max - 1).trimEnd() + '…' : base
}
