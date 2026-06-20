// scorecard.ts (store glue)
//
// Agent Scorecard — the PERSISTED long-term performance memory. The second
// persisted intelligence surface in CanvasIO (after Recall), and the FIRST that
// learns about OUTCOMES rather than facts. It folds the very done / error / waiting
// transitions Mission Pulse already records into a per-AgentKind running track
// record, accumulated across EVERY mission, and persists it to its OWN
// localStorage key 'canvasio:scorecard' — using the EXACT same lazy-load / synchronous-
// save / defensive pattern as recall.ts.
//
// PERSISTENCE CONTRACT — the same inversion Recall uses:
//   * persists to its OWN key 'canvasio:scorecard' (load lazily at store init, save
//     synchronously on each mutation, all inside try/catch — quota/blocked/malformed
//     storage degrades silently to defaults; recordOutcome must NEVER throw into a
//     caller, since it runs beside the live terminal status chokepoint),
//   * NEVER added to canvasio:layout / App.tsx canvas serialization, NEVER sent over
//     IPC, and deliberately NOT registered into resetRelayAndMission(): like Recall,
//     New Canvas wipes the live board but the Scorecard PERSISTS. clearAll() is the
//     only way to forget a track record.
//   * imports NOTHING from canvas.ts that would create a cycle (only the AgentKind
//     type); the ranking lives in the PURE lib/scorecard.ts.
//
// The running median is computed from a bounded per-kind ring of the most recent
// completion durations — O(MAX_RING) per record, no unbounded growth.

import { create } from 'zustand'
import type { AgentKind } from './canvas'
import {
  computeScorecard,
  recommendBetterKind,
  AGENT_KINDS,
  emptyStat,
  type AgentStat,
  type Scorecard,
  type ScoreRow
} from '../lib/scorecard'
import {
  classifyTask,
  bestForBucket as pureBestForBucket,
  emptySkillTable,
  SKILL_BUCKETS,
  type SkillBucket,
  type SkillTable
} from '../lib/skillMemory'

/** The localStorage key. Its OWN key, untouched by canvasio:layout serialization. */
const STORAGE_KEY = 'canvasio:scorecard'
/** Bounded ring of recent completion durations per kind, for an O(1)-amortized
 *  median without unbounded growth. */
const MAX_RING = 50

/** The persisted per-kind aggregate: the pure AgentStat plus the duration ring the
 *  median is derived from. The ring is an implementation detail of the store; the
 *  pure ranker only ever sees the derived AgentStat. */
interface KindRecord extends AgentStat {
  /** recent completion durations (ms), most-recent appended, capped to MAX_RING. */
  recentDoneMs: number[]
}

type ScorecardData = Record<AgentKind, KindRecord>

/** A clean, all-zero record set for every persona. */
function emptyData(): ScorecardData {
  const out = {} as ScorecardData
  for (const k of AGENT_KINDS) out[k] = { ...emptyStat(k), recentDoneMs: [] }
  return out
}

/** Median of a numeric list (0 for empty). Pure. */
function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

/** Coerce an unknown to a finite non-negative integer (defensive load). */
function nat(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
}

/**
 * The full persisted payload: the existing per-kind aggregate PLUS the OPTIONAL
 * per-(bucket × persona) skill table. The bySkill table is a pure SUPERSET — a
 * legacy payload (no bySkill) loads to an empty table, so the global per-kind badge
 * keeps working and there is no migration risk.
 */
interface Persisted {
  data: ScorecardData
  bySkill: SkillTable
}

/** Defensively load + sanitize a persisted SkillTable (missing/legacy → empty). */
function loadSkill(obj: Record<string, unknown> | null): SkillTable {
  const table = emptySkillTable()
  if (!obj || typeof obj !== 'object') return table
  for (const b of SKILL_BUCKETS) {
    const row = obj[b]
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    for (const k of AGENT_KINDS) {
      const cell = r[k]
      if (!cell || typeof cell !== 'object') continue
      const c = cell as { done?: unknown; error?: unknown }
      table[b][k] = { done: nat(c.done), error: nat(c.error) }
    }
  }
  return table
}

/** Load the persisted records. Defensive: any malformed/blocked storage → defaults. */
function load(): Persisted {
  const data = emptyData()
  const bySkill = emptySkillTable()
  try {
    if (typeof localStorage === 'undefined') return { data, bySkill }
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { data, bySkill }
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return { data, bySkill }
    const obj = parsed as Record<string, unknown>
    for (const k of AGENT_KINDS) {
      const item = obj[k]
      if (!item || typeof item !== 'object') continue
      const r = item as Partial<KindRecord>
      const ring = Array.isArray(r.recentDoneMs)
        ? r.recentDoneMs.filter((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)
        : []
      const recentDoneMs = ring.length > MAX_RING ? ring.slice(-MAX_RING) : ring
      data[k] = {
        kind: k,
        done: nat(r.done),
        error: nat(r.error),
        stall: nat(r.stall),
        // Recompute the median from the (trusted) ring so a tampered/legacy
        // medianDoneMs can never drift out of sync with its evidence.
        medianDoneMs: median(recentDoneMs),
        recentDoneMs
      }
    }
    // bySkill is OPTIONAL: a legacy payload without it loads to an empty table.
    return { data, bySkill: loadSkill((obj.bySkill as Record<string, unknown>) ?? null) }
  } catch {
    return { data: emptyData(), bySkill: emptySkillTable() }
  }
}

/** Persist synchronously. Defensive: quota/blocked storage is ignored — the
 *  Scorecard must never throw into the terminal status chokepoint it runs beside. */
function save(data: ScorecardData, bySkill: SkillTable): void {
  try {
    if (typeof localStorage === 'undefined') return
    // Persist under the SAME key: per-kind data spread at the top level (so the
    // legacy shape is preserved), plus the bySkill table as a sibling field.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...data, bySkill }))
  } catch {
    /* ignore quota/blocked storage */
  }
}

/** One folded outcome event, mapped 1:1 from a Mission Pulse terminal transition. */
export interface OutcomeEvent {
  /** the persona that produced the outcome (undefined → ignored, e.g. shell-less). */
  kind?: AgentKind
  /** the terminal outcome: a completion, an error, or a stall (waiting-no-resolve). */
  outcome: 'done' | 'error' | 'stall'
  /** ms-to-done for a 'done' outcome (used to fold the median ring). */
  durationMs?: number
  /**
   * OPTIONAL task text (objective / pending prompt) for this outcome. When present,
   * classifyTask(task) selects a skill bucket and the done/error is ALSO folded into
   * the per-(bucket × persona) track record — leaving the global per-kind data an
   * untouched superset. Absent → only the global record is updated (old behavior).
   */
  task?: string
}

interface ScorecardState {
  data: ScorecardData
  /** The OPTIONAL per-(bucket × persona) skill track record (Skill Memory). */
  bySkill: SkillTable
  /**
   * Fold ONE outcome event into the running per-kind aggregate and save
   * synchronously. Called right beside the existing Mission Pulse record() at the
   * terminal done/error transition chokepoint; wrapped by the CALLER in try/catch
   * (and internally defensive) so it can never affect terminal behavior. A missing
   * kind is silently ignored. For a 'done' with a positive durationMs, the duration
   * is pushed onto the bounded ring and the median is recomputed.
   */
  recordOutcome: (e: OutcomeEvent) => void
  /** The ranked readout, computed lazily at call time from the live aggregates. */
  getRanked: () => Scorecard
  /** Convenience: a decisively-better persona for `currentKind`, or null. */
  betterThan: (currentKind: AgentKind) => ScoreRow | null
  /**
   * The decisively-best persona FOR A GIVEN SKILL BUCKET across past missions, or
   * null when that bucket has thin evidence (precision over recall). Read-only,
   * computed at call time — the spawn flow + Recipe picker consume it.
   */
  bestForBucket: (bucket: SkillBucket) => ScoreRow | null
  /** Wipe the entire track record (the only way to forget persisted performance). */
  clearAll: () => void
}

export const useScorecard = create<ScorecardState>((set, get) => {
  // Lazily loaded ONCE at store creation (first import), mirroring recall.ts.
  const initial = load()
  return {
    data: initial.data,
    bySkill: initial.bySkill,

    recordOutcome: ({ kind, outcome, durationMs, task }) => {
      if (!kind || !AGENT_KINDS.includes(kind)) return
      set((s) => {
        const prev = s.data[kind] ?? { ...emptyStat(kind), recentDoneMs: [] }
        let { done, error, stall, recentDoneMs } = prev
        if (outcome === 'error') {
          error += 1
        } else if (outcome === 'stall') {
          stall += 1
        } else {
          done += 1
          if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0) {
            recentDoneMs = [...recentDoneMs, durationMs]
            if (recentDoneMs.length > MAX_RING) recentDoneMs = recentDoneMs.slice(-MAX_RING)
          }
        }
        const next: KindRecord = {
          kind,
          done,
          error,
          stall,
          medianDoneMs: median(recentDoneMs),
          recentDoneMs
        }

        // Skill Memory: when a task description rode along, classify it into a coarse
        // bucket and fold the SAME done/error into the per-(bucket × persona) track
        // record. Stalls (and the catch-all 'other' bucket) are intentionally ignored
        // — they carry no routing signal. The global per-kind data above is untouched.
        let bySkill = s.bySkill
        if (task && (outcome === 'done' || outcome === 'error')) {
          const bucket = classifyTask(task)
          if (bucket !== 'other') {
            const row = s.bySkill[bucket] ?? {}
            const cell = row[kind] ?? { done: 0, error: 0 }
            const nextCell =
              outcome === 'error'
                ? { done: cell.done, error: cell.error + 1 }
                : { done: cell.done + 1, error: cell.error }
            bySkill = {
              ...s.bySkill,
              [bucket]: { ...row, [kind]: nextCell }
            }
          }
        }

        return { data: { ...s.data, [kind]: next }, bySkill }
      })
      save(get().data, get().bySkill)
    },

    getRanked: () => {
      const stats: AgentStat[] = AGENT_KINDS.map((k) => {
        const r = get().data[k] ?? { ...emptyStat(k), recentDoneMs: [] }
        return {
          kind: r.kind,
          done: r.done,
          error: r.error,
          stall: r.stall,
          medianDoneMs: r.medianDoneMs
        }
      })
      return computeScorecard(stats)
    },

    betterThan: (currentKind) => recommendBetterKind(currentKind, get().getRanked()),

    bestForBucket: (bucket) => pureBestForBucket(bucket, get().bySkill),

    clearAll: () => {
      const data = emptyData()
      const bySkill = emptySkillTable()
      set({ data, bySkill })
      save(data, bySkill)
    }
  }
})
