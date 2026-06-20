import { useEffect, useMemo, useState } from 'react'
import { useCanvas } from '../store/canvas'

// Pipeline Picker (Slipstream Pipeline Walk branch chooser).
//
// When walkPipeline('down'|'up') lands on a node that has MORE THAN ONE relay
// partner in the pressed direction, canvas.ts sets a transient `pipelinePick`
// { dir, candidates } and this overlay sprouts a tiny ace-jump label badge
// ("a", "s", "d", "f"…) over ONLY those candidate nodes. Type a label and the
// camera flies straight to that branch (one keystroke), tracing the actual
// handoff topology instead of eyeballing conduit edges. It is the fan-out/fan-in
// disambiguator that makes "Tab through the pipeline" work on branching graphs.
//
// CONTRACT: purely additive, renderer-only — a sibling of JumpHints with the SAME
// label algorithm + edge-clamp math. It READS the canvas store + camera and
// reuses the EXISTING centerOnNode for the hop (full Slipstream/Wayback/Loupe
// participation for free). It never mutates node/shape geometry, never touches
// IPC/main, and adds no persistence. It renders NOTHING (zero chrome/cost) when
// pipelinePick is null, matching the project's "no chrome until used" convention.

// CHROME insets kept in sync with canvas.ts / JumpHints so edge-clamped badges for
// off-screen candidate nodes never tuck under the surrounding chrome.
const CHROME = { top: 64, bottom: 116, left: 78, right: 190 }

// Home-row-first label alphabet — identical ordering to JumpHints' KEYS so the
// muscle memory carries over from ace-jump teleport to pipeline branch picking.
const KEYS = 'asdfghjkl'.split('')

/**
 * Build label -> nodeId for the candidate ids, in the order they were resolved by
 * pickWalkTarget (frecency-ordered, most-likely branch first). The first
 * KEYS.length get single chars; any beyond that get two-char combos (a relay node
 * can't realistically exceed 9 partners, but stay safe + consistent with
 * JumpHints). Deterministic given the input order. Identical algorithm to
 * JumpHints.buildLabels so the two overlays read the same.
 */
function buildLabels(orderedIds: string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (orderedIds.length <= KEYS.length) {
    orderedIds.forEach((id, i) => out.set(KEYS[i], id))
    return out
  }
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

export function PipelinePicker(): JSX.Element | null {
  const pipelinePick = useCanvas((s) => s.pipelinePick)
  const nodes = useCanvas((s) => s.nodes)
  const camera = useCanvas((s) => s.camera)
  const centerOnNode = useCanvas((s) => s.centerOnNode)
  const clearPipelinePick = useCanvas((s) => s.clearPipelinePick)

  // The chars typed so far while narrowing to a unique label.
  const [typed, setTyped] = useState('')

  // Reset the typed buffer whenever a new branch choice opens, so each activation
  // starts clean (a stale prefix from a previous branch can never linger).
  useEffect(() => {
    if (pipelinePick) setTyped('')
  }, [pipelinePick])

  // Label -> nodeId, in the candidate order canvas.ts resolved (frecency-first).
  const labels = useMemo(() => {
    if (!pipelinePick) return new Map<string, string>()
    return buildLabels(pipelinePick.candidates)
  }, [pipelinePick])

  // Local keydown listener, mounted ONLY while a branch choice is pending. It owns
  // the keyboard while active: a typed char narrows the visible badges; a unique
  // match flies there + clears; Escape / any non-matching key cancels. Capture
  // phase + always preventDefault/stopPropagation so a stray key can't leak to
  // other handlers (xterm, the App-level shortcuts) while we claim the keyboard.
  useEffect(() => {
    if (!pipelinePick) return
    const onKey = (e: KeyboardEvent): void => {
      // Ignore pure modifier presses and any chord — let the OS/app own those.
      if (e.metaKey || e.ctrlKey || e.altKey) {
        clearPipelinePick()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        clearPipelinePick()
        return
      }
      const ch = e.key.toLowerCase()
      // Only home-row label chars are meaningful; anything else cancels.
      if (ch.length !== 1 || !KEYS.includes(ch)) {
        e.preventDefault()
        e.stopPropagation()
        clearPipelinePick()
        return
      }
      e.preventDefault()
      e.stopPropagation()
      const next = typed + ch
      // Exact unique match -> hop (reuses centerOnNode: select + raise +
      // Slipstream/Wayback) and clear the branch flag.
      const exact = labels.get(next)
      if (exact) {
        clearPipelinePick()
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
      else clearPipelinePick() // dead end -> cancel
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [pipelinePick, typed, labels, centerOnNode, clearPipelinePick])

  if (!pipelinePick) return null // zero chrome / zero cost when inactive

  const vw = typeof window !== 'undefined' ? window.innerWidth : 0
  const vh = typeof window !== 'undefined' ? window.innerHeight : 0

  const badges: JSX.Element[] = []
  for (const [label, id] of labels) {
    // While narrowing, only show labels that still match the typed prefix.
    if (typed && !label.startsWith(typed)) continue
    const node = nodes.find((n) => n.id === id)
    if (!node) continue
    // SAME transform Canvas/JumpHints use: screen = camera.{x,y} + world * zoom.
    const sx = camera.x + node.x * camera.zoom
    const sy = camera.y + node.y * camera.zoom
    // Edge-clamp off-screen candidates so every branch stays reachable. Clamp
    // inside the chrome insets so a clamped badge never tucks under the chrome.
    const left = Math.min(Math.max(sx, CHROME.left), Math.max(CHROME.left, vw - CHROME.right - 28))
    const top = Math.min(Math.max(sy, CHROME.top), Math.max(CHROME.top, vh - CHROME.bottom - 22))
    badges.push(
      <div key={id} className="jump-hint pipeline-hint glass" style={{ left, top }}>
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
