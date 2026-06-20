import { useEffect } from 'react'

/**
 * Shared "dismiss on outside click / Escape" behavior for small click-to-toggle
 * popovers (menus, sliders, dropdowns).
 *
 * When `open`, this attaches a window `mousedown` listener that calls `onClose()`
 * whenever the click target is OUTSIDE `ref.current`, plus a `keydown` listener
 * that closes on Escape. Both are cleaned up when the popover closes or the
 * component unmounts.
 *
 * KEY SUBTLETY (the toggle race): `ref` MUST wrap BOTH the trigger button AND the
 * popover panel. If the trigger is outside the ref, clicking it to close fires
 * this handler (close) and then the button's onClick (reopen) — and it never
 * closes. Wrapping the trigger keeps it "inside", so the outside-handler skips it.
 *
 * Mirrors OpenPicker's original inline effect so all small popovers share one impl.
 */
export function useDismiss(
  open: boolean,
  onClose: () => void,
  ref: React.RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, ref])
}
