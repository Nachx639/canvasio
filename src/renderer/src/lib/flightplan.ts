// flightplan.ts
//
// Flightplan — the PURE pre-flight conflict classifier. It is the first
// FORWARD-LOOKING cross-agent surface: every other relationship surface reasons
// about damage ALREADY done — CollisionWatch fires only after two agents have
// both saved edits to the same file, consensus surfaces a contradiction only
// after both agents pinned conflicting values, taskforces flags redundant effort
// only after both have already output overlapping subjects. Flightplan reasons at
// the one moment prevention is free: the instant you hand a freshly-spawned (or
// about-to-spawn-via-recipe) agent a task, BEFORE it touches anything.
//
// Given the new node's task text, it extracts the file paths / subject keys the
// task IMPLIES it will touch (a tiny deterministic path/glob scanner + the SAME
// consensus.subjectKey vocabulary every other surface shares), then
// cross-references those targets against every LIVE agent's actual Changeset
// dirty-file set and Brief Board subjects, and returns a ranked list of predicted
// overlaps so the operator can "stage behind" the incumbent (or spawn anyway)
// with a single key.
//
// PURITY CONTRACT (mirrors consensus.ts / taskforces.ts / conductor.ts):
//   - imports ONLY a function (subjectKey) + types; no zustand store, no React,
//     no IPC, no DOM,
//   - never mutates its inputs, fully deterministic, trivially unit-testable,
//   - precision over recall: when a task has no extractable path AND no subject
//     token, it implies NOTHING, so we emit NOTHING. We NEVER invent a conflict,
//     never flag the spawning node against itself, and cap the output.
//
// The derived readout is in-memory-only, like every other intelligence surface —
// nothing here is stored or serialized.

import { subjectKey } from './consensus'

/** The file paths + implied subjects a task is predicted to touch. */
export interface FlightTargets {
  /** explicit path/glob/dir tokens pulled from the task text, normalized + deduped. */
  paths: string[]
  /** implied subject keys (consensus vocabulary: "auth", "api base", …), deduped. */
  subjects: string[]
}

/** A live (incumbent) agent the new task might overlap with. Structurally typed so
 *  this lib imports NO store — the store glue assembles these from useCanvas /
 *  useChangeset / useBoard. */
export interface Incumbent {
  nodeId: string
  /** display title for the chip ("Atlas"). */
  title: string
  /** repo-relative dirty file paths from the incumbent's live Changeset. */
  dirtyPaths: string[]
  /** subject keys the incumbent's Brief Board facts assert (consensus vocabulary). */
  subjects: string[]
}

/** The strength of a predicted overlap. 'path' (a concrete file/dir collision) is
 *  the strongest, always ranked above the weaker semantic 'subject' overlap. */
export type ConflictKind = 'path' | 'subject'

/** One predicted overlap between the new task and a single live incumbent. */
export interface FlightConflict {
  /** the incumbent node the new task overlaps with. */
  nodeId: string
  /** incumbent display title (for the chip label). */
  title: string
  /** strongest overlap kind for this incumbent (path beats subject). */
  kind: ConflictKind
  /**
   * the concrete shared token: a basename/dir for a path overlap, or the subject
   * key for a subject overlap. Drives the "· src/auth/" / "· auth" chip suffix.
   */
  detail: string
}

/** Hard cap on emitted conflicts so a pathological scene can't flood the chip. */
const MAX_CONFLICTS = 6

/** Collapse internal whitespace and trim. */
function squash(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim()
}

// A path-shaped token in free task text. We require a slash OR a dotted file
// extension so plain prose words ("the auth flow") never read as a path. Examples
// matched: src/auth/session.ts, *.ts, src/auth/, lib/foo.test.ts, ./a/b.
// We keep the leading "./" off and never match a bare word.
const PATH_TOKEN_RE = /(?:\.\/)?(?:[\w@.\-*]+\/)+[\w@.\-*]*|(?:\*\.[\w]+)|\b[\w@\-]+\.[\w]{1,8}\b/g

/** Last path segment of a repo-relative path (drops trailing slash first). */
export function basename(p: string): string {
  let s = p
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  const i = s.lastIndexOf('/')
  return i >= 0 ? s.slice(i + 1) : s
}

/** Directory portion of a path (everything up to and including the last slash),
 *  or '' when the path has no slash (a bare filename). */
function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(0, i + 1) : ''
}

/** Normalize a raw path token: strip a leading "./", collapse repeated slashes,
 *  lowercase (paths compared case-insensitively for robustness across mentions). */
function normPath(raw: string): string {
  let p = raw.trim()
  if (p.startsWith('./')) p = p.slice(2)
  p = p.replace(/\/{2,}/g, '/')
  return p.toLowerCase()
}

/**
 * Extract the paths + implied subjects a task text predicts it will touch. PURE +
 * deterministic. Precision-first: a token must look like a path (slash or dotted
 * extension) to count as a path; subjects fold through the shared consensus
 * vocabulary. Returns deduped, order-stable lists. Never throws on odd input.
 */
export function extractTargets(taskText: string): FlightTargets {
  const t = squash(taskText)
  if (!t) return { paths: [], subjects: [] }

  // --- paths / globs / dirs ---
  const seenP = new Set<string>()
  const paths: string[] = []
  const matches = t.match(PATH_TOKEN_RE) || []
  for (const raw of matches) {
    const p = normPath(raw)
    // Reject degenerate tokens: a lone "*" or empty, or a dotted token that is
    // really a sentence end like a trailing "..." (normPath keeps it short).
    if (!p || p === '*' || p === '.' || p === '..') continue
    // Require at least one path-meaningful char beyond a bare dot run.
    if (!/[\w*]/.test(p)) continue
    if (seenP.has(p)) continue
    seenP.add(p)
    paths.push(p)
  }

  // --- implied subjects (whole-task fold + per-path-segment fold) ---
  // We fold the WHOLE task through subjectKey for the primary subject, and ALSO
  // fold each path so "src/auth/session.ts" implies the "auth" subject even when
  // the prose itself is terse. Deterministic dedup, declaration-order stable.
  const seenS = new Set<string>()
  const subjects: string[] = []
  const addSubject = (key: string | null): void => {
    if (!key || seenS.has(key)) return
    seenS.add(key)
    subjects.push(key)
  }
  addSubject(subjectKey(t))
  for (const p of paths) {
    // Replace slashes/dots with spaces so subjectKey's word-bounded cues can see
    // the segments ("src/auth/session.ts" -> "src auth session ts").
    addSubject(subjectKey(p.replace(/[/.\-*]+/g, ' ')))
  }

  return { paths, subjects }
}

/**
 * Decide whether a target path overlaps an incumbent dirty path. Two paths overlap
 * when they share a basename (likely the same file under different relative roots)
 * OR one's directory is a prefix of the other's (they live in the same area). Pure.
 * Returns the human "detail" token to show, or '' when there is no path overlap.
 */
function pathOverlap(targetPaths: string[], dirtyPaths: string[]): string {
  for (const tp of targetPaths) {
    const tb = basename(tp)
    const td = dirOf(tp)
    for (const dp of dirtyPaths) {
      const d = normPath(dp)
      const db = basename(d)
      const dd = dirOf(d)
      // Strongest: same basename (and the target carried a real filename, not a
      // bare dir or glob) — prefer showing the shared dir when both have one.
      if (tb && db && tb === db && !tb.includes('*')) {
        return td || dd || tb
      }
      // Glob match: "*.ts" target vs a dirty file with that extension.
      if (tb.startsWith('*.') && db.endsWith(tb.slice(1))) {
        return dd || db
      }
      // Directory containment either way (same area of the tree).
      if (td && dd && (dd.startsWith(td) || td.startsWith(dd))) {
        return td.length <= dd.length ? td : dd
      }
    }
  }
  return ''
}

/** Whether any target subject equals an incumbent subject. Returns the shared
 *  subject key, or '' when none. Pure. */
function subjectOverlap(targetSubjects: string[], incumbentSubjects: string[]): string {
  const have = new Set(incumbentSubjects)
  for (const s of targetSubjects) if (have.has(s)) return s
  return ''
}

/**
 * Predict the cross-agent conflicts a freshly-handed task would create. PURE +
 * deterministic.
 *
 * Algorithm (precision-first):
 *   1. If the task implies NOTHING (no paths AND no subjects), emit nothing.
 *   2. For each incumbent (never the spawning node — callers pass live agents
 *      OTHER than the new one; we also defensively skip a matching id when given):
 *        a) a PATH overlap (shared basename / dir containment / glob) — strongest;
 *        b) else a SUBJECT overlap (a shared consensus subject) — weaker.
 *      At most ONE conflict per incumbent, keeping the STRONGEST.
 *   3. Rank path-overlaps above subject-overlaps, then by title for stability. Cap.
 *
 * `selfNodeId` (optional) is the spawning node's id; any incumbent with that id is
 * skipped so we never flag the new agent against itself.
 */
export function predictConflicts(
  targets: FlightTargets,
  incumbents: Incumbent[],
  selfNodeId?: string
): FlightConflict[] {
  if (!targets) return []
  const hasPaths = targets.paths.length > 0
  const hasSubjects = targets.subjects.length > 0
  if (!hasPaths && !hasSubjects) return [] // ambiguous task implies nothing
  if (!incumbents || incumbents.length === 0) return []

  const out: FlightConflict[] = []
  const seen = new Set<string>()
  for (const inc of incumbents) {
    if (!inc || !inc.nodeId) continue
    if (selfNodeId && inc.nodeId === selfNodeId) continue // never self-flag
    if (seen.has(inc.nodeId)) continue // one hit per incumbent

    let kind: ConflictKind | null = null
    let detail = ''

    if (hasPaths) {
      const pd = pathOverlap(targets.paths, inc.dirtyPaths || [])
      if (pd) {
        kind = 'path'
        detail = pd
      }
    }
    if (!kind && hasSubjects) {
      const sd = subjectOverlap(targets.subjects, inc.subjects || [])
      if (sd) {
        kind = 'subject'
        detail = sd
      }
    }

    if (kind) {
      seen.add(inc.nodeId)
      out.push({ nodeId: inc.nodeId, title: inc.title || 'Agente', kind, detail })
    }
  }

  // Rank: path overlaps (strongest, actionable) first, then by title for a stable
  // deterministic order so the memo guard in the store sees identical ordering.
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'path' ? -1 : 1
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0
  })
  return out.slice(0, MAX_CONFLICTS)
}
