/**
 * Robust per-SELECTION rich-text styling for the in-place contentEditable editor.
 *
 * Why this exists: the previous code called `Range.surroundContents` directly,
 * which throws on the vast majority of REAL selections (any range whose start /
 * end land in different elements, or that partially covers a node). The throw was
 * swallowed and the style silently did nothing. It also never validated that a
 * usable selection existed BEFORE running a command, so formatting leaked to the
 * whole shape, and it had no way to TOGGLE a property off on a selection.
 *
 * The helpers here are deliberately framework-free DOM utilities (no React, no
 * zustand) so they cannot return fresh objects/arrays from a store selector and
 * therefore cannot trigger React #185. They operate purely on the editor element
 * and the live Selection.
 */

/**
 * True when there is a NON-COLLAPSED selection whose range lives inside `editor`.
 * This is the single gate every per-selection format path must pass before doing
 * anything — if it returns false the caller falls back to whole-shape styling.
 */
export function hasActiveSelection(editor: HTMLElement): boolean {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return false
  const range = sel.getRangeAt(0)
  if (range.collapsed) return false
  return editor.contains(range.commonAncestorContainer)
}

/**
 * Wrap the current selection (inside `editor`) in a <span> carrying one inline
 * CSS style, e.g. applySelectionStyle(el, 'fontSize', '32px'). Returns true when
 * it actually styled something. Falls back from the fast `surroundContents` path
 * to extract+wrap for partial / multi-node ranges, then RE-SELECTS the wrapped
 * span so a follow-up tweak keeps targeting the same text.
 *
 * NOTE: this is used for the per-run FONT SIZE (and any future CSS property that
 * execCommand can't express). B/I/U/color go through execCommandCompat so the
 * browser handles toggle-off; size has no "off" — a new size simply overrides.
 */
export function applySelectionStyle(
  editor: HTMLElement,
  styleKey: 'fontSize' | 'color',
  styleValue: string
): boolean {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return false
  const range = sel.getRangeAt(0)
  if (range.collapsed) return false
  if (!editor.contains(range.commonAncestorContainer)) return false

  const span = document.createElement('span')
  span.style.setProperty(cssName(styleKey), styleValue)

  let wrapped = false
  try {
    // Fast path: works only when the range exactly brackets whole nodes.
    range.surroundContents(span)
    wrapped = true
  } catch {
    // General path: pull the selected fragment out and re-insert it wrapped.
    try {
      span.appendChild(range.extractContents())
      range.insertNode(span)
      wrapped = true
    } catch {
      wrapped = false
    }
  }
  if (!wrapped) return false

  // Remove the SAME style from any descendant spans so the outer span wins and we
  // don't leave stale per-run sizes nested inside (otherwise extraction would read
  // the innermost value and the new size wouldn't stick on follow-up changes).
  span.querySelectorAll('span').forEach((child) => {
    ;(child as HTMLElement).style.removeProperty(cssName(styleKey))
  })

  // Re-select the wrapped contents so repeated +/- keeps acting on this text.
  const newRange = document.createRange()
  newRange.selectNodeContents(span)
  sel.removeAllRanges()
  sel.addRange(newRange)
  return true
}

function cssName(key: 'fontSize' | 'color'): string {
  return key === 'fontSize' ? 'font-size' : 'color'
}

/**
 * Save the current selection as plain text-node offsets relative to `el` (a
 * pre-order walk over text nodes). Survives a blur+refocus where the live Range
 * is lost. Returns null when there is no selection inside the editor.
 */
export function saveEditorSelection(el: HTMLElement): { start: number; end: number } | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!el.contains(range.commonAncestorContainer)) return null
  let offset = 0
  let start = 0
  let end = 0
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = tw.nextNode())) {
    const textNode = node as Text
    if (node === range.startContainer) start = offset + range.startOffset
    if (node === range.endContainer) end = offset + range.endOffset
    offset += textNode.length
  }
  return { start, end }
}

/** Restore a selection saved by saveEditorSelection back onto `el`. */
export function restoreEditorSelection(
  el: HTMLElement,
  saved: { start: number; end: number }
): void {
  let offset = 0
  let startNode: Text | null = null
  let startOff = 0
  let endNode: Text | null = null
  let endOff = 0
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = tw.nextNode())) {
    const textNode = node as Text
    const preEnd = offset + textNode.length
    if (!startNode && offset <= saved.start && saved.start <= preEnd) {
      startNode = textNode
      startOff = saved.start - offset
    }
    if (!endNode && offset <= saved.end && saved.end <= preEnd) {
      endNode = textNode
      endOff = saved.end - offset
    }
    offset = preEnd
  }
  if (startNode && endNode) {
    const r = document.createRange()
    r.setStart(startNode, startOff)
    r.setEnd(endNode, endOff)
    const sel = window.getSelection()
    if (sel) {
      sel.removeAllRanges()
      sel.addRange(r)
    }
  }
}
