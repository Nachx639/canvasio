import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

// --- Multi-Canvas Workspace wire types ---------------------------------------
// Duplicated literal copies (the JSON shape is the binding contract; main has a
// structurally identical set). These flow to the renderer via CanvasioApi=typeof api.
interface CanvasData {
  nodes: unknown[]
  waypoints: unknown[]
  regions: unknown[]
  stages: unknown[]
  shapes: unknown[]
}
interface CanvasDoc {
  id: string
  name: string
  createdTs: number
  updatedTs: number
  schema: 1
  cwd?: string
  data: CanvasData
}
interface CanvasMeta {
  id: string
  name: string
  updatedTs: number
  cwd?: string
}

// --- File-system bridge wire type (structurally identical to the main copy) ---
interface FsListEntry {
  name: string
  path: string
  isDir: boolean
  size: number
}

const api = {
  platform: () => ipcRenderer.invoke('app:platform'),
  home: () => ipcRenderer.invoke('app:home'),
  // Native folder picker for the active canvas working folder (cwd). Resolves to
  // the chosen absolute path, or null on cancel/error.
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('app:chooseFolder'),

  pty: {
    spawn: (opts: {
      id: string
      cwd?: string
      cols?: number
      rows?: number
      shell?: string
      command?: string
      env?: Record<string, string>
    }) => ipcRenderer.invoke('pty:spawn', opts),
    write: (id: string, data: string) => ipcRenderer.send('pty:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: string) => ipcRenderer.send('pty:kill', id),
    onData: (id: string, cb: (data: string) => void) => {
      const ch = `pty:data:${id}`
      const handler = (_e: IpcRendererEvent, data: string): void => cb(data)
      ipcRenderer.on(ch, handler)
      return () => ipcRenderer.removeListener(ch, handler)
    },
    onExit: (id: string, cb: (code: number) => void) => {
      const ch = `pty:exit:${id}`
      const handler = (_e: IpcRendererEvent, code: number): void => cb(code)
      ipcRenderer.on(ch, handler)
      return () => ipcRenderer.removeListener(ch, handler)
    }
  },

  voice: {
    capabilities: () => ipcRenderer.invoke('voice:capabilities'),
    ensureModel: () => ipcRenderer.invoke('voice:ensureModel'),
    // STT/TTS accept an optional app language ('es'|'en'|'pt'|'zh'). Main maps it
    // to the whisper `-l` code and the per-language Piper voice (downloaded on
    // first use), falling back to the es voice / macOS `say` on failure. Absent
    // or invalid lang defaults to 'es' (backward compatible).
    stt: (audioBase64: string, mime: string, lang?: 'es' | 'en' | 'pt' | 'zh') =>
      ipcRenderer.invoke('voice:stt', { audioBase64, mime, lang }),
    tts: (text: string, voice?: string, lang?: 'es' | 'en' | 'pt' | 'zh') =>
      ipcRenderer.invoke('voice:tts', { text, voice, lang }),
    warm: () => ipcRenderer.invoke('voice:warm'),
    onModelProgress: (cb: (pct: number) => void) => {
      const handler = (_e: IpcRendererEvent, pct: number): void => cb(pct)
      ipcRenderer.on('voice:modelProgress', handler)
      return () => ipcRenderer.removeListener('voice:modelProgress', handler)
    },
    // Fired by the main-process global shortcut (works even when unfocused).
    onToggle: (cb: () => void) => {
      const handler = (): void => cb()
      ipcRenderer.on('voice:toggle', handler)
      return () => ipcRenderer.removeListener('voice:toggle', handler)
    }
  },

  ai: {
    command: (text: string, context: string, lang?: string) =>
      ipcRenderer.invoke('ai:command', { text, context, lang }),
    available: () => ipcRenderer.invoke('ai:available'),
    logPath: () => ipcRenderer.invoke('ai:logPath'),
    resetSession: () => ipcRenderer.invoke('ai:resetSession'),
    // Auto-compaction notice: main fires `ai:compacting` (true while it summarizes
    // the conversation and swaps to a fresh session, false when done). Mirrors the
    // notify.onFocusNode subscription shape; returns an unsubscribe.
    onCompacting: (cb: (active: boolean) => void) => {
      const handler = (_e: IpcRendererEvent, active: boolean): void => cb(active)
      ipcRenderer.on('ai:compacting', handler)
      return () => ipcRenderer.removeListener('ai:compacting', handler)
    }
  },

  // Voice web lookup bridge. answer(query) fetches a spoken answer for a
  // factual / weather question (weather auto-detected from the Spanish query)
  // so the voice agent can SPEAK it without opening a web node. Resolves to
  // { ok:true, text } or { ok:false, reason }; never throws.
  // Exact renderer access: window.canvasio.web.answer(query).
  web: {
    answer: (query: string): Promise<{ ok: boolean; text?: string; reason?: string }> =>
      ipcRenderer.invoke('web:answer', { query })
  },

  // Agent session recovery helpers.
  session: {
    // Returns the UUID of the newest Codex rollout written at/after `sinceMs`,
    // or null. Used to capture a fresh Codex session id so it can be resumed.
    detectCodex: (sinceMs: number): Promise<string | null> =>
      ipcRenderer.invoke('session:detectCodex', sinceMs),
    // Returns the UUID of the newest Claude session (~/.claude/projects/<cwd>/<uuid>.jsonl)
    // written at/after `sinceMs`, scoped to `cwd` when given, or null. Captures a
    // fresh Claude session id so a restored terminal can `claude --resume <id>`.
    detectClaude: (sinceMs: number, cwd?: string): Promise<string | null> =>
      ipcRenderer.invoke('session:detectClaude', sinceMs, cwd),
    // Pre-accept Claude Code's per-folder "Is this a project you trust?" prompt for
    // `cwd` (writes projects[<cwd>].hasTrustDialogAccepted=true in ~/.claude.json)
    // so an interactive claude spawned there boots straight to its prompt instead
    // of blocking on the trust dialog and exiting. Returns true when trusted.
    claudeTrust: (cwd?: string): Promise<boolean> =>
      ipcRenderer.invoke('session:claudeTrust', cwd),
    // Returns the sessionId of the newest ~/.claude/history.jsonl entry whose
    // `project` matches `cwd` and whose timestamp is >= `sinceMs`, or null. This
    // recovers the REAL id of an interactive claude session (which 2.1.179 does
    // NOT persist as a projects/<cwd>/<uuid>.jsonl transcript) so a restored
    // terminal can `claude --resume <id>` it.
    detectClaudeHistory: (sinceMs: number, cwd?: string): Promise<string | null> =>
      ipcRenderer.invoke('session:detectClaudeHistory', sinceMs, cwd)
  },

  // Structured runtime logging from the renderer. Main stamps `ts` and forces
  // the category to 'renderer' | 'action'.
  log: {
    write: (entry: {
      level: 'debug' | 'info' | 'warn' | 'error'
      cat: 'renderer' | 'action'
      msg: string
      data?: unknown
    }) => ipcRenderer.invoke('log:write', entry)
  },

  // Self-healing Doctor: background diagnostics + the file-based repair handshake.
  doctor: {
    status: () => ipcRenderer.invoke('doctor:status'),
    runNow: () => ipcRenderer.invoke('doctor:runNow'),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('doctor:setEnabled', enabled),
    commitCheckpoint: (message: string) =>
      ipcRenderer.invoke('doctor:commitCheckpoint', message),
    approveRepair: (id: string) => ipcRenderer.invoke('doctor:approveRepair', id),
    rejectRepair: (id: string) => ipcRenderer.invoke('doctor:rejectRepair', id),
    repairs: () => ipcRenderer.invoke('doctor:repairs'),
    clearHistory: () => ipcRenderer.invoke('doctor:clearHistory'),
    logPath: () => ipcRenderer.invoke('doctor:logPath'),
    openLog: () => ipcRenderer.invoke('doctor:openLog'),
    // Auto-repair loop process control + status.
    startLoop: () => ipcRenderer.invoke('doctor:startLoop'),
    stopLoop: () => ipcRenderer.invoke('doctor:stopLoop'),
    loopStatus: () => ipcRenderer.invoke('doctor:loopStatus'),
    // Local rebuild flow: read the update-ready marker + confirm rebuild+reopen.
    updateReady: () => ipcRenderer.invoke('doctor:updateReady'),
    applyUpdate: () => ipcRenderer.invoke('doctor:applyUpdate'),
    // Repair-queue timing snapshot (pending / current target / next-attempt).
    queueStatus: () => ipcRenderer.invoke('doctor:queueStatus'),
    onReport: (cb: (issues: unknown[]) => void) => {
      const handler = (_e: IpcRendererEvent, issues: unknown[]): void => cb(issues)
      ipcRenderer.on('doctor:report', handler)
      return () => ipcRenderer.removeListener('doctor:report', handler)
    },
    onRunning: (cb: (running: boolean) => void) => {
      const handler = (_e: IpcRendererEvent, running: boolean): void => cb(running)
      ipcRenderer.on('doctor:running', handler)
      return () => ipcRenderer.removeListener('doctor:running', handler)
    },
    onLoop: (cb: (status: unknown) => void) => {
      const handler = (_e: IpcRendererEvent, status: unknown): void => cb(status)
      ipcRenderer.on('doctor:loop', handler)
      return () => ipcRenderer.removeListener('doctor:loop', handler)
    },
    onUpdateReady: (cb: (marker: unknown) => void) => {
      const handler = (_e: IpcRendererEvent, marker: unknown): void => cb(marker)
      ipcRenderer.on('doctor:updateReady', handler)
      return () => ipcRenderer.removeListener('doctor:updateReady', handler)
    },
    onRebuild: (cb: (status: unknown) => void) => {
      const handler = (_e: IpcRendererEvent, status: unknown): void => cb(status)
      ipcRenderer.on('doctor:rebuild', handler)
      return () => ipcRenderer.removeListener('doctor:rebuild', handler)
    },
    onQueue: (cb: (status: unknown) => void) => {
      const handler = (_e: IpcRendererEvent, status: unknown): void => cb(status)
      ipcRenderer.on('doctor:queue', handler)
      return () => ipcRenderer.removeListener('doctor:queue', handler)
    }
  },

  // Auto-update bridge. In dev these are graceful no-ops on the main side; the
  // on* subscribers each return an unsubscribe function.
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    install: () => ipcRenderer.invoke('updater:install'),
    onAvailable: (cb: (version: string) => void) => {
      const handler = (_e: IpcRendererEvent, version: string): void => cb(version)
      ipcRenderer.on('updater:available', handler)
      return () => ipcRenderer.removeListener('updater:available', handler)
    },
    onProgress: (cb: (percent: number) => void) => {
      const handler = (_e: IpcRendererEvent, percent: number): void => cb(percent)
      ipcRenderer.on('updater:progress', handler)
      return () => ipcRenderer.removeListener('updater:progress', handler)
    },
    onDownloaded: (cb: (version: string) => void) => {
      const handler = (_e: IpcRendererEvent, version: string): void => cb(version)
      ipcRenderer.on('updater:downloaded', handler)
      return () => ipcRenderer.removeListener('updater:downloaded', handler)
    },
    onError: (cb: (message: string) => void) => {
      const handler = (_e: IpcRendererEvent, message: string): void => cb(message)
      ipcRenderer.on('updater:error', handler)
      return () => ipcRenderer.removeListener('updater:error', handler)
    }
  },

  // Changeset Lens — read-only git bridge (status badges + inline diff review +
  // reveal). Mirrors the doctor/ai invoke blocks. Every call resolves to
  // null/false on any main-side failure, so the renderer degrades to "no data".
  git: {
    status: (
      cwd: string
    ): Promise<{
      files: Array<{ path: string; status: string; adds: number; dels: number }>
      adds: number
      dels: number
    } | null> => ipcRenderer.invoke('git:status', cwd),
    diff: (cwd: string, path: string): Promise<string | null> =>
      ipcRenderer.invoke('git:diff', { cwd, path }),
    revealFile: (cwd: string, path: string): Promise<boolean> =>
      ipcRenderer.invoke('git:revealFile', { cwd, path }),

    // Checkpoints — one-key restorable savepoints per agent. create/list/diff are
    // non-mutating; restore is gated behind a main-process confirm dialog and is
    // the only write. Each resolves to null/[]/{ok:false} on any failure.
    checkpoints: {
      create: (
        cwd: string,
        label?: string
      ): Promise<{
        sha: string
        short: string
        ts: number
        files: number
        adds: number
        dels: number
      } | null> => ipcRenderer.invoke('git:checkpoint:create', { cwd, label }),
      list: (
        cwd: string
      ): Promise<Array<{
        sha: string
        short: string
        ts: number
        files: number
        adds: number
        dels: number
      }> | null> => ipcRenderer.invoke('git:checkpoint:list', cwd),
      diff: (cwd: string, sha: string): Promise<string | null> =>
        ipcRenderer.invoke('git:checkpoint:diff', { cwd, sha }),
      restore: (
        cwd: string,
        sha: string,
        label?: string
      ): Promise<{ ok: boolean; conflicted: boolean }> =>
        ipcRenderer.invoke('git:checkpoint:restore', { cwd, sha, label })
    }
  },

  // yt-dlp resolver for the YouTube Music node. Resolves a video id (or YouTube
  // URL) to a single directly-playable progressive stream URL + title + duration
  // so the renderer can play it in a native <video> element, bypassing embed
  // restrictions. Resolves to { ok:false, reason } on any failure (never throws).
  // Exact renderer access: window.canvasio.ytdlp.resolve(videoIdOrUrl).
  ytdlp: {
    resolve: (
      videoIdOrUrl: string
    ): Promise<{
      ok: boolean
      url?: string
      title?: string
      duration?: number
      reason?: string
    }> => ipcRenderer.invoke('ytdlp:resolve', videoIdOrUrl)
  },

  // Selectable video backgrounds: list user-staged videos in the managed
  // backgrounds folder. Each entry is served over the canvasio-bg:// scheme.
  bg: {
    list: (): Promise<Array<{ id: string; name: string; hasBoom: boolean }>> =>
      ipcRenderer.invoke('bg:list')
  },

  // Multi-Canvas Workspace — fs-backed named canvas documents under
  // <userData>/canvases. Mirrors the git/doctor invoke blocks: every call
  // resolves to null/[]/{ok:false} on any main-side failure (never throws).
  // Exact renderer access: window.canvasio.canvases.{list,read,write,remove,rename}.
  canvases: {
    list: (): Promise<CanvasMeta[]> => ipcRenderer.invoke('canvases:list'),
    read: (id: string): Promise<CanvasDoc | null> => ipcRenderer.invoke('canvases:read', id),
    write: (id: string, doc: CanvasDoc): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('canvases:write', { id, doc }),
    // SYNCHRONOUS write for the quit/window-close flush — blocks until the doc is
    // on disk so the last edits aren't lost as the renderer tears down (audit #1).
    writeSync: (id: string, doc: CanvasDoc): { ok: boolean } =>
      ipcRenderer.sendSync('canvases:write-sync', { id, doc }),
    remove: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('canvases:delete', id),
    rename: (id: string, name: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('canvases:rename', { id, name })
  },

  // File-system bridge — backs the Markdown note + Folder browser nodes. Mirrors
  // the canvases/git invoke blocks: every call resolves to null/false/{ok:false}
  // on any main-side failure (never throws). All paths are resolved against `cwd`
  // (defaults to the user's home dir) in the main process and validated against
  // traversal. Exact renderer access: window.canvasio.fs.{read,write,list,exists} and
  // window.canvasio.fs.watch.{start,stop,onChange}.
  fs: {
    read: (path: string, cwd?: string): Promise<string | null> =>
      ipcRenderer.invoke('fs:read', path, cwd),
    write: (path: string, content: string, cwd?: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('fs:write', path, content, cwd),
    // SYNCHRONOUS write — used only for the last-chance flush on app close, where an
    // async IPC may not finish before the renderer tears down. Blocks until written.
    writeSync: (path: string, content: string, cwd?: string): { ok: boolean } =>
      ipcRenderer.sendSync('fs:write-sync', path, content, cwd),
    list: (dirPath: string, cwd?: string): Promise<FsListEntry[] | null> =>
      ipcRenderer.invoke('fs:list', dirPath, cwd),
    exists: (path: string, cwd?: string): Promise<boolean> =>
      ipcRenderer.invoke('fs:exists', path, cwd),
    watch: {
      // Arm a watcher; resolves to a token to pass to stop()/onChange(), or an
      // { error } object if the path is invalid / the watch could not start.
      start: (path: string, cwd?: string): Promise<{ token: string } | { error: string }> =>
        ipcRenderer.invoke('fs:watch:start', path, cwd),
      stop: (token: string): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('fs:watch:stop', token),
      // Subscribe to debounced `fs:changed:<token>` change events. Returns an
      // unsubscribe function (mirrors pty.onData / notify.onFocusNode).
      onChange: (token: string, cb: () => void): (() => void) => {
        const ch = `fs:changed:${token}`
        const handler = (): void => cb()
        ipcRenderer.on(ch, handler)
        return () => ipcRenderer.removeListener(ch, handler)
      }
    }
  },

  // Away Alerts — one-way native OS notification bridge. `agent` raises a macOS
  // Notification + sets the dock badge to `count`; `clearBadge` clears it. Both
  // mirror the fire-and-forget pty.write pattern (ipcRenderer.send). The main side
  // is fully guarded (Notification.isSupported / app.dock), so these are graceful
  // no-ops on platforms / contexts without native support. onFocusNode subscribes
  // to the click-through that focuses the window and asks the renderer to fly the
  // camera to the agent; it returns an unsubscribe like every other on* here.
  notify: {
    agent: (p: { title: string; body: string; nodeId?: string; count?: number }) =>
      ipcRenderer.send('notify:agent', p),
    clearBadge: () => ipcRenderer.send('notify:clearBadge'),
    onFocusNode: (cb: (nodeId: string) => void) => {
      const handler = (_e: IpcRendererEvent, nodeId: string): void => cb(nodeId)
      ipcRenderer.on('notify:focus-node', handler)
      return () => ipcRenderer.removeListener('notify:focus-node', handler)
    }
  },

  onWindowResized: (cb: () => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('window:resized', handler)
    return () => ipcRenderer.removeListener('window:resized', handler)
  }
}

contextBridge.exposeInMainWorld('canvasio', api)

export type CanvasioApi = typeof api
