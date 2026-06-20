// catchup.ts
//
// Catch-Up — the per-agent "what happened since you last looked" UNREAD DELTA
// (PURE synthesis layer).
//
// When you run several agents in parallel you can only watch one at a time. Every
// other CanvasIO surface is present-tense ("who's blocked NOW", "what's the last
// line NOW") or whole-mission ("is the mission done"). NONE answer the question
// you actually ask every time you tab back to an agent: "what did THIS agent do
// while I wasn't looking at it?".
//
// CanvasIO already stamps a per-node read-marker every time you jump to / select
// a node (the `visits[id].lastTs` written at the single centerOnNode chokepoint —
// it is literally "the moment you last looked at this node"). Catch-Up treats
// that timestamp as a read-marker and synthesizes a per-agent unread delta from
// the four timestamped substrates already captured for free:
//   - Mission Pulse events  (status transitions: done / error / waiting)
//   - Command Trail entries (commands run, with risk tags)
//   - Echo lines            (meaningful output)
//   - Changeset             (files touched)
//
// This module is the PURE, side-effect-free synthesis layer mirroring
// chronoscope.ts / timefold.ts / backlog.ts discipline:
//   - imports ONLY types (no zustand stores, no React, no IPC, no main process),
//   - never mutates its inputs,
//   - is fully deterministic given the same inputs (unit-testable; `sinceTs` is an
//     explicit argument, never Date.now()).

import type { MissionEvent } from '../store/mission'
import type { EchoLine } from '../store/echo'
import type { TrailEntry } from '../store/commandTrail'
import type { NodeChangeset } from '../store/changeset'
import { t } from '../store/i18n'

/** The kind of milestone surfaced in a catch-up timeline row. */
export type CatchupKind = 'status' | 'command' | 'output' | 'files'

/** One synthesized "since you left" timeline item for a single agent. */
export interface CatchupItem {
  /** wall-clock ms when the underlying substrate captured this. */
  ts: number
  kind: CatchupKind
  /** short human label (e.g. "terminó", "rm -rf build", "3 archivos tocados"). */
  label: string
  /** present for status items: the stable MissionEvent kind, so consumers can
   *  color/branch on it WITHOUT string-matching the (localized) label. */
  statusKind?: MissionEvent['kind']
  /** present for command items; mirrors the Command Trail risk class. */
  risk?: TrailEntry['risk']
  /** present for file items: the repo-relative path (Enter opens its diff). */
  path?: string
  /** whether this milestone counts toward the unread tally (vs. context noise). */
  meaningful: boolean
}

/** The full unread delta for one agent/node since its read-marker. */
export interface CatchupDelta {
  nodeId: string
  /** count of MEANINGFUL milestones (the pip number). 0 => caught up. */
  unreadCount: number
  /** every synthesized milestone, newest-first (meaningful + a little context). */
  milestones: CatchupItem[]
  /** ts of the newest milestone (0 when none) — used to rank rows in the panel. */
  newestTs: number
}

/** The four live substrates Catch-Up joins for a single node. All read-only. */
export interface CatchupSubstrates {
  /** the WHOLE mission timeline (filtered to this node here); ascending ts. */
  events: MissionEvent[]
  /** this node's Echo ring (ascending ts), or undefined. */
  echoLines?: EchoLine[]
  /** this node's Command Trail ring (ascending ts), or undefined. */
  trailEntries?: TrailEntry[]
  /** this node's latest changeset summary, or undefined. */
  changeset?: NodeChangeset
}

/** A status transition only counts as a milestone when it reaches a state that
 *  actually asks for attention. work-start / spawn / relay / close are context. */
function meaningfulStatus(kind: MissionEvent['kind']): boolean {
  return kind === 'done' || kind === 'error' || kind === 'waiting'
}

/** Human label for a status transition (Spanish, matching the rest of the UI). */
function statusLabel(kind: MissionEvent['kind']): string {
  switch (kind) {
    case 'done':
      return t('catchup.status_done')
    case 'error':
      return t('catchup.status_error')
    case 'waiting':
      return t('catchup.status_waiting')
    case 'work-start':
      return t('catchup.status_work_start')
    case 'relay':
      return t('catchup.status_relay')
    case 'spawn':
      return t('catchup.status_spawn')
    case 'close':
      return t('catchup.status_close')
    default:
      return String(kind)
  }
}

/** A command is a meaningful milestone when it carries real risk (destructive /
 *  network / vcs); benign/buildtest commands are still surfaced as context but do
 *  NOT inflate the unread count, so a chatty agent shows a signal, not noise. */
function meaningfulRisk(risk: TrailEntry['risk']): boolean {
  return risk === 'destructive' || risk === 'network' || risk === 'vcs'
}

/** Cap on how many OUTPUT lines a single delta surfaces, so a verbose agent
 *  coalesces into one count rather than flooding the timeline. */
const OUTPUT_CAP = 3
/** Cap on the total milestones returned per delta (newest-first). */
const MILESTONE_CAP = 12

/**
 * Synthesize the unread delta for ONE node since its read-marker `sinceTs`.
 *
 * Each substrate is filtered to ts > sinceTs (strictly newer than the last look),
 * mapped to CatchupItems, then merged newest-first. unreadCount counts only
 * MEANINGFUL milestones:
 *   - a status transition that reached done / error / waiting,
 *   - a command tagged destructive / network / vcs,
 *   - >= 1 file in the changeset captured after the marker,
 *   - up to OUTPUT_CAP meaningful output lines (coalesced/capped so a chatty
 *     agent shows a count, not noise).
 *
 * Pure + deterministic: `sinceTs` is explicit; inputs are never mutated. A
 * never-looked node (sinceTs <= 0) treats every captured fact as unread.
 */
export function buildCatchup(
  nodeId: string,
  sinceTs: number,
  subs: CatchupSubstrates
): CatchupDelta {
  const since = Number.isFinite(sinceTs) ? sinceTs : 0
  const items: CatchupItem[] = []

  // ── Status transitions (Mission Pulse) ─────────────────────────────────────
  for (const ev of subs.events) {
    if (ev.nodeId !== nodeId) continue
    if (ev.ts <= since) continue
    const meaningful = meaningfulStatus(ev.kind)
    // Only surface the meaningful transitions as timeline items; quiet lifecycle
    // kinds (spawn/close/work-start/relay) carry no "did something" signal here.
    if (!meaningful) continue
    items.push({
      ts: ev.ts,
      kind: 'status',
      label: statusLabel(ev.kind),
      statusKind: ev.kind,
      meaningful: true
    })
  }

  // ── Commands run (Command Trail) ───────────────────────────────────────────
  for (const e of subs.trailEntries ?? []) {
    if (e.ts <= since) continue
    items.push({
      ts: e.ts,
      kind: 'command',
      label: e.cmd,
      risk: e.risk,
      meaningful: meaningfulRisk(e.risk)
    })
  }

  // ── Files touched (Changeset) ──────────────────────────────────────────────
  // The changeset is a single latest snapshot with one capture ts. If it was
  // captured after the marker AND has files, surface each file as a context item
  // and add ONE meaningful "N archivos" milestone (so touching files counts once,
  // not once-per-file).
  const cs = subs.changeset
  if (cs && cs.ts > since && cs.files.length > 0) {
    const n = cs.files.length
    items.push({
      ts: cs.ts,
      kind: 'files',
      label: n === 1 ? t('catchup.files_touched_one', { n }) : t('catchup.files_touched_other', { n }),
      meaningful: true
    })
    // Individual files as openable context rows (not counted again).
    for (const f of cs.files) {
      items.push({
        ts: cs.ts,
        kind: 'files',
        label: f.path,
        path: f.path,
        meaningful: false
      })
    }
  }

  // ── Output lines (Echo) ────────────────────────────────────────────────────
  // Newest-first, capped: only the most recent OUTPUT_CAP unread lines count as
  // meaningful so a verbose agent coalesces into a small signal. Older unread
  // lines beyond the cap are dropped entirely (they'd be pure noise in a digest).
  const unreadEcho = (subs.echoLines ?? []).filter((l) => l.ts > since)
  // newest-first
  const echoNewest = [...unreadEcho].sort((a, b) => b.ts - a.ts).slice(0, OUTPUT_CAP)
  for (const l of echoNewest) {
    items.push({
      ts: l.ts,
      kind: 'output',
      label: l.text,
      meaningful: true
    })
  }

  // Merge newest-first; cap the timeline length.
  items.sort((a, b) => b.ts - a.ts)
  const milestones = items.slice(0, MILESTONE_CAP)

  // Count meaningful milestones across the FULL (pre-cap) item set so the pip
  // reflects everything that mattered, even if the visible timeline is truncated.
  let unreadCount = 0
  for (const it of items) if (it.meaningful) unreadCount++

  const newestTs = items.length ? items[0].ts : 0
  return { nodeId, unreadCount, milestones, newestTs }
}
