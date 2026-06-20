import { useEffect } from 'react'
import { frostRegister, frostUnregister } from '../components/BackdropFrost'

let __frostRectSeq = 0

export interface FrostRectOptions {
  /** Corner radius in px to round the revealed frost (match the element's border-radius). Default 14. */
  radius?: number
  /** When false, the rect is unregistered (e.g. a popover that is closed). Default true. */
  active?: boolean
  /** Stacking hint stored on the shape (BackdropFrost does not currently order by it; pass a high value for HUD). Default 1000. */
  z?: number
}

/**
 * Publish a screen-space element's bounding rect into the shared frostShapes
 * registry so the single z-29 BackdropFrost layer reveals the blurred wallpaper
 * under it. Screen-space analog of TerminalBox.applyRect — but HUD chrome is
 * React-positioned (not imperatively projected), so we observe layout with a
 * ResizeObserver + window resize/scroll and a rAF-coalesced republish.
 *
 * #185-safe: never calls setState, only the imperative module-scope registry
 * (which itself rAF-coalesces the mask rebuild). DOM-stable: one stable id per
 * hook instance for the element's lifetime.
 */
export function useFrostRect(
  ref: React.RefObject<HTMLElement>,
  { radius = 14, active = true, z = 1000 }: FrostRectOptions = {}
): void {
  useEffect(() => {
    const el = ref.current
    const id = `hud:${__frostRectSeq++}`
    if (!el || !active) {
      frostUnregister(id)
      return () => frostUnregister(id)
    }

    let raf = 0
    let lastKey = ''
    const publish = (): void => {
      raf = 0
      const node = ref.current
      if (!node) {
        frostUnregister(id)
        return
      }
      const r = node.getBoundingClientRect()
      // Hidden/zero-area (display:none, not yet laid out) → drop the reveal.
      if (r.width < 1 || r.height < 1) {
        frostUnregister(id)
        lastKey = ''
        return
      }
      // Round to device px to match the imperative terminal rects + avoid
      // sub-pixel mask churn. Clamp the radius to half the smaller side.
      const x = Math.round(r.left)
      const y = Math.round(r.top)
      const w = Math.round(r.width)
      const h = Math.round(r.height)
      const rad = Math.max(0, Math.min(radius, Math.floor(Math.min(w, h) / 2)))
      const key = `${x},${y},${w},${h},${rad}`
      if (key === lastKey) return // nothing moved → no mask churn
      lastKey = key
      frostRegister(id, { z, rects: [{ x, y, w, h, r: rad }] })
    }
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(publish)
    }

    publish()
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    window.addEventListener('resize', schedule)
    // Bars use translateX(-50%) etc. and can shift on layout; also catch scroll
    // of any scroll container (capture phase) cheaply.
    window.addEventListener('scroll', schedule, true)

    return () => {
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      frostUnregister(id)
    }
    // Re-run when activeness/radius/z change so a popover toggling open/closed
    // re-registers/unregisters cleanly.
  }, [ref, radius, active, z])
}
