import { useEffect, useState, useCallback } from 'react'
import {
  getDoctorBridge,
  logAction,
  type Report,
  type Repair,
  type ReportSeverity,
  type LoopStatus,
  type LoopPhase,
  type UpdateReady,
  type RebuildStatus,
  type QueueStatus
} from '../lib/logger'
import { useDraggablePanel } from '../lib/useDraggablePanel'
import { useT, t as tt } from '../store/i18n'
import { PanelGrip } from './PanelGrip'

/**
 * Aggregate the worst severity across the current reports. Drives the health
 * indicator color in the TopBar.
 */
export type HealthLevel = 'ok' | 'warn' | 'error'

function worstSeverity(reports: Report[]): HealthLevel {
  let level: HealthLevel = 'ok'
  for (const r of reports) {
    if (r.severity === 'error') return 'error'
    if (r.severity === 'warn') level = 'warn'
  }
  return level
}

const HEALTH_COLOR: Record<HealthLevel, string> = {
  ok: '#48d597',
  warn: '#f2c84b',
  error: '#f2564b'
}

/**
 * Small pulsing dot for the TopBar. Turns amber/red when the Doctor has
 * warn/error reports. `running` triggers a subtle pulse animation.
 */
export function HealthIndicator({
  level,
  running,
  active,
  onClick
}: {
  level: HealthLevel
  running: boolean
  active: boolean
  onClick: () => void
}): JSX.Element {
  const t = useT()
  const color = HEALTH_COLOR[level]
  return (
    <button
      onClick={onClick}
      title={t('panels.doctor_indicator_title')}
      aria-label={t('panels.doctor_open')}
      style={{
        width: 28,
        height: 26,
        display: 'grid',
        placeItems: 'center',
        background: active ? 'rgba(91,140,255,0.16)' : 'transparent',
        border: 'none',
        borderRadius: 7,
        color: active ? '#cfe0ff' : '#aebbd6',
        position: 'relative'
      }}
    >
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: '50%',
          background: color,
          boxShadow: `0 0 8px ${color}, 0 0 2px ${color}`,
          animation: running ? 'canvasioDoctorPulse 1s ease-in-out infinite' : undefined
        }}
      />
      <style>{`@keyframes canvasioDoctorPulse {0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.7)}}`}</style>
    </button>
  )
}

const SEV_COLOR: Record<ReportSeverity, string> = {
  info: '#5b8cff',
  warn: '#f2c84b',
  error: '#f2564b'
}

/** The base `Repair` already carries the loop's optional fields (appliedTs, etc.). */
type RepairView = Repair

function phaseLabel(phase: LoopPhase): string {
  return tt('panels.doctor_phase_' + phase)
}

/**
 * Render an ISO timestamp as "HH:MM (hace Xm)". Pure; returns '' on missing/bad
 * input so callers can compose copy without extra guards.
 */
function relTime(ts?: string | null): string {
  if (!ts) return ''
  const ms = Date.parse(ts)
  if (!Number.isFinite(ms)) return ''
  const hhmm = new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const diffMin = Math.max(0, Math.round((Date.now() - ms) / 60_000))
  const rel = diffMin < 1 ? tt('panels.doctor_rel_moment') : tt('panels.doctor_rel_min', { n: diffMin })
  return `${hhmm} (${rel})`
}

/**
 * True when the loop is running but NOT in any active phase right now — i.e. it
 * is merely watching/polling. Tolerates an older main payload (no `analyzing`
 * field) by treating it as not-analyzing.
 */
function loopWatching(loop: LoopStatus): boolean {
  return loop.running && !loop.analyzing && loop.phase === 'idle'
}

/** Short header-pill text: "bucle: detenido" | "bucle: vigilando · …" | "bucle: <phase>". */
function loopPillText(loop: LoopStatus): string {
  if (!loop.running) return tt('panels.doctor_loop_pill_stopped')
  if (loopWatching(loop)) {
    const check = relTime(loop.lastCheckTs)
    return check
      ? tt('panels.doctor_loop_pill_watching_check', { check })
      : tt('panels.doctor_loop_pill_watching')
  }
  return tt('panels.doctor_loop_pill_phase', { phase: phaseLabel(loop.phase) })
}

/** Loop-card sub-line: honest idle/active/stopped phase description. */
function loopPhaseLine(loop: LoopStatus): string {
  if (!loop.running) return tt('panels.doctor_loop_line_stopped')
  if (loopWatching(loop)) {
    const check = relTime(loop.lastCheckTs)
    return check
      ? tt('panels.doctor_loop_line_watching_check', { check })
      : tt('panels.doctor_loop_line_watching')
  }
  return tt('panels.doctor_loop_line_phase', { phase: phaseLabel(loop.phase) })
}

export function DoctorPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const t = useT()
  const { style: dragStyle, dragHandleProps } = useDraggablePanel('doctor')
  const [enabled, setEnabled] = useState(true)
  const [running, setRunning] = useState(false)
  const [lastRunTs, setLastRunTs] = useState<string | null>(null)
  const [reports, setReports] = useState<Report[]>([])
  const [repairs, setRepairs] = useState<Repair[]>([])
  const [committing, setCommitting] = useState(false)
  const [commitMsg, setCommitMsg] = useState<string | null>(null)
  const [analyzeResult, setAnalyzeResult] = useState<string | null>(null)
  const [available, setAvailable] = useState(true)
  const [updateReady, setUpdateReady] = useState<UpdateReady | null>(null)
  const [rebuild, setRebuild] = useState<RebuildStatus | null>(null)
  const [packaged, setPackaged] = useState(false)
  const [loop, setLoop] = useState<LoopStatus>({
    running: false,
    phase: 'idle',
    lastBuild: null,
    available: false
  })
  const [queue, setQueue] = useState<QueueStatus | null>(null)
  const [now, setNow] = useState(Date.now())

  // Esc cierra el panel (fase de captura, como los demás paneles HUD).
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

  const refreshRepairs = useCallback(async () => {
    const d = getDoctorBridge()
    if (!d) return
    try {
      setRepairs(await d.repairs())
    } catch {
      /* ignore */
    }
  }, [])

  // Initial status + live subscriptions.
  useEffect(() => {
    const d = getDoctorBridge()
    if (!d) {
      setAvailable(false)
      return
    }
    let mounted = true
    d.status()
      .then((s) => {
        if (!mounted) return
        setEnabled(s.enabled)
        setLastRunTs(s.lastRunTs)
        setReports(s.issues)
        if (s.loop) setLoop(s.loop)
        if (s.updateReady !== undefined) setUpdateReady(s.updateReady)
        if (s.queue !== undefined) setQueue(s.queue ?? null)
        if (typeof s.packaged === 'boolean') setPackaged(s.packaged)
      })
      .catch(() => {})
    void refreshRepairs()
    d.queueStatus()
      .then((q) => setQueue(q))
      .catch(() => {})

    const offReport = d.onReport((issues) => {
      setReports(issues)
      setLastRunTs(new Date().toISOString())
      setAnalyzeResult(
        tt('panels.doctor_analyzed', {
          summary: issues.length
            ? tt('panels.doctor_analyzed_count', { n: issues.length })
            : tt('panels.doctor_analyzed_none'),
          time: relTime(new Date().toISOString())
        })
      )
      // A report change may accompany a repairs.json change — refresh both, and
      // re-pull loop status so the phase/last-build reflect the loop's progress.
      void refreshRepairs()
      d.loopStatus()
        .then((s) => setLoop(s))
        .catch(() => {})
    })
    const offRunning = d.onRunning((r) => setRunning(r))
    const offLoop = d.onLoop((s) => setLoop(s))
    const offQueue = d.onQueue((q) => setQueue(q))
    const offUpdateReady = d.onUpdateReady((m) => {
      setUpdateReady(m)
      if (m) setRebuild(null)
    })
    const offRebuild = d.onRebuild((s) => setRebuild(s))
    return () => {
      mounted = false
      offReport()
      offRunning()
      offLoop()
      offQueue()
      offUpdateReady()
      offRebuild()
    }
  }, [refreshRepairs])

  // 1 Hz tick driving the "próxima reparación en mm:ss" countdown. Only armed
  // while there is something queued with a future next-attempt time, so a closed
  // panel / idle queue never causes perpetual re-renders.
  const nextMs = queue?.nextAttemptTs ? Date.parse(queue.nextAttemptTs) : NaN
  const hasQueued = !!queue && ((queue.pendingCount ?? 0) > 0 || !!queue.currentTitle)
  const countingDown = hasQueued && Number.isFinite(nextMs) && nextMs - now > 0
  useEffect(() => {
    if (!countingDown) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [countingDown])

  const runNow = async (): Promise<void> => {
    const d = getDoctorBridge()
    if (!d) return
    logAction('doctor.runNow')
    setAnalyzeResult(null)
    setRunning(true)
    try {
      await d.runNow()
    } catch {
      setRunning(false)
    }
  }

  const toggleEnabled = async (): Promise<void> => {
    const d = getDoctorBridge()
    if (!d) return
    const next = !enabled
    logAction('doctor.setEnabled', { enabled: next })
    setEnabled(next)
    try {
      const r = await d.setEnabled(next)
      setEnabled(r.enabled)
    } catch {
      setEnabled(!next)
    }
  }

  const toggleLoop = async (): Promise<void> => {
    const d = getDoctorBridge()
    if (!d) return
    logAction('doctor.toggleLoop', { running: !loop.running })
    try {
      if (loop.running) await d.stopLoop()
      else await d.startLoop()
      const s = await d.loopStatus()
      setLoop(s)
    } catch {
      /* ignore */
    }
  }

  const openLog = async (): Promise<void> => {
    const d = getDoctorBridge()
    if (!d) return
    logAction('doctor.openLog')
    try {
      await d.openLog()
    } catch {
      /* ignore */
    }
  }

  const clearHistory = async (): Promise<void> => {
    const d = getDoctorBridge()
    if (!d) return
    if (!window.confirm(tt('panels.doctor_clear_confirm'))) return
    logAction('doctor.clearHistory')
    try {
      await d.clearHistory()
    } catch {
      /* ignore */
    }
    // Clear locally too; the main-side re-emits will also converge on empty.
    setReports([])
    setRepairs([])
    setQueue(null)
    setUpdateReady(null)
    setAnalyzeResult(null)
  }

  const commitCheckpoint = async (): Promise<void> => {
    const d = getDoctorBridge()
    if (!d) return
    const msg = `checkpoint: safety commit ${new Date().toISOString()}`
    logAction('doctor.commitCheckpoint', { message: msg })
    setCommitting(true)
    setCommitMsg(null)
    try {
      const r = await d.commitCheckpoint(msg)
      setCommitMsg(
        r.ok
          ? tt('panels.doctor_commit_ok', { sha: r.sha?.slice(0, 7) ?? '' })
          : `✕ ${r.error || tt('panels.doctor_commit_fail')}`
      )
    } catch (e) {
      setCommitMsg(`✕ ${String(e)}`)
    } finally {
      setCommitting(false)
    }
  }

  const applyUpdate = async (): Promise<void> => {
    const d = getDoctorBridge()
    if (!d) return
    logAction('doctor.applyUpdate')
    setRebuild({ phase: 'building', message: tt('panels.doctor_rebuilding') })
    try {
      const r = await d.applyUpdate()
      if (!r.ok) {
        setRebuild({ phase: 'failed', message: r.error || tt('panels.doctor_rebuild_failed') })
      } else if (r.mode === 'dev-reloaded') {
        setRebuild({ phase: 'dev-reloaded', message: tt('panels.doctor_applied_reloaded') })
        setUpdateReady(null)
      }
      // On a real rebuild the app quits + relaunches; nothing more to do here.
    } catch (e) {
      setRebuild({ phase: 'failed', message: String(e) })
    }
  }

  // Autonomous mode: surface the most recent applied/failed repairs (newest
  // first), plus any in-flight 'proposed' entry as "reparando…".
  const recentRepairs: RepairView[] = (repairs as RepairView[])
    .filter(
      (r) =>
        r.status === 'applied' ||
        r.status === 'applied-no-release' ||
        r.status === 'failed' ||
        r.status === 'proposed'
    )
    .sort((a, b) => {
      const ta = a.appliedTs || a.createdTs || ''
      const tb = b.appliedTs || b.createdTs || ''
      return tb.localeCompare(ta)
    })
    .slice(0, 12)

  // Per-diagnostic state pill. The bridge keys diagnostic proposals by
  // 'diag_'+report.id in canvasio-repairs.json, so we match on that namespaced id;
  // we also treat the loop's currentId as "reparando" for the live target.
  const diagState = (
    r: Report
  ): { label: string; color: string; pulsing: boolean } | null => {
    if (r.severity !== 'error' || !r.files || r.files.length === 0) return null
    const repairId = 'diag_' + r.id
    if (queue?.currentId === repairId) {
      return { label: t('panels.doctor_diag_repairing'), color: '#f2c84b', pulsing: true }
    }
    const rep = (repairs as RepairView[]).find((x) => x.id === repairId)
    if (rep) {
      if (rep.status === 'applied' || rep.status === 'applied-no-release') {
        return { label: t('panels.doctor_diag_done'), color: '#48d597', pulsing: false }
      }
      if (rep.status === 'failed')
        return { label: t('panels.doctor_diag_failed'), color: '#f2564b', pulsing: false }
      if (rep.status === 'proposed')
        return { label: t('panels.doctor_diag_repairing'), color: '#f2c84b', pulsing: true }
    }
    return { label: t('panels.doctor_diag_pending'), color: '#6f84ad', pulsing: false }
  }

  // Countdown copy (mm:ss) derived from the 1 Hz tick.
  const remainMs = countingDown ? Math.max(0, nextMs - now) : 0
  const mmss = `${String(Math.floor(remainMs / 60000)).padStart(2, '0')}:${String(
    Math.floor(remainMs / 1000) % 60
  ).padStart(2, '0')}`

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
        <span style={{ fontWeight: 700, fontSize: 14 }}>Doctor</span>
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
          {running ? t('panels.doctor_badge_analyzing') : t('panels.doctor_badge_autonomous')}
        </span>
        <span
          title={
            loop.available
              ? t('panels.doctor_loop_status_title')
              : t('panels.doctor_loop_devonly_title')
          }
          style={{
            marginLeft: 6,
            fontSize: 10.5,
            color: loop.running ? '#bdf5da' : '#8fa3cc',
            border: `1px solid ${loop.running ? 'rgba(72,213,151,0.4)' : 'rgba(120,150,220,0.2)'}`,
            background: loop.running ? 'rgba(72,213,151,0.10)' : 'transparent',
            borderRadius: 6,
            padding: '1px 6px'
          }}
        >
          {loopPillText(loop)}
        </span>
        <button
          onClick={onClose}
          aria-label={t('panels.doctor_close')}
          title={t('common.close')}
          style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#8fa3cc', cursor: 'pointer' }}
        >
          ✕
        </button>
      </div>

      {!available && (
        <div style={{ color: '#f2c84b', fontSize: 12, marginBottom: 12 }}>
          {t('panels.doctor_bridge_unavailable')}
        </div>
      )}

      {/* Reparación hecha → ofrecer reconstruir + reabrir (app instalada). */}
      {updateReady && (
        <div
          style={{
            padding: '12px 13px',
            marginBottom: 12,
            borderRadius: 12,
            border: '1px solid rgba(72,213,151,0.45)',
            background: 'rgba(72,213,151,0.12)'
          }}
        >
          <div style={{ fontWeight: 700, color: '#e7eeff', fontSize: 13, marginBottom: 4 }}>
            {t('panels.doctor_repair_done', { title: updateReady.title })}
          </div>
          {updateReady.diffSummary && (
            <div style={{ fontSize: 11.5, color: '#bdf5da', lineHeight: 1.45 }}>
              {updateReady.diffSummary}
            </div>
          )}
          {updateReady.files && updateReady.files.length > 0 && (
            <div style={{ marginTop: 5, fontSize: 10.5, color: '#8fbfa8', wordBreak: 'break-all' }}>
              {updateReady.files.join(' · ')}
            </div>
          )}
          <div style={{ fontSize: 11, color: '#9fd9c0', marginTop: 8, marginBottom: 8, lineHeight: 1.45 }}>
            {packaged
              ? t('panels.doctor_repair_ready_packaged')
              : t('panels.doctor_repair_ready_dev')}
          </div>
          {rebuild && rebuild.phase !== 'failed' ? (
            <div style={{ fontSize: 12, color: '#bdf5da' }}>
              {rebuild.message ||
                (rebuild.phase === 'building'
                  ? t('panels.doctor_rebuilding')
                  : rebuild.phase === 'swapping'
                    ? t('panels.doctor_reopening')
                    : rebuild.phase === 'dev-reloaded'
                      ? t('panels.doctor_applied_reloaded')
                      : t('panels.doctor_ready'))}
            </div>
          ) : (
            <button
              onClick={applyUpdate}
              disabled={!available}
              style={withDisabled(
                {
                  width: '100%',
                  border: '1px solid rgba(72,213,151,0.5)',
                  background: 'rgba(72,213,151,0.2)',
                  color: '#bdf5da',
                  borderRadius: 9,
                  padding: '9px 12px',
                  fontSize: 12.5,
                  fontWeight: 700
                },
                !available
              )}
            >
              {packaged ? t('panels.doctor_update_btn') : t('panels.doctor_applied_btn')}
            </button>
          )}
          {rebuild && rebuild.phase === 'failed' && (
            <div style={{ fontSize: 11.5, color: '#f2564b', marginTop: 7 }}>
              ✕ {rebuild.message || t('panels.doctor_rebuild_failed_keep')}
            </div>
          )}
        </div>
      )}

      {/* AUTO-REPAIR master switch — the kill switch. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 12px',
          marginBottom: 10,
          borderRadius: 11,
          border: `1px solid ${enabled ? 'rgba(72,213,151,0.4)' : 'rgba(242,200,75,0.4)'}`,
          background: enabled ? 'rgba(72,213,151,0.10)' : 'rgba(242,200,75,0.08)'
        }}
      >
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: '50%',
            flexShrink: 0,
            background: enabled ? '#48d597' : '#f2c84b',
            boxShadow: `0 0 8px ${enabled ? '#48d597' : '#f2c84b'}`,
            animation: enabled && running ? 'canvasioDoctorPulse 1s ease-in-out infinite' : undefined
          }}
        />
        <div style={{ lineHeight: 1.3 }}>
          <div style={{ fontWeight: 700, color: '#e7eeff', fontSize: 13 }}>
            {enabled ? t('panels.doctor_autorepair_active') : t('panels.doctor_autorepair_paused')}
          </div>
          <div style={{ fontSize: 10.5, color: '#8fa3cc' }}>
            {enabled ? t('panels.doctor_autorepair_active_desc') : t('panels.doctor_autorepair_paused_desc')}
          </div>
        </div>
        <button
          onClick={toggleEnabled}
          disabled={!available}
          aria-pressed={enabled}
          title={enabled ? t('panels.doctor_autorepair_pause') : t('panels.doctor_autorepair_resume')}
          style={{
            marginLeft: 'auto',
            position: 'relative',
            width: 44,
            height: 24,
            borderRadius: 999,
            border: 'none',
            cursor: available ? 'pointer' : 'default',
            background: enabled ? 'rgba(72,213,151,0.55)' : 'rgba(120,140,180,0.35)',
            transition: 'background 140ms ease'
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 3,
              left: enabled ? 23 : 3,
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: '#fff',
              transition: 'left 140ms ease'
            }}
          />
        </button>
      </div>

      {/* How autonomy works — replaces the old "Pulsa Aplicar" copy. */}
      <div style={{ fontSize: 11, color: '#8fa3cc', marginBottom: 12, lineHeight: 1.5 }}>
        {t('panels.doctor_autonomy_1')}{' '}
        <b style={{ color: '#aebbd6' }}>{t('panels.doctor_autonomy_self_repair')}</b>
        {t('panels.doctor_autonomy_2')}{' '}
        <b style={{ color: '#aebbd6' }}>{t('panels.doctor_autonomy_safety_commit')}</b>
        {t('panels.doctor_autonomy_3')}
      </div>

      {/* Auto-repair loop status + manual start/stop. */}
      <div
        style={{
          padding: '10px 12px',
          marginBottom: 10,
          borderRadius: 11,
          border: '1px solid rgba(120,150,220,0.16)',
          background: 'rgba(8,12,26,0.45)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: '50%',
              flexShrink: 0,
              background: loop.running ? '#48d597' : '#6f84ad',
              boxShadow: loop.running ? '0 0 8px #48d597' : undefined
            }}
          />
          <div style={{ lineHeight: 1.3 }}>
            <div style={{ fontWeight: 700, color: '#e7eeff', fontSize: 12.5 }}>
              {loop.running ? t('panels.doctor_loop_card_running') : t('panels.doctor_loop_card_stopped')}
            </div>
            <div style={{ fontSize: 10.5, color: '#8fa3cc' }}>
              {loopPhaseLine(loop)}
              {loop.lastBuild
                ? t('panels.doctor_last_build', {
                    result:
                      loop.lastBuild === 'ok'
                        ? t('panels.doctor_build_ok')
                        : t('panels.doctor_build_fail')
                  })
                : ''}
            </div>
          </div>
          <button
            onClick={toggleLoop}
            disabled={!available || !loop.available || (!loop.running && !enabled)}
            title={
              !loop.available
                ? t('panels.doctor_loop_devonly_short')
                : !enabled && !loop.running
                  ? t('panels.doctor_loop_enable_first')
                  : loop.running
                    ? t('panels.doctor_loop_stop')
                    : t('panels.doctor_loop_start')
            }
            style={withDisabled(
              loop.running ? ghostBtn : primaryBtn,
              !available || !loop.available || (!loop.running && !enabled)
            )}
          >
            {loop.running ? t('panels.doctor_loop_stop_btn') : t('panels.doctor_loop_start_btn')}
          </button>
        </div>
        {!loop.available && (
          <div style={{ fontSize: 10.5, color: '#6f84ad', marginTop: 7, lineHeight: 1.45 }}>
            {t('panels.doctor_loop_devonly_1')}{' '}
            <b style={{ color: '#9fb0d2' }}>{t('panels.doctor_dev')}</b>
            {t('panels.doctor_loop_devonly_2')}
          </div>
        )}
      </div>

      {/* DEV vs INSTALLED explanation. */}
      <div style={{ fontSize: 11, color: '#8fa3cc', marginBottom: 12, lineHeight: 1.5 }}>
        {t('panels.doctor_devinst_1')}{' '}
        <b style={{ color: '#aebbd6' }}>{t('panels.doctor_dev')}</b>
        {t('panels.doctor_devinst_2')}{' '}
        <i>{t('panels.doctor_devinst_update_phrase')}</i>
        {t('panels.doctor_devinst_3')}{' '}
        <b style={{ color: '#aebbd6' }}>{t('panels.doctor_installed_app')}</b>
        {t('panels.doctor_devinst_4')}
      </div>

      {/* controls */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <button
          onClick={runNow}
          disabled={running || !available}
          style={withDisabled(primaryBtn, running || !available)}
        >
          {running ? t('panels.doctor_analyzing_btn') : t('panels.doctor_analyze_btn')}
        </button>
        <button onClick={openLog} disabled={!available} style={withDisabled(ghostBtn, !available)}>
          {t('panels.doctor_open_log')}
        </button>
        <button
          onClick={clearHistory}
          disabled={!available}
          style={withDisabled(ghostBtn, !available)}
        >
          {t('panels.doctor_clear_history')}
        </button>
      </div>

      {analyzeResult && !running && (
        <div style={{ fontSize: 11.5, color: '#48d597', marginBottom: 8 }}>{analyzeResult}</div>
      )}

      <button
        onClick={commitCheckpoint}
        disabled={committing || !available}
        style={withDisabled(checkpointBtn, committing || !available)}
      >
        {committing ? t('panels.doctor_committing_btn') : t('panels.doctor_commit_btn')}
      </button>
      {commitMsg && (
        <div style={{ fontSize: 11.5, color: commitMsg.startsWith('✓') ? '#48d597' : '#f2564b', marginTop: 6 }}>
          {commitMsg}
        </div>
      )}

      <div style={{ fontSize: 11, color: '#6f84ad', marginTop: 6 }}>
        {lastRunTs
          ? t('panels.doctor_last_analysis', { time: new Date(lastRunTs).toLocaleString() })
          : t('panels.doctor_no_checks')}
      </div>

      {/* Cola de reparación — live queue timing (only when the loop is running). */}
      {enabled && loop.running && queue && (
        <div
          style={{
            padding: '10px 12px',
            marginBottom: 10,
            borderRadius: 11,
            border: '1px solid rgba(120,150,220,0.16)',
            background: 'rgba(8,12,26,0.45)'
          }}
        >
          <div style={{ fontWeight: 700, color: '#e7eeff', fontSize: 12.5, marginBottom: 4 }}>
            {t('panels.doctor_queue_title')}
          </div>
          <div style={{ fontSize: 11.5, color: '#aebbd6' }}>
            {t(queue.pendingCount === 1 ? 'panels.doctor_queue_pending_one' : 'panels.doctor_queue_pending_other', {
              n: queue.pendingCount
            })}
          </div>
          {queue.currentTitle && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 6 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: '#f2c84b',
                  boxShadow: '0 0 8px #f2c84b',
                  animation: 'canvasioDoctorPulse 1s ease-in-out infinite'
                }}
              />
              <span style={{ fontSize: 11.5, color: '#e7cf8a' }}>
                {t('panels.doctor_queue_repairing', { title: queue.currentTitle })}
                {queue.currentIndex && queue.queueTotal
                  ? ` (${queue.currentIndex}/${queue.queueTotal})`
                  : ''}
              </span>
            </div>
          )}
          <div style={{ fontSize: 11, color: '#8fa3cc', marginTop: 6 }}>
            {countingDown
              ? t('panels.doctor_queue_next_in', { time: mmss })
              : hasQueued
                ? t('panels.doctor_queue_ready_next')
                : queue.nextAttemptTs
                  ? t('panels.doctor_queue_none_pending')
                  : '—'}
          </div>
        </div>
      )}

      {/* reports */}
      <SectionTitle>{t('panels.doctor_diagnostics', { n: reports.length })}</SectionTitle>
      {reports.length === 0 ? (
        <Empty>
          {loop.running ? t('panels.doctor_all_ok_watching') : t('panels.doctor_all_ok')}
        </Empty>
      ) : (
        reports.map((r) => {
          const ds = diagState(r)
          return (
          <div key={r.id} style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: SEV_COLOR[r.severity], flexShrink: 0 }} />
              <span style={{ fontWeight: 600, color: '#e7eeff' }}>{r.title}</span>
              {ds && (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    marginLeft: 'auto',
                    fontSize: 10,
                    color: ds.color,
                    textTransform: 'uppercase',
                    letterSpacing: 0.3
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: ds.color,
                      boxShadow: `0 0 6px ${ds.color}`,
                      animation: ds.pulsing ? 'canvasioDoctorPulse 1s ease-in-out infinite' : undefined
                    }}
                  />
                  {ds.label}
                </span>
              )}
              <span
                style={{
                  marginLeft: ds ? 8 : 'auto',
                  fontSize: 10,
                  color: '#6f84ad',
                  textTransform: 'uppercase'
                }}
              >
                {r.source}
              </span>
            </div>
            <div style={{ color: '#aebbd6', fontSize: 12, marginTop: 5, lineHeight: 1.45 }}>{r.summary}</div>
            {r.suggestedFix && (
              <div style={{ marginTop: 6, fontSize: 11.5, color: '#9fb0d2' }}>
                <b style={{ color: '#cfe0ff' }}>{t('panels.doctor_suggestion')}</b> {r.suggestedFix}
              </div>
            )}
            {r.files && r.files.length > 0 && (
              <div style={{ marginTop: 5, fontSize: 11, color: '#6f84ad', wordBreak: 'break-all' }}>
                {r.files.join(' · ')}
              </div>
            )}
          </div>
          )
        })
      )}

      {/* applied / failed repair history (autonomous — no buttons) */}
      <SectionTitle>{t('panels.doctor_auto_repairs', { n: recentRepairs.length })}</SectionTitle>
      {recentRepairs.length === 0 ? (
        <Empty>{t('panels.doctor_no_repairs')}</Empty>
      ) : (
        recentRepairs.map((rp) => {
          const ts = rp.appliedTs || rp.createdTs
          const badge =
            rp.status === 'applied'
              ? { label: t('panels.doctor_badge_applied'), color: '#48d597' }
              : rp.status === 'applied-no-release'
                ? { label: t('panels.doctor_badge_unpublished'), color: '#f2c84b' }
                : rp.status === 'failed'
                  ? { label: t('panels.doctor_badge_failed'), color: '#f2564b' }
                  : { label: t('panels.doctor_badge_repairing'), color: '#f2c84b' }
          // Human-readable explanation of WHY an applied fix did not publish.
          const noReleaseReason =
            rp.status === 'applied-no-release'
              ? rp.reason === 'autonomy-paused'
                ? t('panels.doctor_norelease_paused')
                : rp.reason === 'release-failed' || /^release/.test(rp.reason || '')
                  ? t('panels.doctor_norelease_blocked')
                  : /^bump-failed/.test(rp.reason || '')
                    ? t('panels.doctor_norelease_bump')
                    : t('panels.doctor_norelease_generic')
              : null
          return (
            <div key={rp.id} style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: badge.color, flexShrink: 0 }} />
                <span style={{ fontWeight: 600, color: '#e7eeff' }}>{rp.title}</span>
                <span
                  style={{
                    marginLeft: 'auto',
                    fontSize: 10,
                    color: badge.color,
                    textTransform: 'uppercase',
                    letterSpacing: 0.3
                  }}
                >
                  {badge.label}
                </span>
              </div>
              {rp.plan && (
                <div style={{ color: '#aebbd6', fontSize: 12, marginTop: 5, lineHeight: 1.45 }}>{rp.plan}</div>
              )}
              {rp.diffSummary && (
                <div
                  style={{ marginTop: 6, fontSize: 11, color: '#9fb0d2', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                >
                  {rp.diffSummary}
                </div>
              )}
              {rp.status === 'failed' && rp.failure && (
                <div style={{ marginTop: 6, fontSize: 11, color: '#e89a92' }}>
                  <b style={{ color: '#f2564b' }}>{t('panels.doctor_reason')}</b> {rp.failure}
                  {t('panels.doctor_reverted_checkpoint')}
                </div>
              )}
              {noReleaseReason && (
                <div style={{ marginTop: 6, fontSize: 11, color: '#e7cf8a' }}>
                  <b style={{ color: '#f2c84b' }}>{t('panels.doctor_unpublished_label')}</b> {noReleaseReason}
                  {rp.failure ? ` (${rp.failure})` : ''}
                </div>
              )}
              {ts && (
                <div style={{ marginTop: 6, fontSize: 10.5, color: '#6f84ad' }}>
                  {new Date(ts).toLocaleString()}
                  {(rp.status === 'applied' || rp.status === 'applied-no-release') && rp.fixSha
                    ? ` · ${rp.fixSha.slice(0, 7)}`
                    : ''}
                  {rp.releasedVersion ? ` · v${rp.releasedVersion}` : ''}
                </div>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div
      style={{
        marginTop: 16,
        marginBottom: 8,
        paddingTop: 12,
        borderTop: '1px solid rgba(140,165,225,0.14)',
        color: '#8fa3cc',
        fontSize: 12,
        fontWeight: 600
      }}
    >
      {children}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }): JSX.Element {
  return <div style={{ fontSize: 12, color: '#6f84ad', padding: '4px 0' }}>{children}</div>
}

/** Apply a consistent disabled appearance (dimmed + not-allowed cursor). */
function withDisabled(base: React.CSSProperties, disabled: boolean): React.CSSProperties {
  return disabled
    ? { ...base, cursor: 'not-allowed', opacity: 0.5 }
    : { ...base, cursor: 'pointer' }
}

const card: React.CSSProperties = {
  background: 'rgba(8,12,26,0.55)',
  border: '1px solid rgba(120,150,220,0.14)',
  borderRadius: 10,
  padding: 11,
  marginBottom: 8
}
const primaryBtn: React.CSSProperties = {
  border: '1px solid rgba(120,160,255,0.35)',
  background: 'rgba(91,140,255,0.18)',
  color: '#cfe0ff',
  borderRadius: 9,
  padding: '7px 11px',
  fontSize: 12.5,
  fontWeight: 600
}
const ghostBtn: React.CSSProperties = {
  border: '1px solid rgba(120,150,220,0.2)',
  background: 'transparent',
  color: '#aebbd6',
  borderRadius: 9,
  padding: '7px 11px',
  fontSize: 12.5
}
const checkpointBtn: React.CSSProperties = {
  width: '100%',
  border: '1px solid rgba(72,213,151,0.35)',
  background: 'rgba(72,213,151,0.14)',
  color: '#bdf5da',
  borderRadius: 9,
  padding: '8px 12px',
  fontSize: 12.5,
  fontWeight: 600
}
