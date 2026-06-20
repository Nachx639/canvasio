import { useEffect, useMemo, useState } from 'react'
import { useCanvas } from '../store/canvas'

// Jump Hints (Ace-Jump Teleport).
//
// Press ';' (wired in App.tsx) and every node sprouts a tiny screen-space label
// badge ("a", "s", "d", "f"…). Type the label and the camera flies straight to
// that node — zero pointer travel, zero name-typing, zero list-scanning. It is
// the keyboard-power-user teleport gap the other nav primitives leave open
// (Beacon needs a name + list, Minimap needs the mouse, Lighthouse only hops to
// spatial neighbors, Waypoints need pre-saving). Labels are assigned in (y,x)
// reading order (the same ordering arrange()/cycleNode use), so the layout stays
// stable and learnable across sessions.
//
// CONTRACT: purely additive, renderer-only. It READS the canvas store + camera
// and reuses the EXISTING centerOnNode for the teleport (full Slipstream/Wayback
// participation for free). It never mutates node/shape geometry, never touches
// IPC/main, and adds no persistence. It renders NOTHING (zero chrome/cost) when
// jumpMode is off, matching the project's "no chrome until used" convention.

// CHROME insets kept in sync with canvas.ts so edge-clamped badges for off-screen
// nodes never tuck under the surrounding chrome.
const CHROME = { top: 64, bottom: 116, left: 78, right: 190 }

// Home-row-first label alphabet — fast to reach, in a deliberate order. Used for
// the single-char labels (first 9 nodes) and, in pairs, for any overflow.
const KEYS = 'asdfghjkl'.split('')

/**
 * Build label -> nodeId for the given (already (y,x)-ordered) node ids. The first
 * KEYS.length nodes get single chars; any beyond that get two-char combos so an
 * arbitrarily large canvas stays fully reachable. The mapping is deterministic
 * given the ordering, so a label stays put across re-renders within a session.
 */
function buildLabels(orderedIds: string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (orderedIds.length <= KEYS.length) {
    orderedIds.forEach((id, i) => out.set(KEYS[i], id))
    return out
  }
  // Overflow: assign two-char combos (aa, as, ad, …) so >9 nodes still get a
  // unique, prefix-narrowable label. We use pairs uniformly for ALL nodes in the
  // overflow case so no single-char label is ever a prefix of a two-char one
  // (which would make a unique single match impossible to commit cleanly).
  let i = 0
  for (const a of KEYS) {
    for (const b of KEYS) {
      if (i >= orderedIds.length) return out
      out.set(a + b, orderedIds[i])
      i++
    }
  }
  return out
}

export function JumpHints(): JSX.Element | null {
  const jumpMode = useCanvas((s) => s.jumpMode)
  const nodes = useCanvas((s) => s.nodes)
  const camera = useCanvas((s) => s.camera)
  const centerOnNode = useCanvas((s) => s.centerOnNode)
  const setJumpMode = useCanvas((s) => s.setJumpMode)

  // The chars typed so far while narrowing to a unique label.
  const [typed, setTyped] = useState('')

  // Reset the typed buffer whenever the mode flips on, so each activation starts
  // clean (a stale prefix from a previous session can never linger).
  useEffect(() => {
    if (jumpMode) setTyped('')
  }, [jumpMode])

  // Label -> nodeId, in (y,x) reading order (matching arrange()/cycleNode), so a
  // node keeps the same label as long as the layout is stable.
  const labels = useMemo(() => {
    const ordered = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x).map((n) => n.id)
    return buildLabels(ordered)
  }, [nodes])

  // Local keydown listener, mounted ONLY while active. It owns the keyboard while
  // jump mode is on: a typed char narrows the visible badges; a unique match flies
  // there and exits; Escape / any non-matching key cancels. Capture phase + always
  // preventDefault/stopPropagation so a stray key can't leak to other handlers
  // (xterm, the App-level shortcuts) while we're claiming the keyboard.
  useEffect(() => {
    if (!jumpMode) return
    const onKey = (e: KeyboardEvent): void => {
      // Ignore pure modifier presses and any chord — let the OS/app own those.
      if (e.metaKey || e.ctrlKey || e.altKey) {
        setJumpMode(false)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setJumpMode(false)
        return
      }
      const ch = e.key.toLowerCase()
      // Only home-row label chars are meaningful; anything else cancels.
      if (ch.length !== 1 || !KEYS.includes(ch)) {
        e.preventDefault()
        e.stopPropagation()
        setJumpMode(false)
        return
      }
      e.preventDefault()
      e.stopPropagation()
      const next = typed + ch
      // Exact unique match -> teleport (reuses centerOnNode: select + raise +
      // Slipstream/Wayback) and exit jump mode.
      const exact = labels.get(next)
      if (exact) {
        setJumpMode(false)
        centerOnNode(exact)
        return
      }
      // Still a live prefix of some label -> keep narrowing.
      let isPrefix = false
      for (const label of labels.keys()) {
        if (label.startsWith(next)) {
          isPrefix = true
          break
        }
      }
      if (isPrefix) setTyped(next)
      else setJumpMode(false) // dead end -> cancel
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [jumpMode, typed, labels, centerOnNode, setJumpMode])

  if (!jumpMode) return null // zero chrome / zero cost when inactive

  const vw = typeof window !== 'undefined' ? window.innerWidth : 0
  const vh = typeof window !== 'undefined' ? window.innerHeight : 0

  const badges: JSX.Element[] = []
  for (const [label, id] of labels) {
    // While narrowing, only show labels that still match the typed prefix.
    if (typed && !label.startsWith(typed)) continue
    const node = nodes.find((n) => n.id === id)
    if (!node) continue
    // SAME transform Canvas uses: screen = camera.{x,y} + world * zoom.
    const sx = camera.x + node.x * camera.zoom
    const sy = camera.y + node.y * camera.zoom
    // Edge-clamp off-screen nodes so every node stays reachable. Clamp inside the
    // chrome insets so a clamped badge never tucks under the top/side chrome.
    const left = Math.min(Math.max(sx, CHROME.left), Math.max(CHROME.left, vw - CHROME.right - 28))
    const top = Math.min(Math.max(sy, CHROME.top), Math.max(CHROME.top, vh - CHROME.bottom - 22))
    badges.push(
      <div key={id} className="jump-hint glass" style={{ left, top }}>
        {/* Dim the already-typed prefix so the next key to press stands out. */}
        {typed && label.startsWith(typed) ? (
          <>
            <span className="jump-hint-typed">{typed}</span>
            {label.slice(typed.length)}
          </>
        ) : (
          label
        )}
      </div>
    )
  }

  return (
    <div className="jump-hints-layer" aria-hidden="true">
      {badges}
    </div>
  )
}
