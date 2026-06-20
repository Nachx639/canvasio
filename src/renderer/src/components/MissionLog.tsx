import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useCanvas, type AgentKind, type CanvasNode } from '../store/canvas'
import { useMission, type MissionEvent, type MissionKind } from '../store/mission'
import { useReplay } from '../store/replay'
import { computeBrief, briefHeadline, briefLines } from '../lib/missionBrief'
import { narrateBrief } from '../lib/narration'
import { useEcho } from '../store/echo'
import { useLens } from '../store/lens'
import { useChangeset } from '../store/changeset'
import { assessObjective, judgmentLabel, judgmentColor } from '../lib/objective'
import { useDraggablePanel } from '../lib/useDraggablePanel'
import { useT, t } from '../store/i18n'
import { PanelGrip } from './PanelGrip'

// Agent accent colors — kept in sync with NodeView.AGENT_COLOR so an event's
// dot/name matches the node frame the user sees on the canvas.
export const AGENT_COLOR: Record<AgentKind, string> = {
  claude: '#d97757',
  codex: '#10a37f',
  cursor: '#7aa2ff',
  shell: '#9aa7c7'
}

// Per-kind presentation: a glyph, an accent color and a short Spanish verb.
export const KIND_META: Record<MissionKind, { icon: string; color: string; label: string }> = {
  spawn: { icon: '✦', color: '#7c97e0', label: 'abierto' },
  'work-start': { icon: '⟳', color: '#f2c84b', label: 'trabajando' },
  done: { icon: '✓', color: '#48d597', label: 'hecho' },
  error: { icon: '✕', color: '#f2564b', label: 'error' },
  waiting: { icon: '?', color: '#5ad1e8', label: 'te necesita' },
  relay: { icon: '→', color: '#c77dff', label: 'relevo' },
  close: { icon: '◻', color: '#6f84ad', label: 'cerrado' }
}

// Stable empty brief reused while the panel is closed, so the O(events)+O(nodes)
// computeBrief fold doesn't run on every mission-event/nodes change at rest.
const EMPTY_BRIEF = computeBrief([], [])

/** Human-friendly duration: "2m14s", "9s", "1h03m". '' for undefined/<1s. */
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

/**
 * Agent Objectives — one-line Spanish spoken standup, e.g.
 * "Atlas 80%, en rumbo; Iris desviado." Pure string fold over the per-agent
 * objective readings; spoken through the existing narration path.
 */
function objectivesStandup(
  rows: { node: CanvasNode; assessment: { percent: number; judgment: import('../lib/objective').ObjectiveJudgment } }[]
): string {
  if (!rows.length) return t('missionLog.no_agent_objective')
  const parts = rows
    .slice(0, 6)
    .map(({ node, assessment }) => `${node.title} ${assessment.percent}%, ${judgmentLabel(assessment.judgment)}`)
  return parts.join('; ') + '.'
}

/** Relative time vs now: "ahora", "hace 12s", "hace 4m", "hace 1h". */
export function relTime(ts: number, now: number): string {
  const sec = Math.max(0, Math.round((now - ts) / 1000))
  if (sec < 3) return t('missionLog.rel_now')
  if (sec < 60) return t('missionLog.rel_seconds', { s: sec })
  const m = Math.floor(sec / 60)
  if (m < 60) return t('missionLog.rel_minutes', { m })
  const h = Math.floor(m / 60)
  return t('missionLog.rel_hours', { h })
}

/** One-line human phrase for an event, e.g. "trabajó 2m14s -> hecho". */
export function phraseFor(e: MissionEvent): string {
  const dur = humanDuration(e.durationMs)
  switch (e.kind) {
    case 'spawn':
      return t('missionLog.phrase_spawn')
    case 'work-start':
      return t('missionLog.phrase_work_start')
    case 'done':
      return dur ? t('missionLog.phrase_done_dur', { dur }) : t('missionLog.phrase_done')
    case 'error':
      return dur ? t('missionLog.phrase_error_dur', { dur }) : t('missionLog.phrase_error')
    case 'waiting':
      return dur
        ? t('missionLog.phrase_waiting_dur', { dur })
        : t('missionLog.phrase_waiting')
    case 'relay':
      return e.detail ?? t('missionLog.phrase_relay')
    case 'close':
      return e.detail ? t('missionLog.phrase_close_detail', { detail: e.detail }) : t('missionLog.phrase_close')
    default:
      return ''
  }
}

/**
 * Live aggregate counts derived from the CURRENT canvas node statuses (not the
 * event log) — so the pulse chip reflects the present instant, while the panel
 * shows the chronological story. `waiting` maps from the relay/narration logical
 * 'waiting' state, but the store only persists idle/working/done/error, so we
 * read what the store has (working/done/error) and treat 'error' separately.
 */
export interface PulseCounts {
  working: number
  done: number
  error: number
}

function countStatuses(nodes: CanvasNode[]): PulseCounts {
  let working = 0
  let done = 0
  let error = 0
  for (const n of nodes) {
    if (n.kind !== 'terminal') continue
    if (n.status === 'working') working++
    else if (n.status === 'error') error++
    else if (n.status === 'done') done++
  }
  return { working, done, error }
}

/**
 * Compact TopBar pulse chip: "X trabajando · Y hecho · Z error", live from
 * canvas node statuses. Opens the Mission Pulse panel on click. Shows nothing
 * loud when idle, just a calm summary.
 */
export function MissionPulseChip({
  active,
  onClick
}: {
  active: boolean
  onClick: () => void
}): JSX.Element {
  const t = useT()
  const { working, done, error } = useCanvas(useShallow((s) => countStatuses(s.nodes)))
  return (
    <button
      onClick={onClick}
      title={t('panels.pulse_chip_title')}
      aria-label={t('panels.pulse_chip_aria')}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        height: 26,
        padding: '0 9px',
        background: active ? 'rgba(91,140,255,0.16)' : 'transparent',
        border: 'none',
        borderRadius: 7,
        color: active ? '#cfe0ff' : '#aebbd6',
        fontSize: 11.5,
        fontWeight: 600,
        cursor: 'pointer'
      }}
    >
      <PulseStat color="#f2c84b" n={working} pulse={working > 0} />
      <PulseStat color="#48d597" n={done} />
      <PulseStat color="#f2564b" n={error} pulse={error > 0} />
      <style>{`@keyframes canvasioPulse {0%,100%{opacity:1}50%{opacity:.4}}`}</style>
    </button>
  )
}

function PulseStat({ color, n, pulse }: { color: string; n: number; pulse?: boolean }): JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, opacity: n > 0 ? 1 : 0.45 }}>
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
          boxShadow: n > 0 ? `0 0 7px ${color}` : undefined,
          animation: pulse ? 'canvasioPulse 1.1s ease-in-out infinite' : undefined
        }}
      />
      <span style={{ minWidth: 8, textAlign: 'left' }}>{n}</span>
    </span>
  )
}

/**
 * Right-side slide-in Mission Pulse panel. Reuses DoctorPanel's visual pattern
 * (glass overlay, theme-aware colors) and renders the timeline newest-first,
 * live-subscribed to the mission store. A 1 Hz tick keeps the relative
 * timestamps fresh while the panel is open.
 */
export function MissionLog({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const t = useT()
  const { style: dragStyle, dragHandleProps } = useDraggablePanel('mission-pulse')
  const events = useMission((s) => s.events)
  const clearAll = useMission((s) => s.clearAll)
  const nodes = useCanvas((s) => s.nodes)
  const { working, done, error } = useCanvas(useShallow((s) => countStatuses(s.nodes)))
  const [now, setNow] = useState(Date.now())
  const [briefOpen, setBriefOpen] = useState(true)

  // Subscribe to replay so the row currently being flown-to can be highlighted.
  const replayArmed = useReplay((s) => s.armed)
  const replayIndex = useReplay((s) => s.index)
  const replaySnapshot = useReplay((s) => s.snapshot)
  const replayingId =
    replayArmed && replaySnapshot.length > 0 ? replaySnapshot[replayIndex]?.id : undefined

  // 1 Hz tick for live relative timestamps, only while the panel is open.
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [open])

  // Re-derive the Mission Brief on every events/nodes change AND on the 1 Hz tick
  // (so "longest working stretch" / live blockers stay fresh while open).
  // Hoisted above the early return so this hook always runs in the same order
  // (Rules of Hooks); it depends only on hook state so behavior is unchanged.
  const brief = useMemo(
    () => (open ? computeBrief(events, nodes) : EMPTY_BRIEF),
    [open, events, nodes, now]
  )

  // Esc closes the panel (capture phase, like the other HUD panels).
  // Hoisted above the early return so this hook always runs in the same order
  // (Rules of Hooks).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  if (!open) return null

  // Newest-first for the timeline.
  const ordered = [...events].reverse()

  const lines = briefLines(brief)

  // Agent Objectives — per-agent goal-vs-actual digest, reusing the SAME pure
  // assessObjective the node headers use, fed from the existing in-memory stores
  // (Echo/Lens/Mission/Changeset). Only terminal nodes with a goal appear; the
  // section renders nothing when no agent has an objective set.
  const echoEntries = useEcho.getState().entries
  const lensLines = useLens.getState().lines
  const csByNode = useChangeset.getState().byNode
  const objectiveRows = nodes
    .filter((n) => n.kind === 'terminal' && n.objective?.text)
    .map((n) => {
      const cs = csByNode[n.id]
      const a = assessObjective({
        objective: n.objective,
        status: n.status,
        echoLines: (echoEntries[n.id] ?? []).map((l) => l.text),
        lensLine: lensLines[n.id]?.text,
        events: events.filter((e) => e.nodeId === n.id),
        diff: cs ? { files: cs.files.length, adds: cs.adds, dels: cs.dels } : undefined
      })
      return { node: n, assessment: a }
    })

  return (
    <div
      className="glass-solid no-drag"
      data-canvasio-panel-root
      style={{
        pointerEvents: 'auto',
        position: 'absolute',
        top: 46,
        right: 14,
        borderRadius: 14,
        padding: 16,
        width: 380,
        maxHeight: '78vh',
        overflowY: 'auto',
        fontSize: 13,
        color: '#d7e1f7',
        ...dragStyle
      }}
    >
      <PanelGrip dragHandleProps={dragHandleProps} />
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>Mission Pulse</span>
        <span
          style={{
            marginLeft: 8,
            fontSize: 10.5,
            color: '#8fa3cc',
            border: '1px solid rgba(120,150,220,0.2)',
            borderRadius: 6,
            padding: '1px 6px'
          }}
        >
          {t('panels.pulse_timeline_badge')}
        </span>
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('canvasio:open-chrono'))}
          aria-label={t('panels.pulse_open_chrono')}
          title={t('panels.pulse_chrono_title')}
          style={{
            marginLeft: 'auto',
            background: 'rgba(124,151,224,0.16)',
            border: '1px solid rgba(120,150,220,0.22)',
            color: '#cfe0ff',
            borderRadius: 7,
            padding: '3px 9px',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          ⛓ {t('panels.pulse_timeline_btn')}
        </button>
        <button
          onClick={() => useReplay.getState().start()}
          disabled={events.length === 0}
          aria-label={t('panels.pulse_replay_aria')}
          title={t('panels.pulse_replay_title')}
          style={{
            marginLeft: 8,
            background: events.length === 0 ? 'transparent' : 'rgba(124,151,224,0.16)',
            border: '1px solid rgba(120,150,220,0.22)',
            color: events.length === 0 ? '#6f84ad' : '#cfe0ff',
            borderRadius: 7,
            padding: '3px 9px',
            fontSize: 11,
            fontWeight: 600,
            cursor: events.length === 0 ? 'default' : 'pointer',
            opacity: events.length === 0 ? 0.5 : 1
          }}
        >
          ⏵ {t('panels.pulse_replay_btn')}
        </button>
        <button
          onClick={onClose}
          aria-label={t('panels.pulse_close')}
          title={t('common.close')}
          style={{ marginLeft: 8, background: 'none', border: 'none', color: '#8fa3cc', cursor: 'pointer' }}
        >
          ✕
        </button>
      </div>

      {/* live aggregate pulse */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '10px 12px',
          marginBottom: 12,
          borderRadius: 11,
          border: '1px solid rgba(120,150,220,0.16)',
          background: 'rgba(8,12,26,0.45)'
        }}
      >
        <PulseLine color="#f2c84b" n={working} label={t('panels.pulse_working')} pulse={working > 0} />
        <PulseLine color="#48d597" n={done} label={t('panels.pulse_done')} />
        <PulseLine color="#f2564b" n={error} label={t('panels.pulse_error')} pulse={error > 0} />
        <style>{`@keyframes canvasioPulse {0%,100%{opacity:1}50%{opacity:.4}}`}</style>
      </div>

      {/* Mission Brief — intelligence digest folded from the timeline. */}
      <div
        style={{
          marginBottom: 12,
          borderRadius: 11,
          border: '1px solid rgba(120,150,220,0.16)',
          background: 'rgba(8,12,26,0.45)',
          overflow: 'hidden'
        }}
      >
        <button
          onClick={() => setBriefOpen((v) => !v)}
          aria-expanded={briefOpen}
          aria-label={t('panels.pulse_brief_toggle')}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '9px 12px',
            background: 'transparent',
            border: 'none',
            color: '#d7e1f7',
            cursor: 'pointer',
            textAlign: 'left'
          }}
        >
          <span style={{ fontSize: 12, color: '#8fa3cc' }}>{briefOpen ? '▾' : '▸'}</span>
          <span style={{ fontWeight: 700, fontSize: 12.5 }}>Mission Brief</span>
          {brief.blockers.length > 0 && (
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                color: '#f2564b',
                border: '1px solid rgba(242,86,75,0.4)',
                borderRadius: 6,
                padding: '1px 6px'
              }}
            >
              {t(
                brief.blockers.length === 1
                  ? 'panels.pulse_blocked_one'
                  : 'panels.pulse_blocked_other',
                { n: brief.blockers.length }
              )}
            </span>
          )}
          {events.length > 0 && (
            <span
              role="button"
              tabIndex={0}
              title={t('panels.pulse_narrate_brief')}
              aria-label={t('panels.pulse_narrate_brief_aria')}
              onClick={(e) => {
                e.stopPropagation()
                narrateBrief(briefHeadline(brief))
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation()
                  narrateBrief(briefHeadline(brief))
                }
              }}
              style={{
                marginLeft: 'auto',
                fontSize: 12.5,
                color: '#aebbd6',
                cursor: 'pointer',
                padding: '0 4px'
              }}
            >
              🔊
            </span>
          )}
        </button>
        {briefOpen && (
          <div style={{ padding: '0 12px 11px' }}>
            <div
              style={{
                fontSize: 11.5,
                color: '#cfe0ff',
                lineHeight: 1.45,
                marginBottom: lines.length ? 9 : 0
              }}
            >
              {briefHeadline(brief)}
            </div>
            {lines.map((l) => {
              const accent = l.agentKind ? AGENT_COLOR[l.agentKind] : '#7c97e0'
              const statusColor =
                l.blockerKind === 'error'
                  ? '#f2564b'
                  : l.blockerKind === 'waiting'
                    ? '#5ad1e8'
                    : '#8fa3cc'
              return (
                <div
                  key={l.nodeId}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                    padding: '5px 8px',
                    marginBottom: 4,
                    borderRadius: 8,
                    background: 'rgba(8,12,26,0.5)',
                    borderLeft: `2px solid ${accent}`
                  }}
                >
                  <span style={{ fontWeight: 600, color: accent, flexShrink: 0 }}>{l.agent}</span>
                  <span style={{ fontSize: 10.5, color: statusColor, flexShrink: 0 }}>{l.title}</span>
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: 11,
                      color: '#aebbd6',
                      textAlign: 'right',
                      wordBreak: 'break-word'
                    }}
                  >
                    {l.text}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Agent Objectives — goal-vs-actual progress per agent. Renders only when
          at least one agent has a goal set. */}
      {objectiveRows.length > 0 && (
        <div
          style={{
            marginBottom: 12,
            borderRadius: 11,
            border: '1px solid rgba(120,150,220,0.16)',
            background: 'rgba(8,12,26,0.45)',
            padding: '9px 12px'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 12.5 }}>{t('panels.pulse_objectives')}</span>
            <span
              role="button"
              tabIndex={0}
              title={t('panels.pulse_narrate_standup')}
              aria-label={t('panels.pulse_narrate_standup')}
              onClick={() => narrateBrief(objectivesStandup(objectiveRows))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') narrateBrief(objectivesStandup(objectiveRows))
              }}
              style={{ marginLeft: 'auto', fontSize: 12.5, color: '#aebbd6', cursor: 'pointer', padding: '0 4px' }}
            >
              🔊
            </span>
          </div>
          {objectiveRows.map(({ node: n, assessment: a }) => {
            const accent = n.agent ? AGENT_COLOR[n.agent] : '#7c97e0'
            const jc = judgmentColor(a.judgment)
            return (
              <div
                key={n.id}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 8,
                  padding: '5px 8px',
                  marginBottom: 4,
                  borderRadius: 8,
                  background: 'rgba(8,12,26,0.5)',
                  borderLeft: `2px solid ${accent}`
                }}
              >
                <span style={{ fontWeight: 600, color: accent, flexShrink: 0 }}>{n.title}</span>
                <span style={{ fontWeight: 700, color: jc, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                  {a.percent}%
                </span>
                <span style={{ fontSize: 10.5, color: jc, flexShrink: 0 }}>{judgmentLabel(a.judgment)}</span>
                <span
                  title={n.objective?.text}
                  style={{
                    marginLeft: 'auto',
                    fontSize: 11,
                    color: '#aebbd6',
                    textAlign: 'right',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: 180
                  }}
                >
                  {n.objective?.text}
                </span>
              </div>
            )
          })}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ color: '#8fa3cc', fontSize: 12, fontWeight: 600 }}>
          {t('panels.pulse_activity', { n: events.length })}
        </span>
        {events.length > 0 && (
          <button
            onClick={clearAll}
            title={t('panels.pulse_clear_timeline')}
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: '1px solid rgba(120,150,220,0.2)',
              color: '#aebbd6',
              borderRadius: 7,
              padding: '3px 9px',
              fontSize: 11,
              cursor: 'pointer'
            }}
          >
            🧹 {t('panels.pulse_clear')}
          </button>
        )}
      </div>

      {ordered.length === 0 ? (
        <div style={{ fontSize: 12, color: '#6f84ad', padding: '4px 0' }}>
          {t('panels.pulse_no_activity')}
        </div>
      ) : (
        ordered.map((e) => {
          const meta = KIND_META[e.kind]
          const accent = e.agent ? AGENT_COLOR[e.agent] : '#7c97e0'
          const isReplaying = e.id === replayingId
          return (
            <div
              key={e.id}
              style={{
                display: 'flex',
                gap: 9,
                padding: '8px 10px',
                marginBottom: 6,
                borderRadius: 10,
                background: isReplaying ? 'rgba(124,151,224,0.18)' : 'rgba(8,12,26,0.55)',
                border: isReplaying
                  ? `1px solid ${accent}`
                  : '1px solid rgba(120,150,220,0.12)',
                borderLeft: `2px solid ${accent}`,
                boxShadow: isReplaying ? `0 0 0 1px ${accent}55, 0 0 12px ${accent}33` : undefined
              }}
            >
              <span
                title={t(`missionLog.kind_${e.kind}`)}
                style={{
                  flexShrink: 0,
                  width: 18,
                  textAlign: 'center',
                  color: meta.color,
                  fontWeight: 700,
                  lineHeight: '18px'
                }}
              >
                {meta.icon}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontWeight: 600, color: accent }}>{e.title}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 10.5, color: '#6f84ad', flexShrink: 0 }}>
                    {relTime(e.ts, now)}
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: '#aebbd6', marginTop: 2, lineHeight: 1.4, wordBreak: 'break-word' }}>
                  {phraseFor(e)}
                </div>
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}

function PulseLine({
  color,
  n,
  label,
  pulse
}: {
  color: string
  n: number
  label: string
  pulse?: boolean
}): JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: n > 0 ? 1 : 0.5 }}>
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: '50%',
          background: color,
          boxShadow: n > 0 ? `0 0 8px ${color}` : undefined,
          animation: pulse ? 'canvasioPulse 1.1s ease-in-out infinite' : undefined
        }}
      />
      <span style={{ fontSize: 12.5, fontWeight: 700, color: '#e7eeff' }}>{n}</span>
      <span style={{ fontSize: 11, color: '#8fa3cc' }}>{label}</span>
    </span>
  )
}
