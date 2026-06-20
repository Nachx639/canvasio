// skillMemory.ts
//
// Skill Memory — Task-Type-Aware Persona Routing (the per-skill LEARNING layer).
//
// The Agent Scorecard already learns reliability ONE way: globally per persona
// ("claude is your most reliable agent across all missions"). But real work isn't
// one bucket — codex may nail test-fixing while claude wins at architecture and
// shell wins at build/deploy. Skill Memory is the missing dimension: a tiny PURE
// keyword classifier sorts each finished task into a coarse skill bucket, and the
// persisted scorecard folds the outcome into a per-(bucket × persona) track record.
// Then the spawn flow and Crew Recipe picker can answer the question that actually
// matters — "for THIS kind of task, who's most reliable?".
//
// PURITY CONTRACT (mirrors lib/scorecard.ts / conductor.ts / consensus.ts):
//   - imports ONLY the AgentKind type (no zustand store, no React, no IPC),
//   - never mutates its inputs,
//   - is fully deterministic given the same inputs (trivially unit-testable),
//   - precision over recall: the per-bucket ranker reuses the SAME score math +
//     MIN_SAMPLES / DECISIVE_RATE_GAP guardrails as the global scorecard, so a
//     bucket with thin evidence NEVER invents a winner.
//
// The store/scorecard.ts glue owns persistence + event folding; this module is the
// pure classifier + per-bucket ranker that the spawn flow + Recipe picker consume.

import type { AgentKind } from '../store/canvas'
import {
  computeScorecard,
  reliabilityFor,
  AGENT_KINDS,
  MIN_SAMPLES,
  emptyStat,
  type AgentStat,
  type Scorecard,
  type ScoreRow
} from './scorecard'

/**
 * The coarse skill buckets a finished task can be sorted into. Precision-first:
 * 'other' is the explicit catch-all when nothing decisive matches, so we never
 * mislabel a task into a real bucket on a weak signal.
 */
export const SKILL_BUCKETS = [
  'tests',
  'design',
  'refactor',
  'docs',
  'build',
  'review',
  'other'
] as const

export type SkillBucket = (typeof SKILL_BUCKETS)[number]

/** The per-(bucket × persona) raw counts the store folds outcomes into. */
export type SkillTable = Record<SkillBucket, Record<AgentKind, { done: number; error: number }>>

/**
 * Keyword vocabulary per bucket (EN + ES), checked in array order so the FIRST
 * matching bucket wins — buckets are ordered most-specific-first so e.g. a task
 * mentioning both "test" and "refactor" classifies as 'tests'. Each entry is a
 * lowercase substring matched against the lowercased task text. Precision over
 * recall: terms are deliberately discriminative, not greedy.
 */
const BUCKET_KEYWORDS: ReadonlyArray<readonly [Exclude<SkillBucket, 'other'>, readonly string[]]> = [
  [
    'tests',
    [
      'test',
      'spec',
      'jest',
      'vitest',
      'unit ',
      'e2e',
      'coverage',
      'falla',
      'fallo',
      'prueba',
      'pruebas'
    ]
  ],
  [
    'design',
    [
      'design',
      'architect',
      'architecture',
      'schema',
      'api contract',
      'interface',
      'diseñ',
      'arquitect',
      'esquema',
      'planifica',
      'plan técnico'
    ]
  ],
  [
    'refactor',
    [
      'refactor',
      'cleanup',
      'clean up',
      'rename',
      'restructure',
      'simplif',
      'tidy',
      'reescrib',
      'renombra',
      'limpia',
      'reorganiza'
    ]
  ],
  [
    'docs',
    [
      'doc',
      'docs',
      'readme',
      'comment',
      'changelog',
      'tutorial',
      'document',
      'comenta',
      'documenta',
      'guía'
    ]
  ],
  [
    'build',
    [
      'build',
      'deploy',
      'ci',
      'release',
      'pipeline',
      'bundle',
      'package',
      'publish',
      'compila',
      'despliega',
      'lanzamiento',
      'empaqueta'
    ]
  ],
  [
    'review',
    ['review', 'audit', 'inspect', 'critique', 'revisa', 'audita', 'inspecciona', 'crítica']
  ]
]

/**
 * Sort a finished task's text into a coarse skill bucket. PURE + deterministic.
 *
 * Precision over recall: returns 'other' whenever nothing decisive matches (empty
 * or whitespace text → 'other'). The first bucket (in BUCKET_KEYWORDS order) with a
 * keyword hit wins, so the ordering encodes priority among overlapping signals.
 */
export function classifyTask(text: string | undefined | null): SkillBucket {
  if (!text || typeof text !== 'string') return 'other'
  const hay = text.toLowerCase()
  if (!hay.trim()) return 'other'
  for (const [bucket, words] of BUCKET_KEYWORDS) {
    for (const w of words) {
      if (hay.includes(w)) return bucket
    }
  }
  return 'other'
}

/** A clean, all-zero skill table for every bucket × persona. */
export function emptySkillTable(): SkillTable {
  const out = {} as SkillTable
  for (const b of SKILL_BUCKETS) {
    const row = {} as Record<AgentKind, { done: number; error: number }>
    for (const k of AGENT_KINDS) row[k] = { done: 0, error: 0 }
    out[b] = row
  }
  return out
}

/**
 * Project ONE bucket's raw counts into AgentStat shape so the EXISTING scorecard
 * math (computeScorecard / reliabilityFor) can rank within that bucket. The
 * per-skill track record has no timing ring, so medianDoneMs is 0 (no speed nudge)
 * and stalls are always 0 — reliability here is purely done-vs-error.
 */
function statsForBucket(bucket: SkillBucket, table: SkillTable): AgentStat[] {
  const row = table[bucket]
  return AGENT_KINDS.map((kind) => {
    const cell = row?.[kind] ?? { done: 0, error: 0 }
    return { ...emptyStat(kind), kind, done: cell.done, error: cell.error }
  })
}

/**
 * Rank the personas WITHIN a single skill bucket, reusing the global scorecard's
 * leverage-weighted score math + tier ordering. PURE + deterministic.
 */
export function rankForBucket(bucket: SkillBucket, table: SkillTable): Scorecard {
  return computeScorecard(statsForBucket(bucket, table))
}

/**
 * The decisively-best persona FOR A GIVEN BUCKET, or null when the evidence is thin.
 *
 * PRECISION OVER RECALL — identical guardrails to the global scorecard: we speak
 * ONLY when the top-ranked persona for this bucket has real evidence
 * (>= MIN_SAMPLES). Otherwise null, and the caller degrades to the global badge.
 */
export function bestForBucket(bucket: SkillBucket, table: SkillTable): ScoreRow | null {
  if (bucket === 'other') return null
  const sc = rankForBucket(bucket, table)
  const top = sc.ranked[0]
  if (!top || top.insufficient) return null
  // Defensive: never surface a "winner" with zero successes.
  const row = reliabilityFor(top.kind, sc)
  return row.samples >= MIN_SAMPLES && row.successRate > 0 ? top : null
}
