/**
 * Renderer-side structured logging + the shared Doctor / log IPC type surface.
 *
 * This module is the single source of truth (on the renderer side) for the
 * `window.canvasio.log` and `window.canvasio.doctor` bridge shapes. Those bridges are
 * implemented in the preload by another agent; we augment the global `Window`
 * here so the whole renderer compiles cleanly against the finalized contracts
 * even before/independently of the preload changes.
 *
 * Design rules honored:
 *  - JSON-lines log entries: {ts, level, cat, msg, data?} (ts stamped by main).
 *  - Renderer-origin entries are always cat:'renderer' or cat:'action'.
 *  - Logging is best-effort and NEVER throws (a failed write is swallowed).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogCat =
  | 'main'
  | 'pty'
  | 'voice'
  | 'youtube'
  | 'ai'
  | 'webview'
  | 'renderer'
  | 'action'
  | 'doctor'

/** A log entry as written from the renderer (main stamps `ts`). */
export interface LogEntryInput {
  level: LogLevel
  cat: LogCat
  msg: string
  data?: Record<string, unknown>
}

export type ReportSeverity = 'info' | 'warn' | 'error'

/** Diagnostic report emitted by the Doctor (main -> renderer). */
export interface Report {
  id: string
  severity: ReportSeverity
  title: string
  summary: string
  suggestedFix: string
  files?: string[]
  source: 'usage' | 'code'
}

export type RepairStatus =
  | 'proposed'
  | 'approved'
  | 'rejected'
  | 'applied'
  | 'applied-no-release'
  | 'failed'

/** An entry of the file-based dev-loop repair handshake (canvasio-repairs.json). */
export interface Repair {
  id: string
  title: string
  plan: string
  diffSummary: string
  createdTs: string
  status: RepairStatus
  // Extra best-effort fields written by the autonomous dev loop (all optional).
  appliedTs?: string
  failure?: string
  reason?: string
  fixSha?: string
  ciSha?: string
  releasedVersion?: string
  files?: string[]
}

/** Marker signalling a verified fix is ready to be rebuilt into the app. */
export interface UpdateReady {
  id: string
  title: string
  files?: string[]
  diffSummary?: string
  fixSha?: string
  ts: string
}

/** Phase of the local rebuild+swap (doctor:applyUpdate). */
export type RebuildPhase = 'building' | 'swapping' | 'done' | 'failed' | 'dev-reloaded'

export interface RebuildStatus {
  phase: RebuildPhase
  message?: string
}

/** High-level phase of the external auto-repair loop. */
export type LoopPhase = 'idle' | 'analyzing' | 'applying' | 'building' | 'releasing'

/** Snapshot of the app-managed auto-repair loop process. */
export interface LoopStatus {
  running: boolean
  phase: LoopPhase
  lastBuild: 'ok' | 'failed' | null
  available: boolean
  /** ISO ts of the analyzer's last poll/check (even when nothing was found). */
  lastCheckTs?: string | null
  /** True only while an actual analysis pass is in flight right now. */
  analyzing?: boolean
}

/** Live snapshot of the auto-repair QUEUE (timing + current target + counts). */
export interface QueueStatus {
  /** ISO ts of the next allowed repair attempt, or null when none yet. */
  nextAttemptTs: string | null
  /** The loop's rate-limit window (ms), echoed so the renderer needn't hardcode it. */
  minIntervalMs: number
  /** Proposal id currently being repaired, or null. */
  currentId: string | null
  /** Title of the in-flight repair, or null. */
  currentTitle: string | null
  /** 1-based index of the in-flight repair within the current cycle, or null. */
  currentIndex: number | null
  /** Total actionable items in the current cycle (N in "n/N"). */
  queueTotal: number
  /** Remaining actionable items not yet attempted this cycle. */
  pendingCount: number
  updatedTs: string
}

export interface DoctorStatus {
  enabled: boolean
  lastRunTs: string | null
  issues: Report[]
  loop: LoopStatus
  updateReady?: UpdateReady | null
  queue?: QueueStatus | null
  packaged?: boolean
}

/** The `window.canvasio.log` bridge surface (implemented in preload). */
export interface CanvasioLogApi {
  write(entry: LogEntryInput): Promise<void>
}

/** The `window.canvasio.doctor` bridge surface (implemented in preload). */
export interface CanvasioDoctorApi {
  status(): Promise<DoctorStatus>
  runNow(): Promise<{ ok: boolean }>
  setEnabled(enabled: boolean): Promise<{ ok: boolean; enabled: boolean }>
  commitCheckpoint(message: string): Promise<{ ok: boolean; sha?: string; error?: string }>
  approveRepair(id: string): Promise<{ ok: boolean }>
  rejectRepair(id: string): Promise<{ ok: boolean }>
  repairs(): Promise<Repair[]>
  clearHistory(): Promise<{ ok: boolean }>
  logPath(): Promise<string>
  openLog(): Promise<void>
  startLoop(): Promise<{ ok: boolean; running?: boolean; reason?: string }>
  stopLoop(): Promise<{ ok: boolean; running?: boolean }>
  loopStatus(): Promise<LoopStatus>
  updateReady(): Promise<UpdateReady | null>
  applyUpdate(): Promise<{ ok: boolean; mode?: string; error?: string }>
  queueStatus(): Promise<QueueStatus | null>
  onReport(cb: (issues: Report[]) => void): () => void
  onRunning(cb: (running: boolean) => void): () => void
  onLoop(cb: (status: LoopStatus) => void): () => void
  onUpdateReady(cb: (marker: UpdateReady | null) => void): () => void
  onRebuild(cb: (status: RebuildStatus) => void): () => void
  onQueue(cb: (status: QueueStatus | null) => void): () => void
}

/**
 * The `log` + `doctor` bridges are added to `window.canvasio` by the preload (owned
 * by another agent). The base `window.canvasio` type is `CanvasioApi = typeof api`, so
 * we can't structurally augment it here without a property conflict. Instead we
 * expose narrowly-typed accessors that read the (optional) bridges off the live
 * object — mirroring the cast pattern already used in lib/aiActions.ts.
 */
type CanvasioWithExtras = {
  log?: CanvasioLogApi
  doctor?: CanvasioDoctorApi
}

/** Typed accessor for the optional `window.canvasio.log` bridge. */
export function getLogBridge(): CanvasioLogApi | undefined {
  return (window.canvasio as unknown as CanvasioWithExtras | undefined)?.log
}

/** Typed accessor for the optional `window.canvasio.doctor` bridge. */
export function getDoctorBridge(): CanvasioDoctorApi | undefined {
  return (window.canvasio as unknown as CanvasioWithExtras | undefined)?.doctor
}

/**
 * Make a payload JSON-serializable. On failure (cycles, BigInt, etc.) we
 * substitute the agreed-upon sentinel so a write never throws.
 */
function safeData(data: unknown): Record<string, unknown> | undefined {
  if (data == null) return undefined
  try {
    // Round-trip to guarantee structured-clone / JSON safety across the bridge.
    return JSON.parse(JSON.stringify(data)) as Record<string, unknown>
  } catch {
    return { note: 'unserializable payload' }
  }
}

/**
 * Fire-and-forget write to the main-process runtime log. Always best-effort:
 * if the bridge is missing or rejects, we swallow the error so logging can
 * never break the app.
 */
function write(entry: LogEntryInput): void {
  try {
    const bridge = getLogBridge()
    if (!bridge) return
    void bridge
      .write({
        level: entry.level,
        cat: entry.cat,
        msg: entry.msg,
        data: safeData(entry.data)
      })
      .catch(() => {
        /* never throw from logging */
      })
  } catch {
    /* never throw from logging */
  }
}

/**
 * Log a meaningful user action (cat:'action'). Use for high-signal interactions
 * such as opening agents, running the Doctor, approving repairs, etc.
 */
export function logAction(name: string, data?: Record<string, unknown>): void {
  write({ level: 'info', cat: 'action', msg: name, data })
}

/** Convenience renderer-level loggers (cat:'renderer'). */
export const log = {
  debug: (msg: string, data?: Record<string, unknown>) =>
    write({ level: 'debug', cat: 'renderer', msg, data }),
  info: (msg: string, data?: Record<string, unknown>) =>
    write({ level: 'info', cat: 'renderer', msg, data }),
  warn: (msg: string, data?: Record<string, unknown>) =>
    write({ level: 'warn', cat: 'renderer', msg, data }),
  error: (msg: string, data?: Record<string, unknown>) =>
    write({ level: 'error', cat: 'renderer', msg, data })
}

/** Render an arbitrary console argument into a compact, serializable form. */
function describeArg(arg: unknown): unknown {
  if (arg instanceof Error) {
    return { name: arg.name, message: arg.message, stack: arg.stack }
  }
  if (typeof arg === 'object' && arg !== null) return arg
  return arg
}

let initialized = false

/**
 * Install the renderer logging hooks exactly once:
 *  - patches console.error / console.warn to ALSO forward to the runtime log
 *    (the original console behavior is preserved),
 *  - captures window.onerror and unhandledrejection as level:'error' entries.
 *
 * Safe to call multiple times; subsequent calls are no-ops.
 */
export function initRendererLogging(): void {
  if (initialized) return
  initialized = true

  // --- patch console.error / console.warn (preserve originals) ---
  const patch = (level: Extract<LogLevel, 'warn' | 'error'>): void => {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]): void => {
      try {
        original(...args)
      } finally {
        const msg = args
          .map((a) => (typeof a === 'string' ? a : ''))
          .filter(Boolean)
          .join(' ')
          .slice(0, 500)
        write({
          level,
          cat: 'renderer',
          msg: msg || `console.${level}`,
          data: { args: args.map(describeArg) }
        })
      }
    }
  }
  patch('warn')
  patch('error')

  // --- uncaught errors ---
  window.addEventListener('error', (e: ErrorEvent) => {
    write({
      level: 'error',
      cat: 'renderer',
      msg: e.message || 'window.onerror',
      data: {
        message: e.message,
        filename: e.filename,
        lineno: e.lineno,
        colno: e.colno,
        stack: e.error instanceof Error ? e.error.stack : undefined
      }
    })
  })

  // --- unhandled promise rejections ---
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const reason = e.reason
    write({
      level: 'error',
      cat: 'renderer',
      msg: 'unhandledrejection',
      data: {
        reason:
          reason instanceof Error
            ? { name: reason.name, message: reason.message, stack: reason.stack }
            : String(reason)
      }
    })
  })

  log.info('renderer logging initialized', { ua: navigator.userAgent })
}
