import { useEffect, useRef, useState } from 'react'
import { CanvasNode } from '../store/canvas'
import { renderMarkdown } from '../lib/markdownRender'
import { useT } from '../store/i18n'

/** Window (ms) after a LOCAL write during which watcher-fired reloads are
 *  suppressed, so our own save doesn't clobber the textarea/cursor. Genuine
 *  EXTERNAL edits land after this window and still live-reload. Kept a touch
 *  above the debounce delay so the post-write watch event is reliably ignored. */
const LOCAL_WRITE_QUIET_MS = 1200
/** Debounce delay (ms) between keystrokes and the save-to-disk write. */
const WRITE_DEBOUNCE_MS = 800

/**
 * Markdown Note node — renders its `filePath` as a clean macOS-style preview and
 * lets you EDIT it in place. A header toggle switches between the rendered
 * preview and a raw-markdown <textarea> bound to the file; edits are written to
 * disk via window.canvasio.fs.write (debounced), resolved against the node's `cwd`
 * and traversal-validated in main. The file is read via the fs bridge
 * (window.canvasio.fs.read) and re-read on every disk change via a per-file watcher
 * (fs.watch.start -> onChange) — but reloads fired within a short window after
 * OUR OWN write are SUPPRESSED so typing/cursor is never clobbered, while real
 * EXTERNAL changes still live-reload. The watcher is disarmed on unmount / when
 * the file path changes, so a closed or re-pointed note never leaks a watcher.
 * Body is TRANSLUCENT frosted glass (the same neutral tint as a terminal,
 * `rgba(var(--glass-term-tint), var(--glass-term-alpha))`) so the in-world
 * <NodeFrost> canvas NodeView renders behind it (zIndex:0) shows through. The
 * markdown/editor text sits on top and stays crisp/legible over the frost.
 */
export function MarkdownNode({ node }: { node: CanvasNode }): JSX.Element {
  const t = useT()
  const [content, setContent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [isEditing, setIsEditing] = useState(false)
  const filePath = node.filePath
  const cwd = node.cwd
  const fileName = filePath ? filePath.split('/').pop() || filePath : ''

  // Timestamp of the last LOCAL write (in a ref so the watcher callback and the
  // debounce timer always read the latest value without re-arming effects).
  const lastLocalWriteTs = useRef(0)
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Latest debounced-but-not-yet-saved text, so we can FLUSH it on unmount /
  // file change (minimize, switch canvas, close) instead of losing it.
  const pendingText = useRef<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Debounced save-to-disk. Stamps lastLocalWriteTs at write time AND on
  // completion so the watcher's quiet-window covers both the scheduling moment
  // and the (async) fs event that the write triggers.
  const scheduleWrite = (text: string): void => {
    if (!filePath) return
    pendingText.current = text
    if (writeTimer.current) clearTimeout(writeTimer.current)
    writeTimer.current = setTimeout(() => {
      writeTimer.current = null
      lastLocalWriteTs.current = Date.now()
      void window.canvasio.fs
        .write(filePath, text, cwd)
        .then(() => {
          lastLocalWriteTs.current = Date.now()
          pendingText.current = null
        })
        .catch(() => {
          /* ignore transient write errors; next keystroke retries */
        })
    }, WRITE_DEBOUNCE_MS)
  }

  const onContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const next = e.target.value
    setContent(next)
    scheduleWrite(next)
  }

  // Last-chance SYNCHRONOUS flush on app close / window hide. The unmount cleanup
  // below uses an async write that the renderer may not finish while tearing down
  // on quit, so a sub-debounce edit made right before quitting could be lost. A
  // sendSync write blocks until it lands. (Minimize/switch are already covered by
  // the unmount flush; this adds the quit case.)
  useEffect(() => {
    const flush = (): void => {
      if (pendingText.current != null && filePath) {
        try {
          window.canvasio.fs.writeSync?.(filePath, pendingText.current, cwd)
          pendingText.current = null
        } catch {
          /* ignore */
        }
      }
    }
    window.addEventListener('beforeunload', flush)
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener('pagehide', flush)
    }
  }, [filePath, cwd])

  // Focus + place caret at the end when entering edit mode.
  useEffect(() => {
    if (isEditing) {
      const ta = textareaRef.current
      if (ta) {
        ta.focus()
        const end = ta.value.length
        try {
          ta.setSelectionRange(end, end)
        } catch {
          /* ignore */
        }
      }
    }
  }, [isEditing])

  useEffect(() => {
    if (!filePath) {
      setError(t('files.note_no_path'))
      setLoading(false)
      return
    }

    let active = true
    let unsubscribe: (() => void) | null = null
    let token: string | null = null

    const load = async (): Promise<void> => {
      const text = await window.canvasio.fs.read(filePath, cwd)
      if (!active) return
      if (text === null) {
        setError(t('files.read_file_failed', { path: filePath }))
        setContent('')
      } else {
        setContent(text)
        setError(null)
      }
      setLoading(false)
    }

    void load()

    // Live-reload: arm a watcher on the file and re-read on every change —
    // EXCEPT within LOCAL_WRITE_QUIET_MS of our own write, so saving our edits
    // doesn't bounce back and clobber the textarea/cursor. External edits land
    // after the quiet window and reload normally.
    void (async () => {
      const result = await window.canvasio.fs.watch.start(filePath, cwd)
      if (!active) {
        // Component unmounted before the watcher armed — stop it immediately.
        if ('token' in result) void window.canvasio.fs.watch.stop(result.token)
        return
      }
      if ('token' in result) {
        token = result.token
        unsubscribe = window.canvasio.fs.watch.onChange(result.token, () => {
          if (Date.now() - lastLocalWriteTs.current < LOCAL_WRITE_QUIET_MS) return
          void load()
        })
      }
    })()

    return () => {
      active = false
      if (unsubscribe) unsubscribe()
      if (token) void window.canvasio.fs.watch.stop(token)
      if (writeTimer.current) {
        clearTimeout(writeTimer.current)
        writeTimer.current = null
      }
      // FLUSH any pending edit so closing/minimizing/switching before the debounce
      // never loses the last changes.
      if (pendingText.current != null && filePath) {
        void window.canvasio.fs.write(filePath, pendingText.current, cwd).catch(() => {})
        pendingText.current = null
      }
    }
  }, [filePath, cwd])

  return (
    <div
      className="markdown-node-surface"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
        // Background comes from .markdown-node-surface: the SAME translucent
        // glass tint as a terminal so the <NodeFrost> behind it (zIndex:0) shows.
      }}
    >
      <div
        title={filePath || ''}
        style={{
          flex: '0 0 auto',
          padding: '7px 12px',
          borderBottom: '1px solid rgba(120,150,220,0.14)',
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--canvasio-subtext)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          display: 'flex',
          alignItems: 'center',
          gap: 6
        }}
      >
        <span style={{ flex: '0 0 auto' }}>📝</span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {fileName || t('files.note')}
        </span>
        {!error && !!filePath && (
          <button
            title={isEditing ? t('files.preview') : t('files.edit')}
            aria-label={isEditing ? t('files.preview') : t('files.edit')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              setIsEditing((v) => !v)
            }}
            style={{
              flex: '0 0 auto',
              background: isEditing
                ? 'rgba(122,162,255,0.22)'
                : 'rgba(120,150,220,0.14)',
              border: '1px solid rgba(120,150,220,0.3)',
              borderRadius: 6,
              color: '#cfe0ff',
              cursor: 'pointer',
              fontSize: 11,
              lineHeight: 1,
              padding: '3px 7px'
            }}
          >
            {isEditing ? '👁' : '✏️'}
          </button>
        )}
      </div>

      {isEditing && !loading && !error ? (
        // Raw-markdown editor bound to the file. onChange writes through to disk
        // (debounced); pointer/wheel events are kept inside the textarea so
        // typing/scrolling/selecting never drags the node behind it.
        <textarea
          ref={textareaRef}
          value={content}
          onChange={onContentChange}
          onPointerDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
          data-canvas-scroll
          placeholder={t('files.write_here')}
          spellCheck={false}
          style={{
            flex: 1,
            minHeight: 0,
            width: '100%',
            boxSizing: 'border-box',
            overflow: 'auto',
            padding: '8px 18px 18px',
            fontSize: 13,
            lineHeight: 1.5,
            fontFamily:
              'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
            color: '#cfe0ff',
            // Transparent so the translucent surface + NodeFrost behind it show
            // through as one frosted-glass plane; mono text stays crisp on top.
            background: 'transparent',
            border: 'none',
            borderTop: '1px solid rgba(var(--glass-spec), 0.05)',
            resize: 'none',
            outline: 'none'
          }}
        />
      ) : (
        <div
          data-canvas-scroll
          onWheel={(e) => e.stopPropagation()}
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
            padding: '8px 18px 18px',
            fontSize: 13,
            color: '#cfe0ff',
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif'
          }}
        >
          {loading ? (
            <div style={{ color: 'var(--canvasio-subtext)', fontSize: 13, padding: '12px 0' }}>{t('files.loading')}</div>
          ) : error ? (
            <div
              style={{
                color: '#ff8a8a',
                fontSize: 12,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                padding: '12px 0'
              }}
            >
              {error}
            </div>
          ) : content.trim() ? (
            renderMarkdown(content)
          ) : (
            <div style={{ color: '#5b6887', fontSize: 12, fontStyle: 'italic', padding: '12px 0' }}>
              {t('files.empty_file')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
