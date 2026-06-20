export type VoiceAction =
  | { kind: 'newAgent'; agent: 'claude' | 'codex' | 'cursor' | 'shell'; agentName: string }
  | { kind: 'closeNode'; name: string }
  | { kind: 'music'; play: boolean }
  | { kind: 'webPreview'; url?: string }
  // forward ONLY fires on an explicit "dile a/envía a <agente> ..." address.
  | { kind: 'forward'; name?: string; text: string }
  // Agent Relay: "cuando termine X, dile a Y <texto>" — arm a handoff.
  | { kind: 'relay'; sourceName: string; targetName: string; text: string }
  // Multi-canvas workspace control.
  // "cambia/ve al lienzo <nombre>", "abre el lienzo <nombre>" -> open by fuzzy name.
  | { kind: 'switchCanvas'; name: string }
  // "crea/nuevo lienzo (llamado) <nombre>" -> new named canvas (name optional).
  | { kind: 'newCanvas'; name?: string }
  // "cierra este lienzo" -> close the active tab.
  | { kind: 'closeCanvas' }
  // "nueva conversación" / "empieza de cero" -> reset the voice CLI session.
  | { kind: 'resetSession' }
  // "abre/lanza una terminal <agente> en el lienzo <nombre>" -> switch (create if
  // missing) THEN deploy the agent node there.
  | { kind: 'deployInCanvas'; agent: 'claude' | 'codex' | 'cursor' | 'shell'; canvasName: string }
  // anything unrecognized: a SAFE no-op (never written to a terminal).
  | { kind: 'unknown' }

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()

/**
 * Lightweight Spanish command parser for canvas control (offline fallback used
 * ONLY when the AI brain is unavailable).
 *
 * SAFETY: free/conversational text is NEVER forwarded to a terminal. The only
 * way to reach a `forward` is an EXPLICIT address phrase ("dile a/envía a/manda
 * a <agente> ..."). Anything else returns `unknown`, which the executor turns
 * into a spoken "no he podido procesar la orden" with zero terminal writes.
 */
export function interpret(raw: string): VoiceAction {
  const t = norm(raw)

  // RESET the voice conversation — checked early (short, unambiguous phrases).
  // "nueva conversacion", "empieza/empezar de cero", "reinicia la conversacion",
  // "olvida lo anterior".
  if (
    /\bnueva\s+conversacion\b/.test(t) ||
    /\bempie(?:za|zar)\s+de\s+cero\b/.test(t) ||
    /\breinicia(?:r)?\s+(?:la\s+)?conversacion\b/.test(t) ||
    /\bolvida\s+lo\s+anterior\b/.test(t)
  ) {
    return { kind: 'resetSession' }
  }

  // ===== Multi-canvas "lienzo" commands — MUST run BEFORE the generic openVerb/
  // newAgent block below: "abre el lienzo X" and "abre una terminal claude en el
  // lienzo Y" both contain openVerb and would otherwise be mis-parsed as a new
  // agent. These parses are checked first so the workspace intent always wins. =====

  // DEPLOY-INTO-CANVAS: "abre/lanza/crea una terminal <agente> en el lienzo <nombre>".
  // The agent token is derived from the same \bclaude\b/etc tests used for newAgent;
  // canvasName is the trailing capture after "en el lienzo".
  const deploy = t.match(
    /(?:abre|abrir|lanza|lanzar|crea|crear).*?(?:terminal|claude|codex|cursor|shell|consola).*?\ben el lienzo\b\s+(.+)$/
  )
  if (deploy) {
    const canvasName = deploy[1].trim()
    if (canvasName) {
      let agent: 'claude' | 'codex' | 'cursor' | 'shell' = 'claude'
      if (/\bcodex\b/.test(t)) agent = 'codex'
      else if (/\bcursor\b/.test(t)) agent = 'cursor'
      else if (/\b(terminal|shell|consola)\b/.test(t) && !/\bclaude\b/.test(t)) agent = 'shell'
      else if (/\bclaude\b/.test(t)) agent = 'claude'
      return { kind: 'deployInCanvas', agent, canvasName }
    }
  }

  // CLOSE: "cierra (este) lienzo".
  if (/\b(cierra|cerrar)\s+(?:este\s+)?lienzo\b/.test(t)) {
    return { kind: 'closeCanvas' }
  }

  // NEW: "crea/crear/nuevo/nueva lienzo (llamado|que se llame) <nombre>?". Name
  // optional. Checked before switch so "crea ... lienzo" isn't swallowed by the
  // "abre/abrir ... lienzo" switch form below.
  const newCanvas = t.match(/\b(?:crea|crear|nuevo|nueva)\s+lienzo(?:\s+(?:llamado|que se llame)\s+(.+))?$/)
  if (newCanvas) {
    const name = (newCanvas[1] || '').trim()
    return { kind: 'newCanvas', name: name || undefined }
  }

  // SWITCH: "cambia/ve/vete/ir (a|al) (el) lienzo <nombre>" OR "abre/abrir (el)
  // lienzo <nombre>".
  const switchA = t.match(/\b(?:cambia|ve|vete|cambiar|ir)\s+(?:a\s+|al\s+)?(?:el\s+)?lienzo\s+(.+)$/)
  if (switchA && switchA[1].trim()) return { kind: 'switchCanvas', name: switchA[1].trim() }
  const switchB = t.match(/\b(?:abre|abrir)\s+(?:el\s+)?lienzo\s+(.+)$/)
  if (switchB && switchB[1].trim()) return { kind: 'switchCanvas', name: switchB[1].trim() }

  // open / new agent
  const openVerb = /(abre|abrir|nuevo|nueva|crea|crear|lanza|lanzar|añade|anade|agrega|abreme)\b/
  if (openVerb.test(t)) {
    if (/\bclaude\b/.test(t)) return { kind: 'newAgent', agent: 'claude', agentName: 'Claude' }
    if (/\bcodex\b/.test(t)) return { kind: 'newAgent', agent: 'codex', agentName: 'Codex' }
    if (/\bcursor\b/.test(t)) return { kind: 'newAgent', agent: 'cursor', agentName: 'Cursor' }
    if (/\b(terminal|shell|consola)\b/.test(t)) return { kind: 'newAgent', agent: 'shell', agentName: 'terminal' }
    if (/\b(agente|agent)\b/.test(t)) return { kind: 'newAgent', agent: 'claude', agentName: 'Claude' }
    if (/\b(preview|vista previa|navegador|web)\b/.test(t)) {
      const m = raw.match(/https?:\/\/\S+/)
      return { kind: 'webPreview', url: m?.[0] }
    }
    if (/\b(musica|música|reproductor|focus)\b/.test(t)) return { kind: 'music', play: true }
  }

  // close
  const closeVerb = /^(cierra|cerrar|elimina|borra|quita)\b\s*(?:(?:el|la|al|a)\b\s*)?(?:(?:agente|terminal|nodo)\b\s*)?/
  if (closeVerb.test(t)) {
    const name = t.replace(closeVerb, '').trim()
    if (name) return { kind: 'closeNode', name }
  }

  // music control
  if (/\b(pon|reproduce|reproducir|pone)\b.*\b(musica|música)\b/.test(t)) return { kind: 'music', play: true }
  if (/\b(para|pausa|detén|deten|silencia)\b.*\b(musica|música)\b/.test(t)) return { kind: 'music', play: false }

  // Agent Relay — "cuando termine <X>, (dile a|envía a|manda a) <Y> <texto>".
  // Must run BEFORE the directed-forward match below, since the tail contains a
  // "dile a Y ..." phrase. Matched against the ORIGINAL text so source/target
  // names and the message keep their casing/accents. Falls through safely.
  // Source and target names may BOTH span multiple words (e.g. "Web Front"), so
  // capture them lazily. The primary form anchors the message on the "que"
  // connector (mirroring the directed-forward path below); a single-token
  // fallback handles phrasing without a "que" boundary.
  const relayVerb =
    '(?:dile|d[ií]le|env[ií]a|envia|manda|m[áa]ndale|p[áa]sale|pasale)'
  const relayQue = raw.match(
    new RegExp(
      `^\\s*cuando\\s+(?:termine|acabe|finalice)\\s+(.+?)\\s*,?\\s*${relayVerb}\\s+a\\s+(.+?)\\s+que\\s+(.+)$`,
      'i'
    )
  )
  const relay =
    relayQue ||
    raw.match(
      new RegExp(
        `^\\s*cuando\\s+(?:termine|acabe|finalice)\\s+([^\\s,]+)\\s*,?\\s*${relayVerb}\\s+a\\s+(\\S+)\\s+(?:que\\s+)?(.+)$`,
        'i'
      )
    )
  if (relay) {
    const sourceName = relay[1].trim().replace(/,$/, '')
    const targetName = relay[2].trim().replace(/,$/, '')
    const text = relay[3].trim()
    if (sourceName && targetName && text) return { kind: 'relay', sourceName, targetName, text }
  }

  // EXPLICIT directed forward — the ONLY path that may write to a terminal.
  // Matches "dile a <X> (que) ...", "envía/envia a <X> ...", "manda a <X> ...",
  // "pásale/pasale a <X> ...", "pregúntale/preguntale a <X> ...".
  // The name may span MULTIPLE words (e.g. a terminal titled "Web Front"), so it
  // is captured lazily up to the "que" message connector. A single-token fallback
  // handles phrasing without a "que" boundary.
  // Run against the ORIGINAL text so the message keeps its casing/accents.
  const verb =
    '(?:dile|d[ií]le|d[ií]|env[ií]a|envia|manda|m[áa]ndale|p[áa]sale|pasale|preg[úu]ntale|preguntale|pregunta)'
  const directedQue = raw.match(new RegExp(`^\\s*${verb}\\s+a\\s+(.+?)\\s+que\\s+(.+)$`, 'i'))
  if (directedQue) {
    const name = directedQue[1].trim()
    const text = directedQue[2].trim()
    if (name && text) return { kind: 'forward', name, text }
  }
  const directed = raw.match(new RegExp(`^\\s*${verb}\\s+a\\s+(\\S+)\\s+(.+)$`, 'i'))
  if (directed) {
    const name = directed[1].trim()
    const text = directed[2].trim()
    if (name && text) return { kind: 'forward', name, text }
  }

  // Free/conversational/unrecognized text: SAFE no-op, never a terminal write.
  return { kind: 'unknown' }
}
