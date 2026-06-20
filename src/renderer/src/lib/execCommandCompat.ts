/**
 * execCommand compatibility helpers.
 *
 * The legacy `document.execCommand` API is the most reliable way to toggle
 * bold/italic/underline on an arbitrary contentEditable selection (it handles
 * partial / multi-node ranges that `Range.surroundContents` chokes on, and it
 * TOGGLES OFF correctly when the selection is already styled). The one gotcha:
 * by default Chromium emits semantic tags (`<b>`, `<i>`, `<u>`). When we later
 * walk the DOM with computed-style reads (extractRunsFromDOM), a `<u>` produces
 * `text-decoration: underline` that can survive an explicit "remove" because the
 * browser sometimes leaves a redundant wrapper. Forcing `styleWithCSS=true` makes
 * execCommand emit inline `style="..."` instead, which the same command can then
 * cleanly REMOVE on the next toggle. So every B/I/U/color goes through here.
 */

/** Turn on CSS styling mode so execCommand emits inline styles, not <b>/<i>/<u>. */
export function enableStyleWithCSS(): void {
  try {
    document.execCommand('styleWithCSS', false, 'true')
  } catch {
    /* older engines: ignore, semantic tags still toggle correctly */
  }
}

/**
 * Run a bold/italic/underline execCommand with styleWithCSS forced on. execCommand
 * inherently toggles: if the whole selection already has the style it is removed,
 * otherwise it is added — which is exactly the toggle-off behaviour we need.
 */
export function execCommandWithCSS(cmd: 'bold' | 'italic' | 'underline'): boolean {
  enableStyleWithCSS()
  try {
    return document.execCommand(cmd)
  } catch {
    return false
  }
}

/** Apply a foreground color to the selection with styleWithCSS forced on. */
export function execForeColorWithCSS(color: string): boolean {
  enableStyleWithCSS()
  try {
    return document.execCommand('foreColor', false, color)
  } catch {
    return false
  }
}
