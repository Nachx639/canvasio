// Shared helpers to create the file-backed canvas nodes (markdown note / folder)
// from BOTH the Command Palette and the Toolbar icons, so the two entry points
// can never drift. They write into the ACTIVE canvas working folder (cwd) — i.e.
// the project you're currently in — and drop a node onto the canvas pointing at
// the on-disk file/dir. Mirrors the original Command Palette flow exactly.

import { useCanvas, type CanvasNode } from '../store/canvas'
import { activeCanvasCwd } from '../store/workspace'
import { promptText } from '../store/promptModal'
import { t } from '../store/i18n'

interface Pos {
  x: number
  y: number
}

/**
 * Open OR focus a file-backed node, deduplicating on (kind, cwd, filePath/dirPath).
 * If a node for the SAME file/folder already exists on the canvas we REUSE it:
 *   1. Expand it (clear collapsed) if it was minimized to a chip.
 *   2. Select it.
 *   3. Fly the camera to it (centerOnNode also selects + raises to front).
 * Only when no matching node exists do we create a fresh one (at `pos` if given).
 *
 * This is the single chokepoint for ALL file-open entry points (Toolbar,
 * Command Palette, FolderNode click, voice/AI actions) so the same .md/folder
 * never spawns a duplicate icon on the canvas.
 */
export function openOrFocusFileNode(params: {
  kind: 'markdown' | 'folder'
  cwd: string
  filePath?: string
  dirPath?: string
  title: string
  pos?: Pos
}): void {
  const { kind, cwd, filePath, dirPath, title, pos } = params
  const c = useCanvas.getState()

  // Match on kind + cwd + the file/dir path so the SAME on-disk target reuses
  // its existing node instead of stacking a new one.
  const existing = c.nodes.find(
    (n) =>
      n.kind === kind &&
      n.cwd === cwd &&
      (kind === 'markdown' ? n.filePath === filePath : n.dirPath === dirPath)
  )

  if (existing) {
    // Reuse: expand the collapsed chip back into a window, then select + fly.
    if (existing.collapsed) c.updateNode(existing.id, { collapsed: false })
    c.select(existing.id)
    c.centerOnNode(existing.id)
    return
  }

  const nodeData: Partial<CanvasNode> & { kind: 'markdown' | 'folder' } = {
    kind,
    title,
    cwd,
    ...(kind === 'markdown' ? { filePath } : { dirPath }),
    ...(pos ? { x: pos.x, y: pos.y } : {})
  }
  c.addNode(nodeData)
}

/**
 * Open OR focus the SINGLE Calendar node on this canvas. The calendar shows the
 * same global cross-canvas annotations, so a canvas only ever needs one node —
 * reuse the existing one (expand + fly to it) instead of stacking duplicates.
 */
export function openOrFocusCalendar(pos?: Pos): void {
  const c = useCanvas.getState()
  const existing = c.nodes.find((n) => n.kind === 'calendar')
  if (existing) {
    if (existing.collapsed) c.updateNode(existing.id, { collapsed: false })
    c.select(existing.id)
    c.centerOnNode(existing.id)
    return
  }
  c.addNode({ kind: 'calendar', title: t('files.calendar'), ...(pos ? { x: pos.x, y: pos.y } : {}) })
}

/**
 * Create a new `.md` file in the active canvas working folder and drop a
 * Markdown note node onto the canvas pointing at it. Prompts for the name.
 * No-op (with a heads-up) when the canvas has no working folder set.
 */
export async function createMarkdownNote(pos?: Pos): Promise<void> {
  const cwd = activeCanvasCwd()
  if (!cwd) {
    await promptText(t('files.canvas_no_workfolder'), '')
    return
  }
  const name = await promptText(t('files.new_note_name'), 'nueva-nota.md')
  if (!name || !name.trim()) return
  const rel = /\.md$/i.test(name.trim()) ? name.trim() : `${name.trim()}.md`
  const result = await window.canvasio.fs.write(rel, `# ${rel.replace(/\.md$/i, '')}\n\n`, cwd)
  if (!result.ok) {
    await promptText(t('files.create_file_failed'), '')
    return
  }
  // The .md file is written above; dedupe ONLY the node creation — if a node
  // for this name already exists, focus it instead of dropping a duplicate.
  openOrFocusFileNode({
    kind: 'markdown',
    cwd,
    filePath: rel,
    title: rel.split('/').pop() || t('files.note'),
    pos
  })
}

/**
 * Drop a Folder node onto the canvas rooted at the active canvas working folder
 * (the project root). Navigation into subfolders happens inside the node.
 */
export function openProjectFolder(pos?: Pos): void {
  const cwd = activeCanvasCwd()
  if (!cwd) {
    void promptText(t('files.canvas_no_workfolder'), '')
    return
  }
  openOrFocusFileNode({
    kind: 'folder',
    cwd,
    dirPath: '.',
    title: cwd.split('/').pop() || t('files.folder'),
    pos
  })
}
