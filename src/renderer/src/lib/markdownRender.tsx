import React from 'react'

/**
 * Sanitize a markdown link target. Markdown content is UNTRUSTED (user/agent
 * authored .md files), and an <a href> is a script sink: `javascript:` / `data:`
 * / `file:` / custom-scheme URLs can execute in the privileged renderer or be
 * handed to the OS. Only allow http(s)/mailto absolute URLs and relative paths;
 * everything else returns null so the caller renders plain text (no href).
 */
function sanitizeHref(raw: string): string | null {
  const url = (raw || '').trim()
  if (!url) return null
  // Relative links (no scheme, not protocol-relative) are safe.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) && !url.startsWith('//')) return url
  try {
    const proto = new URL(url, 'http://localhost/').protocol
    return proto === 'http:' || proto === 'https:' || proto === 'mailto:' ? url : null
  } catch {
    return null
  }
}

/**
 * Minimal, self-contained Markdown -> React renderer (NO npm dependency).
 *
 * Block grammar supported (line-oriented, GitHub-flavored-ish):
 *  - ATX headings              `#`..`######`
 *  - fenced code blocks        ``` ... ```  (kept verbatim, no inline parsing)
 *  - blockquotes               `> ...`       (consecutive lines merged)
 *  - unordered lists           `-` / `*` / `+`
 *  - ordered lists             `1.` `2)` ...
 *  - horizontal rules          `---` / `***` / `___`
 *  - paragraphs                everything else (blank line separated)
 *
 * Inline grammar (inside headings / paragraphs / list items / blockquotes):
 *  - links            `[text](url)`
 *  - bold             `**text**` / `__text__`
 *  - italic           `*text*` / `_text_`
 *  - inline code      `` `code` ``  (no nested inline parsing)
 *
 * Styled to read like a clean macOS Markdown preview on the app's dark glass.
 * Output is a single React fragment; the caller scrolls/pads its container.
 */
export function renderMarkdown(markdown: string): React.ReactNode {
  const lines = (markdown ?? '').replace(/\r\n/g, '\n').split('\n')
  const blocks: React.ReactNode[] = []
  let i = 0
  const key = (): number => blocks.length

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // Blank line: paragraph/block separator.
    if (!trimmed) {
      i++
      continue
    }

    // Fenced code block (``` or ~~~). Content is kept verbatim.
    const fence = trimmed.match(/^(```|~~~)/)
    if (fence) {
      const marker = fence[1]
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        code.push(lines[i])
        i++
      }
      i++ // consume the closing fence (if present)
      blocks.push(
        <pre
          key={key()}
          style={{
            margin: '10px 0',
            padding: '10px 12px',
            borderRadius: 8,
            background: 'rgba(10,14,28,0.66)',
            border: '1px solid rgba(120,150,220,0.16)',
            overflowX: 'auto',
            fontSize: 12,
            lineHeight: 1.5,
            color: '#9bccff',
            fontFamily:
              'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'
          }}
        >
          <code>{code.join('\n')}</code>
        </pre>
      )
      continue
    }

    // Heading.
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length
      const text = heading[2].replace(/\s+#+\s*$/, '') // strip trailing `###`
      const Tag = `h${level}` as keyof JSX.IntrinsicElements
      const SIZES: Record<number, number> = { 1: 21, 2: 18, 3: 16, 4: 14, 5: 13, 6: 12 }
      blocks.push(
        React.createElement(
          Tag,
          {
            key: key(),
            style: {
              margin: level <= 2 ? '16px 0 8px' : '12px 0 6px',
              fontSize: SIZES[level],
              fontWeight: 700,
              lineHeight: 1.3,
              color: level === 1 ? '#eaf1ff' : level === 2 ? '#dbe5fb' : '#cfe0ff',
              borderBottom:
                level <= 2 ? '1px solid rgba(120,150,220,0.14)' : undefined,
              paddingBottom: level <= 2 ? 4 : undefined
            }
          },
          inlineMarkdown(text)
        )
      )
      i++
      continue
    }

    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push(
        <hr
          key={key()}
          style={{
            border: 'none',
            borderTop: '1px solid rgba(120,150,220,0.22)',
            margin: '14px 0'
          }}
        />
      )
      i++
      continue
    }

    // Blockquote (consecutive `>` lines).
    if (trimmed.startsWith('>')) {
      const quote: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quote.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      blocks.push(
        <blockquote
          key={key()}
          style={{
            margin: '10px 0',
            padding: '2px 0 2px 12px',
            borderLeft: '3px solid rgba(122,162,255,0.45)',
            color: '#aebbd6',
            fontStyle: 'italic'
          }}
        >
          {inlineMarkdown(quote.join(' '))}
        </blockquote>
      )
      continue
    }

    // Ordered list (`1.` / `2)` ...).
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''))
        i++
      }
      blocks.push(
        <ol key={key()} style={{ margin: '8px 0', paddingLeft: 24, color: '#cfe0ff' }}>
          {items.map((it, idx) => (
            <li key={idx} style={{ margin: '3px 0', lineHeight: 1.5 }}>
              {inlineMarkdown(it)}
            </li>
          ))}
        </ol>
      )
      continue
    }

    // Unordered list (`-` / `*` / `+`).
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
        i++
      }
      blocks.push(
        <ul
          key={key()}
          style={{ margin: '8px 0', paddingLeft: 24, color: '#cfe0ff', listStyle: 'disc' }}
        >
          {items.map((it, idx) => (
            <li key={idx} style={{ margin: '3px 0', lineHeight: 1.5 }}>
              {inlineMarkdown(it)}
            </li>
          ))}
        </ul>
      )
      continue
    }

    // Paragraph: gather consecutive non-blank lines that don't start a new block.
    const para: string[] = [trimmed]
    i++
    while (i < lines.length) {
      const next = lines[i]
      const nt = next.trim()
      if (
        !nt ||
        /^(#{1,6})\s+/.test(nt) ||
        /^(```|~~~)/.test(nt) ||
        nt.startsWith('>') ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(nt) ||
        /^\s*[-*+]\s+/.test(next) ||
        /^\s*\d+[.)]\s+/.test(next)
      ) {
        break
      }
      para.push(nt)
      i++
    }
    blocks.push(
      <p key={key()} style={{ margin: '6px 0', lineHeight: 1.6, color: '#cfe0ff' }}>
        {inlineMarkdown(para.join(' '))}
      </p>
    )
  }

  return <>{blocks}</>
}

/**
 * Inline span parser: links, bold, italic, inline code. Plain text otherwise.
 * Greedy left-to-right; inline code is opaque (no nested parsing inside it).
 */
function inlineMarkdown(text: string): React.ReactNode {
  const parts: React.ReactNode[] = []
  let i = 0
  let buf = ''
  const flush = (): void => {
    if (buf) {
      parts.push(buf)
      buf = ''
    }
  }

  while (i < text.length) {
    const rest = text.slice(i)

    // [text](url)
    const link = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/)
    if (link) {
      flush()
      const href = sanitizeHref(link[2])
      if (href) {
        parts.push(
          <a
            key={parts.length}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#7aa2ff', textDecoration: 'underline', cursor: 'pointer' }}
          >
            {link[1]}
          </a>
        )
      } else {
        // Unsafe scheme (javascript:/data:/file:/…): render the label as plain text.
        parts.push(<span key={parts.length}>{link[1]}</span>)
      }
      i += link[0].length
      continue
    }

    // **bold** / __bold__
    const bold = rest.match(/^(\*\*|__)([^]+?)\1/)
    if (bold) {
      flush()
      parts.push(
        <strong key={parts.length} style={{ fontWeight: 700, color: '#eaf1ff' }}>
          {inlineMarkdown(bold[2])}
        </strong>
      )
      i += bold[0].length
      continue
    }

    // *italic* / _italic_
    const italic = rest.match(/^(\*|_)([^]+?)\1/)
    if (italic) {
      flush()
      parts.push(
        <em key={parts.length} style={{ fontStyle: 'italic', color: '#dbe5fb' }}>
          {inlineMarkdown(italic[2])}
        </em>
      )
      i += italic[0].length
      continue
    }

    // `code`
    const code = rest.match(/^`([^`]+)`/)
    if (code) {
      flush()
      parts.push(
        <code
          key={parts.length}
          style={{
            padding: '1px 5px',
            borderRadius: 4,
            background: 'rgba(120,150,220,0.16)',
            fontSize: '0.9em',
            color: '#9bccff',
            fontFamily:
              'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'
          }}
        >
          {code[1]}
        </code>
      )
      i += code[0].length
      continue
    }

    // Plain character.
    buf += text[i]
    i++
  }
  flush()

  return <>{parts}</>
}
