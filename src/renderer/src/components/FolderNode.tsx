import { useEffect, useState } from 'react'
import { CanvasNode, useCanvas } from '../store/canvas'
import { openOrFocusFileNode } from '../lib/fileNodes'
import { useT } from '../store/i18n'

/** Mirrors the main-process fs:list entry shape (preload FsListEntry). */
interface FolderEntry {
  name: string
  path: string
  isDir: boolean
  size: number
}

/** File extensions opened as readable text in a markdown note node. */
const TEXT_EXT = /\.(md|markdown|txt|json|jsonc|ya?ml|toml|ini|cfg|conf|log|csv|tsv|ts|tsx|js|jsx|mjs|cjs|css|scss|html?|xml|sh|py|rb|go|rs|c|h|cpp|hpp|java|swift|kt|sql|env|gitignore|editorconfig)$/i

// dirPath/filePath are stored RELATIVE to the node's `cwd` base (the canvas
// folder); '.' (or '') is the folder root. The main-process fs bridge resolves
// + traversal-validates every path against cwd, so we keep paths relative here
// and never hand it an absolute path (which it rejects).

/** Join a relative directory path and a child name. Normalizes the root '.'. */
function joinPath(dir: string, name: string): string {
  if (!dir || dir === '.') return name
  return dir.endsWith('/') ? dir + name : dir + '/' + name
}

/** Parent of a relative dir path, or null when already at the root. */
function parentPath(dir: string): string | null {
  const trimmed = dir.replace(/\/+$/, '')
  if (!trimmed || trimmed === '.') return null
  const idx = trimmed.lastIndexOf('/')
  return idx < 0 ? '.' : trimmed.slice(0, idx)
}

/** Last path segment for display/titles. */
function baseName(dir: string): string {
  const trimmed = dir.replace(/\/+$/, '')
  if (!trimmed || trimmed === '.') return ''
  return trimmed.split('/').pop() || trimmed
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Folder browser node — Finder-like listing of its `dirPath` (read via the
 * main-process fs bridge, traversal-validated in main). Clicking a directory
 * navigates the SAME node into it (updateNode dirPath, so the navigation
 * persists with the canvas). Clicking a readable file opens it in a NEW markdown
 * note node placed just to the right of this folder node. The body is
 * TRANSLUCENT liquid-glass (rgba(--glass-term-tint), --glass-term-alpha), so the
 * in-world <NodeFrost> rendered behind it by NodeView shows through — identical
 * glass to a terminal. Rows keep their own bright text for legibility.
 */
export function FolderNode({ node }: { node: CanvasNode }): JSX.Element {
  const t = useT()
  const dirPath = node.dirPath || ''
  const cwd = node.cwd
  const [entries, setEntries] = useState<FolderEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const updateNode = useCanvas((s) => s.updateNode)

  useEffect(() => {
    if (!dirPath) {
      setError(t('files.browser_no_folder'))
      setLoading(false)
      return
    }

    let active = true
    setLoading(true)
    const load = async (): Promise<void> => {
      const list = await window.canvasio.fs.list(dirPath, cwd)
      if (!active) return
      if (list === null) {
        setError(t('files.read_folder_failed', { path: dirPath }))
        setEntries([])
      } else {
        setEntries(list)
        setError(null)
      }
      setLoading(false)
    }
    void load()
    return () => {
      active = false
    }
  }, [dirPath, cwd])

  const navigateTo = (target: string): void => {
    updateNode(node.id, {
      dirPath: target,
      title: baseName(target) || cwd?.split('/').pop() || t('files.folder')
    })
  }

  const openFile = (entry: FolderEntry): void => {
    if (!cwd) return
    const full = joinPath(dirPath, entry.name)
    // Reuse an already-open note for this file (focus + fly) instead of stacking
    // a duplicate; only create one placed just to the right of this folder node.
    openOrFocusFileNode({
      kind: 'markdown',
      cwd,
      filePath: full,
      title: entry.name,
      pos: { x: node.x + node.w + 24, y: node.y }
    })
  }

  const handleClick = (entry: FolderEntry): void => {
    if (entry.isDir) navigateTo(joinPath(dirPath, entry.name))
    else openFile(entry)
  }

  const parent = parentPath(dirPath)
  // Show a friendly breadcrumb: the canvas folder name for the root, else the
  // relative path under it.
  const rootName = cwd?.split('/').pop() || t('files.folder')
  const crumb = !dirPath || dirPath === '.' ? rootName : `${rootName}/${dirPath}`

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'rgba(var(--glass-term-tint), var(--glass-term-alpha))',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif'
      }}
    >
      <div
        title={crumb}
        style={{
          flex: '0 0 auto',
          padding: '7px 12px',
          borderBottom: '1px solid rgba(120,150,220,0.14)',
          fontSize: 11,
          color: 'var(--canvasio-subtext)',
          display: 'flex',
          alignItems: 'center',
          gap: 6
        }}
      >
        {parent && (
          <button
            title={t('files.up_one_level')}
            aria-label={t('files.up_one_level')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              navigateTo(parent)
            }}
            style={{
              flex: '0 0 auto',
              background: 'rgba(120,150,220,0.16)',
              border: '1px solid rgba(120,150,220,0.3)',
              borderRadius: 6,
              color: '#cfe0ff',
              cursor: 'pointer',
              fontSize: 11,
              lineHeight: 1,
              padding: '3px 7px'
            }}
          >
            ↑
          </button>
        )}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontWeight: 600
          }}
        >
          {crumb}
        </span>
      </div>

      <div
        data-canvas-scroll
        onWheel={(e) => e.stopPropagation()}
        style={{ flex: 1, minHeight: 0, overflow: 'auto', fontSize: 12, color: '#cfe0ff' }}
      >
        {loading ? (
          <div style={{ color: 'var(--canvasio-subtext)', padding: '12px 14px' }}>{t('files.loading')}</div>
        ) : error ? (
          <div
            style={{
              color: '#ff8a8a',
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              padding: '12px 14px'
            }}
          >
            {error}
          </div>
        ) : entries && entries.length ? (
          entries.map((entry) => {
            const isMd = /\.(md|markdown)$/i.test(entry.name)
            const openable = entry.isDir || TEXT_EXT.test(entry.name)
            return (
              <div
                key={entry.path || entry.name}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  if (openable) handleClick(entry)
                }}
                style={{
                  padding: '6px 12px',
                  borderBottom: '1px solid rgba(120,150,220,0.07)',
                  cursor: openable ? 'pointer' : 'default',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  color: entry.isDir ? '#9bc0ff' : openable ? '#cfe0ff' : '#7e8bab',
                  userSelect: 'none'
                }}
                onMouseEnter={(e) => {
                  if (openable) e.currentTarget.style.background = 'rgba(120,150,220,0.1)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <span style={{ flex: '0 0 auto' }}>
                  {entry.isDir ? '📁' : isMd ? '📝' : '📄'}
                </span>
                <span
                  style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {entry.name}
                </span>
                {!entry.isDir && (
                  <span style={{ flex: '0 0 auto', fontSize: 10, color: '#5b6887' }}>
                    {humanSize(entry.size)}
                  </span>
                )}
              </div>
            )
          })
        ) : (
          <div style={{ color: '#5b6887', fontStyle: 'italic', padding: '12px 14px' }}>
            {t('files.empty_folder')}
          </div>
        )}
      </div>
    </div>
  )
}
