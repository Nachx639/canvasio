// awayAlerts.ts (PURE lib)
//
// Away Alerts — the pure copy-builder for native OS notifications. CanvasIO has
// rich IN-WINDOW attention surfaces (Mission Pulse, Stall Watch, status dots,
// toasts) but ZERO native OS integration: fire off three agents, alt-tab to your
// editor, and you have no idea when one finishes, errors, or goes `waiting` on
// your input. Away Alerts closes that loop with a debounced native Notification +
// dock badge, but the DECISION of whether (and what) to notify lives here, in a
// pure, import-free function so it is trivially unit-testable.
//
// shouldNotify(event, opts) maps ONE human-relevant Mission Pulse transition to a
// { title, body } notification payload, or null when the type is disabled / the
// transition isn't human-relevant. Deterministic, never throws, imports NOTHING
// but the MissionKind type — mirroring lensExcerpt.ts / tripwireMatch.ts.
//
// Spanish copy matches the narration.ts tone (terse, second-person, no emojis in
// the body — the OS supplies its own chrome).

import type { MissionKind } from '../store/mission'
import { t as t2 } from '../store/i18n'

/** The three Mission Pulse transitions Away Alerts can surface. */
export type AlertKind = 'done' | 'error' | 'waiting'

/** The minimal event shape shouldNotify needs (a Mission Pulse transition). */
export interface AwayEvent {
  /** the Mission Pulse event kind (only done/error/waiting are human-relevant). */
  kind: MissionKind
  /** the agent / node title at event time (denormalized, like MissionEvent.title). */
  title?: string
}

/** Per-event-type enablement — mirrors the persisted awayAlerts store flags. */
export interface AwayOpts {
  notifyDone: boolean
  notifyWaiting: boolean
  notifyError: boolean
}

/** A ready-to-fire native notification payload (title + body, OS adds chrome). */
export interface AwayNotice {
  title: string
  body: string
}

/** Map a MissionKind to an AlertKind, or null when it isn't a human-relevant one. */
export function alertKindOf(kind: MissionKind): AlertKind | null {
  return kind === 'done' || kind === 'error' || kind === 'waiting' ? kind : null
}

/** Is this enabled-type allowed by the given options? Pure. */
function isEnabled(kind: AlertKind, opts: AwayOpts): boolean {
  if (kind === 'done') return opts.notifyDone
  if (kind === 'error') return opts.notifyError
  return opts.notifyWaiting
}

/** Trim + cap a title so a runaway node title can't bloat the OS notification. */
function cleanName(title: string | undefined): string {
  const t = (title ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return t2('awayAlerts.an_agent')
  return t.length > 48 ? t.slice(0, 47) + '…' : t
}

/**
 * Given a Mission Pulse transition + the enabled-type set, return the native
 * notification payload to fire, or null when nothing should be surfaced (the
 * transition isn't human-relevant, or its type is disabled). Pure + deterministic.
 *
 * The CALLER is responsible for the away-gating (window unfocused/hidden) and the
 * master enable toggle + debounce/coalesce; this only owns the per-type decision
 * and the Spanish copy.
 */
export function shouldNotify(event: AwayEvent, opts: AwayOpts): AwayNotice | null {
  const kind = alertKindOf(event.kind)
  if (!kind) return null
  if (!isEnabled(kind, opts)) return null
  const name = cleanName(event.title)
  if (kind === 'waiting') {
    return { title: t2('awayAlerts.waiting_title', { name }), body: t2('awayAlerts.waiting_body') }
  }
  if (kind === 'error') {
    return { title: t2('awayAlerts.error_title', { name }), body: t2('awayAlerts.error_body') }
  }
  // done
  return { title: t2('awayAlerts.done_title', { name }), body: t2('awayAlerts.done_body') }
}
