/**
 * Submit a whole line to a running agent TUI: write the TEXT, then the Enter
 * (`\r`) as a SEPARATE write a beat later.
 *
 * Why: some agent TUIs (notably Codex) batch their stdin and process a trailing
 * `\r` that arrived in the SAME chunk as the text BEFORE the typed text has been
 * committed to their input widget — so the submit fires on an empty line and the
 * text is left sitting in the box unsent ("solo lo escribió en la caja"). Sending
 * the Enter as its own keypress, after a short delay, makes it reliably submit.
 * Claude is unaffected by the split (text then Enter works there too), so this is
 * the safe path for every agent.
 *
 * NOTE: only for sending a COMPLETE message/command to an agent — never for raw
 * interactive keystrokes (those must pass through verbatim).
 */
const ENTER_DELAY_MS = 140

export function submitToPty(id: string, text: string): void {
  try {
    window.canvasio.pty.write(id, text)
  } catch {
    /* ignore */
  }
  window.setTimeout(() => {
    try {
      window.canvasio.pty.write(id, '\r')
    } catch {
      /* ignore */
    }
  }, ENTER_DELAY_MS)
}
