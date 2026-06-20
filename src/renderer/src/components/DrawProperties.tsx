import { useShallow } from 'zustand/react/shallow'
import { useDrawing, StrokeStyle, StrokeWidth, DEFAULT_FONT_FAMILY } from '../store/drawing'
import { useDraggablePanel } from '../lib/useDraggablePanel'
import { PanelGrip } from './PanelGrip'
import { getActiveTextEditor, getActiveEditorSelection } from './DrawingLayer'
import { applySelectionStyle, hasActiveSelection, restoreEditorSelection } from '../lib/textEditing'
import { execCommandWithCSS, execForeColorWithCSS } from '../lib/execCommandCompat'
import { useT } from '../store/i18n'

/**
 * Re-focus the editor and RESTORE the last non-collapsed selection before running
 * a per-run format command. Clicking a panel button can blur the editor and
 * collapse the live selection before the onClick fires; without this the format
 * would leak to the whole shape. Returns the editor only when a usable selection
 * is (now) active, else null so the caller falls back to shape-level styling.
 */
function focusedEditorWithSelection(): HTMLDivElement | null {
  const el = getActiveTextEditor()
  if (!el) return null
  el.focus()
  const saved = getActiveEditorSelection()
  if (saved) restoreEditorSelection(el, saved)
  return hasActiveSelection(el) ? el : null
}

/**
 * Apply bold/italic/underline to the LIVE selection inside the in-place rich
 * text editor. Returns true only when there is a real (non-collapsed) selection
 * inside the editor — false means "no editor / no selection" and the caller falls
 * back to shape-level styling. Goes through execCommandWithCSS so the toggle works
 * BOTH ways (applying AND removing) and emits inline styles the extractor reads
 * consistently. Re-fires the editor's `input` so the new runs are stored.
 */
function applyInlineFormat(cmd: 'bold' | 'italic' | 'underline'): boolean {
  const el = focusedEditorWithSelection()
  if (!el) return false
  execCommandWithCSS(cmd)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}

/**
 * Apply a text color to the LIVE selection inside the in-place editor (per-run).
 * Returns true only when an editor is open AND a non-empty selection exists; false
 * => caller falls back to shape-level textColor. Forces styleWithCSS so the color
 * lands as an inline style the extractor reads back as a per-run color.
 */
function applyInlineColor(color: string): boolean {
  const el = focusedEditorWithSelection()
  if (!el) return false
  execForeColorWithCSS(color)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}

/**
 * Apply a px font size to the LIVE selection inside the in-place editor (per-run).
 * execCommand('fontSize') only supports the 1-7 legacy scale, so we wrap the exact
 * selection range in a px-sized <span> via the robust applySelectionStyle helper
 * (handles partial / multi-node ranges and re-selects so repeated +/- keep acting
 * on the same text). Returns true only with an editor open AND a non-empty
 * selection; false => caller resizes the whole shape. Re-fires `input`.
 */
function stepInlineFontSize(delta: number): boolean {
  const el = focusedEditorWithSelection()
  if (!el) return false
  // Step from the SELECTION's CURRENT size (so repeated +/- progressively change
  // it), not the shape default.
  let cur = 0
  const sel = window.getSelection()
  if (sel && sel.rangeCount > 0) {
    let n: Node | null = sel.getRangeAt(0).startContainer
    if (n && n.nodeType === Node.TEXT_NODE) n = n.parentElement
    if (n instanceof HTMLElement) cur = parseFloat(window.getComputedStyle(n).fontSize) || 0
  }
  const next = Math.max(8, Math.min(96, (cur || 20) + delta))
  if (!applySelectionStyle(el, 'fontSize', `${next}px`)) return false
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}

const STROKE_SWATCHES = ['#e6e6e6', '#ff8b8b', '#7ee787', '#7aa2ff', '#ffd166', '#d97757']
const FILL_SWATCHES = ['#ff8b8b', '#7ee787', '#7aa2ff', '#ffd166', '#d97757', '#1e293b']

/**
 * Curated font choices. `value` is the CSS font-family applied to the shape.
 * `labelKey` is the i18n key for the user-visible label (resolved at render).
 */
const FONTS: { labelKey: string; value: string }[] = [
  { labelKey: 'drawProperties.font_system', value: DEFAULT_FONT_FAMILY },
  { labelKey: 'drawProperties.font_mono', value: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  { labelKey: 'drawProperties.font_serif', value: 'ui-serif, Georgia, serif' },
  { labelKey: 'drawProperties.font_rounded', value: 'Avenir, "Helvetica Neue", sans-serif' },
  { labelKey: 'drawProperties.font_handwritten', value: '"Comic Sans MS", "Bradley Hand", cursive' }
]

const panelStyle: React.CSSProperties = {
  position: 'fixed',
  right: 14,
  top: '50%',
  transform: 'translateY(-50%)',
  zIndex: 41,
  width: 210,
  padding: 12,
  borderRadius: 14,
  background: 'rgba(15,23,43,0.66)',
  backdropFilter: 'blur(14px)',
  WebkitBackdropFilter: 'blur(14px)',
  border: '1px solid rgba(120,160,255,0.2)',
  boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  color: '#d6e0f7',
  fontSize: 12,
  fontFamily: 'inherit'
}

const labelStyle: React.CSSProperties = {
  fontSize: 10.5,
  letterSpacing: 0.3,
  color: '#8da0c6',
  marginBottom: 6,
  textTransform: 'uppercase'
}

const rowStyle: React.CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }

export function DrawProperties(): JSX.Element | null {
  const t = useT()
  const { style: dragStyle, dragHandleProps } = useDraggablePanel('draw-props')
  const activeTool = useDrawing((s) => s.activeTool)
  const style = useDrawing((s) => s.style)
  const setStyle = useDrawing((s) => s.setStyle)
  const updateShape = useDrawing((s) => s.updateShape)
  const bringToFront = useDrawing((s) => s.bringToFront)
  const sendToBack = useDrawing((s) => s.sendToBack)
  const duplicateShape = useDrawing((s) => s.duplicateShape)
  const removeSelected = useDrawing((s) => s.removeSelected)
  const group = useDrawing((s) => s.group)
  const ungroup = useDrawing((s) => s.ungroup)

  const isDrawingTool = activeTool !== 'select' && activeTool !== 'hand' && activeTool !== 'eraser'
  // The single-shape UI (Texto input, Capas, text-only hides) only applies when
  // EXACTLY one shape is selected — preserves all existing single-select behavior.
  //
  // PERF: derive the selected shapes inside a single shallow-compared selector
  // instead of subscribing to the whole `shapes` array and filtering on every
  // render. During a drag, `updateShape` rebuilds `s.shapes` on every
  // pointermove, but as long as the *selected* shape objects keep the same
  // references (i.e. a non-selected shape moved) — and even when a selected
  // shape's identity changes, useShallow only re-renders on a genuine shallow
  // diff of this small filtered array, not on every frame of an unrelated drag.
  // The produced array is identical to the previous `shapes.filter(...)`, so all
  // downstream logic (selected/multi/isTextShape/canGroup/canUngroup/render) is
  // unchanged.
  const selectedShapes = useDrawing(
    useShallow((s) => s.shapes.filter((sh) => s.selectedShapeIds.includes(sh.id)))
  )
  const selected = selectedShapes.length === 1 ? selectedShapes[0] : null
  const multi = selectedShapes.length > 1

  if (!isDrawingTool && selectedShapes.length === 0) return null

  const isTextContext = activeTool === 'text' || selected?.type === 'text'
  // Stroke width + style don't apply to a TEXT shape — hide them only when the
  // selection is purely text (a lone text shape, or several text shapes).
  const isTextShape =
    selectedShapes.length > 0 && selectedShapes.every((s) => s.type === 'text')
  // Group is offered when 2+ shapes are selected; Ungroup when any selected
  // shape belongs to a group.
  const canGroup = selectedShapes.length >= 2
  const canUngroup = selectedShapes.some((s) => s.groupId != null)

  return (
    <div
      style={{ ...panelStyle, ...dragStyle }}
      data-canvasio-panel-root
      // Swallow pointer/click/double-click so interacting with the panel never
      // falls through to the canvas underneath — otherwise a rapid second click on
      // a stepper (font − / +) reads as a canvas double-click and drops the shape
      // behind the panel into text-edit, which looks like a deselect.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <PanelGrip dragHandleProps={dragHandleProps} />
      {/* STROKE */}
      <div>
        <div style={labelStyle}>{t('drawProperties.stroke')}</div>
        <div style={rowStyle}>
          {STROKE_SWATCHES.map((c) => (
            <button
              key={c}
              onClick={() => setStyle({ stroke: c })}
              style={swatchStyle(c, style.stroke === c)}
              title={c}
            />
          ))}
          <label style={customColorWrap} title={t('drawProperties.custom_color')}>
            <input
              type="color"
              value={normalizeHex(style.stroke)}
              onChange={(e) => setStyle({ stroke: e.target.value })}
              style={hiddenColorInput}
            />
            <span style={{ ...swatchInner, background: style.stroke }} />
          </label>
        </div>
      </div>

      {/* BACKGROUND / FILL */}
      <div>
        <div style={labelStyle}>{t('drawProperties.background')}</div>
        <div style={rowStyle}>
          <button
            onClick={() => setStyle({ fill: 'transparent' })}
            style={transparentChip(style.fill === 'transparent')}
            title={t('drawProperties.transparent')}
          />
          {FILL_SWATCHES.map((c) => (
            <button
              key={c}
              onClick={() => setStyle({ fill: c })}
              style={swatchStyle(c, style.fill === c)}
              title={c}
            />
          ))}
          <label style={customColorWrap} title={t('drawProperties.custom_bg_color')}>
            <input
              type="color"
              value={normalizeHex(style.fill === 'transparent' ? '#1e293b' : style.fill)}
              onChange={(e) => setStyle({ fill: e.target.value })}
              style={hiddenColorInput}
            />
            <span
              style={{
                ...swatchInner,
                background: style.fill === 'transparent' ? '#1e293b' : style.fill
              }}
            />
          </label>
        </div>
      </div>

      {/* STROKE WIDTH */}
      {!isTextShape && (
        <div>
          <div style={labelStyle}>{t('drawProperties.width')}</div>
          <div style={rowStyle}>
            {([1, 2, 4] as StrokeWidth[]).map((w, i) => (
              <button
                key={w}
                onClick={() => setStyle({ strokeWidth: w })}
                style={segBtn(style.strokeWidth === w)}
                title={
                  [
                    t('drawProperties.width_thin'),
                    t('drawProperties.width_medium'),
                    t('drawProperties.width_thick')
                  ][i]
                }
              >
                <span
                  style={{
                    display: 'block',
                    width: 18,
                    height: w,
                    borderRadius: 2,
                    background: 'currentColor'
                  }}
                />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* STROKE STYLE */}
      {!isTextShape && (
        <div>
          <div style={labelStyle}>{t('drawProperties.style')}</div>
          <div style={rowStyle}>
            {(['solid', 'dashed', 'dotted'] as StrokeStyle[]).map((st) => (
              <button
                key={st}
                onClick={() => setStyle({ strokeStyle: st })}
                style={segBtn(style.strokeStyle === st)}
                title={st}
              >
                <svg width="22" height="10" viewBox="0 0 22 10">
                  <line
                    x1="1"
                    y1="5"
                    x2="21"
                    y2="5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeDasharray={st === 'dashed' ? '5,4' : st === 'dotted' ? '1,3' : undefined}
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* OPACITY */}
      <div>
        <div style={labelStyle}>{t('drawProperties.opacity')}</div>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(style.opacity * 100)}
          onChange={(e) => setStyle({ opacity: Number(e.target.value) / 100 })}
          style={{ width: '100%', accentColor: '#7aa2ff' }}
        />
      </div>

      {/* TEXT */}
      {(isTextContext || selected?.type === 'rect') && (
        <div>
          <div style={labelStyle}>{t('drawProperties.text')}</div>
          <div style={{ ...rowStyle, marginTop: 0 }}>
            <span style={{ color: '#8da0c6' }}>{t('drawProperties.size')}</span>
            <button
              style={segBtn(false)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                // With the editor open + a non-empty selection, step the SELECTED
                // text size (per-run); otherwise resize the whole shape.
                if (!stepInlineFontSize(-2)) {
                  setStyle({ fontSize: Math.max(8, (style.fontSize ?? 20) - 2) })
                }
              }}
            >
              −
            </button>
            <span style={{ minWidth: 22, textAlign: 'center' }}>{style.fontSize}</span>
            <button
              style={segBtn(false)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (!stepInlineFontSize(2)) {
                  setStyle({ fontSize: Math.min(96, (style.fontSize ?? 20) + 2) })
                }
              }}
            >
              +
            </button>
          </div>

          {/* TEXT COLOR */}
          {(() => {
            const currentTextColor =
              selected?.textColor ?? selected?.stroke ?? STROKE_SWATCHES[0]
            const applyTextColor = (c: string): void => {
              // With the editor open + a live selection, color the SELECTED text
              // (per-run via execCommand foreColor). Otherwise set the whole
              // shape's textColor (back-compat) across the selection.
              if (applyInlineColor(c)) return
              selectedShapes.forEach((s) => updateShape(s.id, { textColor: c }))
            }
            return (
              <div style={{ marginTop: 6 }}>
                <div style={labelStyle}>{t('drawProperties.text_color')}</div>
                <div style={rowStyle}>
                  {STROKE_SWATCHES.map((c) => (
                    <button
                      key={c}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyTextColor(c)}
                      style={swatchStyle(c, currentTextColor === c)}
                      title={c}
                    />
                  ))}
                  <label style={customColorWrap} title={t('drawProperties.custom_text_color')}>
                    <input
                      type="color"
                      value={normalizeHex(currentTextColor)}
                      onChange={(e) => applyTextColor(e.target.value)}
                      style={hiddenColorInput}
                    />
                    <span style={{ ...swatchInner, background: currentTextColor }} />
                  </label>
                </div>
              </div>
            )
          })()}

          {/* FONT FAMILY */}
          {(() => {
            const currentFont = selected?.fontFamily ?? style.fontFamily ?? DEFAULT_FONT_FAMILY
            return (
              <div style={{ marginTop: 6 }}>
                <div style={labelStyle}>{t('drawProperties.font')}</div>
                <div style={rowStyle}>
                  {FONTS.map((f) => (
                    <button
                      key={f.labelKey}
                      onClick={() => setStyle({ fontFamily: f.value })}
                      style={fontChip(f.value, currentFont === f.value)}
                      title={t(f.labelKey)}
                    >
                      {t(f.labelKey)}
                    </button>
                  ))}
                </div>
              </div>
            )
          })()}

          {/* TEXT STYLE (B / I / U) */}
          {(() => {
            const bold = selected?.bold ?? style.bold
            const italic = selected?.italic ?? style.italic
            const underline = selected?.underline ?? style.underline
            return (
              <div style={{ marginTop: 6 }}>
                <div style={labelStyle}>{t('drawProperties.text_style')}</div>
                <div style={rowStyle}>
                  {/* When the in-place editor is open these toggle B/I/U on the
                      CURRENT text selection (per-run rich text). With no editor
                      open they fall back to shape-level styling (as before). */}
                  <button
                    style={segBtn(bold)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      if (!applyInlineFormat('bold')) setStyle({ bold: !bold })
                    }}
                    title={t('drawProperties.bold')}
                  >
                    <b>B</b>
                  </button>
                  <button
                    style={segBtn(italic)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      if (!applyInlineFormat('italic')) setStyle({ italic: !italic })
                    }}
                    title={t('drawProperties.italic')}
                  >
                    <i>I</i>
                  </button>
                  <button
                    style={segBtn(underline)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      if (!applyInlineFormat('underline')) setStyle({ underline: !underline })
                    }}
                    title={t('drawProperties.underline')}
                  >
                    <span style={{ textDecoration: 'underline' }}>U</span>
                  </button>
                </div>
              </div>
            )
          })()}

          {/* TEXT ALIGNMENT */}
          {(() => {
            const currentAlign = selected?.align ?? style.align ?? 'left'
            return (
              <div style={{ marginTop: 6 }}>
                <div style={labelStyle}>{t('drawProperties.alignment')}</div>
                <div style={rowStyle}>
                  {(['left', 'center', 'right', 'justify'] as const).map((al) => (
                    <button
                      key={al}
                      style={segBtn(currentAlign === al)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        // Alignment is always a whole-shape property (a CSS text-align
                        // on the text box), never per-run, so it applies across the
                        // selection and to the shared style for new shapes.
                        selectedShapes.forEach((s) => updateShape(s.id, { align: al }))
                        setStyle({ align: al })
                      }}
                      title={
                        al === 'left'
                          ? t('drawProperties.align_left')
                          : al === 'center'
                            ? t('drawProperties.align_center')
                            : al === 'right'
                              ? t('drawProperties.align_right')
                              : t('drawProperties.align_justify')
                      }
                    >
                      <svg width="18" height="18" viewBox="0 0 18 18">
                        {al === 'left' && (
                          <>
                            <line x1="2" y1="4" x2="14" y2="4" stroke="currentColor" strokeWidth="1.5" />
                            <line x1="2" y1="8" x2="10" y2="8" stroke="currentColor" strokeWidth="1.5" />
                            <line x1="2" y1="12" x2="12" y2="12" stroke="currentColor" strokeWidth="1.5" />
                          </>
                        )}
                        {al === 'center' && (
                          <>
                            <line x1="4" y1="4" x2="14" y2="4" stroke="currentColor" strokeWidth="1.5" />
                            <line x1="6" y1="8" x2="12" y2="8" stroke="currentColor" strokeWidth="1.5" />
                            <line x1="3" y1="12" x2="15" y2="12" stroke="currentColor" strokeWidth="1.5" />
                          </>
                        )}
                        {al === 'right' && (
                          <>
                            <line x1="4" y1="4" x2="16" y2="4" stroke="currentColor" strokeWidth="1.5" />
                            <line x1="8" y1="8" x2="16" y2="8" stroke="currentColor" strokeWidth="1.5" />
                            <line x1="6" y1="12" x2="16" y2="12" stroke="currentColor" strokeWidth="1.5" />
                          </>
                        )}
                        {al === 'justify' && (
                          <>
                            <line x1="2" y1="4" x2="16" y2="4" stroke="currentColor" strokeWidth="1.5" />
                            <line x1="2" y1="8" x2="16" y2="8" stroke="currentColor" strokeWidth="1.5" />
                            <line x1="2" y1="12" x2="16" y2="12" stroke="currentColor" strokeWidth="1.5" />
                          </>
                        )}
                      </svg>
                    </button>
                  ))}
                </div>
              </div>
            )
          })()}
        </div>
      )}

      {/* GROUP / UNGROUP */}
      {(canGroup || canUngroup) && (
        <div>
          <div style={labelStyle}>{t('drawProperties.group')}</div>
          <div style={rowStyle}>
            {canGroup && (
              <button style={actionBtn} onClick={() => group()} title={t('drawProperties.group_action')}>
                {t('drawProperties.group_btn')}
              </button>
            )}
            {canUngroup && (
              <button style={actionBtn} onClick={() => ungroup()} title={t('drawProperties.ungroup_action')}>
                {t('drawProperties.ungroup_btn')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ARRANGE */}
      {selected && (
        <div>
          <div style={labelStyle}>{t('drawProperties.layers')}</div>
          <div style={rowStyle}>
            <button style={actionBtn} onClick={() => bringToFront(selected.id)} title={t('drawProperties.bring_to_front')}>
              {t('drawProperties.to_front')}
            </button>
            <button style={actionBtn} onClick={() => sendToBack(selected.id)} title={t('drawProperties.send_to_back')}>
              {t('drawProperties.to_back')}
            </button>
          </div>
          <div style={{ ...rowStyle, marginTop: 6 }}>
            <button style={actionBtn} onClick={() => duplicateShape(selected.id)} title={t('drawProperties.duplicate')}>
              {t('drawProperties.duplicate')}
            </button>
            <button
              style={{ ...actionBtn, color: '#ff9b9b' }}
              onClick={() => removeSelected()}
              title={t('drawProperties.delete')}
            >
              {t('drawProperties.delete')}
            </button>
          </div>
        </div>
      )}

      {/* MULTI-SELECT delete (single delete lives in Capas above) */}
      {multi && (
        <div>
          <div style={labelStyle}>{t('drawProperties.selection')}</div>
          <div style={rowStyle}>
            <button
              style={{ ...actionBtn, color: '#ff9b9b' }}
              onClick={() => removeSelected()}
              title={t('drawProperties.delete_selection')}
            >
              {t('drawProperties.delete_count', { count: selectedShapes.length })}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function normalizeHex(c: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c
  return '#e6e6e6'
}

function swatchStyle(color: string, active: boolean): React.CSSProperties {
  return {
    width: 22,
    height: 22,
    borderRadius: 6,
    background: color,
    cursor: 'pointer',
    border: active ? '2px solid #cfe0ff' : '1px solid rgba(255,255,255,0.15)',
    boxShadow: active ? '0 0 0 2px rgba(122,162,255,0.5)' : 'none',
    padding: 0
  }
}

const swatchInner: React.CSSProperties = {
  width: 16,
  height: 16,
  borderRadius: 4,
  display: 'block'
}

const customColorWrap: React.CSSProperties = {
  position: 'relative',
  width: 22,
  height: 22,
  borderRadius: 6,
  border: '1px dashed rgba(160,180,240,0.5)',
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
  overflow: 'hidden'
}

const hiddenColorInput: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  opacity: 0,
  width: '100%',
  height: '100%',
  cursor: 'pointer',
  border: 'none',
  padding: 0
}

function transparentChip(active: boolean): React.CSSProperties {
  return {
    width: 22,
    height: 22,
    borderRadius: 6,
    cursor: 'pointer',
    border: active ? '2px solid #cfe0ff' : '1px solid rgba(255,255,255,0.15)',
    boxShadow: active ? '0 0 0 2px rgba(122,162,255,0.5)' : 'none',
    background:
      'linear-gradient(135deg, rgba(40,52,80,0.9) 45%, #ff6b6b 46%, #ff6b6b 54%, rgba(40,52,80,0.9) 55%)',
    padding: 0
  }
}

function segBtn(active: boolean): React.CSSProperties {
  return {
    minWidth: 30,
    height: 28,
    display: 'grid',
    placeItems: 'center',
    borderRadius: 7,
    cursor: 'pointer',
    border: 'none',
    background: active ? 'rgba(91,140,255,0.28)' : 'rgba(255,255,255,0.05)',
    color: active ? '#cfe0ff' : '#9fb0d2',
    padding: '0 8px'
  }
}

const actionBtn: React.CSSProperties = {
  flex: 1,
  height: 28,
  borderRadius: 7,
  cursor: 'pointer',
  border: 'none',
  background: 'rgba(255,255,255,0.06)',
  color: '#d6e0f7',
  fontSize: 11.5
}

function fontChip(fontFamily: string, active: boolean): React.CSSProperties {
  return {
    height: 26,
    padding: '0 9px',
    borderRadius: 7,
    cursor: 'pointer',
    border: 'none',
    background: active ? 'rgba(91,140,255,0.28)' : 'rgba(255,255,255,0.05)',
    color: active ? '#cfe0ff' : '#9fb0d2',
    fontFamily,
    fontSize: 12,
    whiteSpace: 'nowrap'
  }
}
