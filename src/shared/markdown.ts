/**
 * Dependency-free Markdown parser for the StarBridge chat panel.
 *
 * Why not a library: a DSH client bundle may only require modules the shell
 * seeds (`react`, `react-dom`, `@deepseek-ai/cordis`, the UI kits). Anything
 * else has to be declared in `dsh.client.external` and shipped by another
 * plugin row, so a general Markdown package would turn a presentation detail
 * into a deployment dependency. This parser therefore ships inside the bundle:
 * pure data in, pure data out, no DOM and no React, which also makes it
 * directly unit-testable from `scripts/verify.mjs` under plain Node.
 *
 * Supported: ATX headings, fenced code, tables, blockquotes, ordered and
 * bullet lists, thematic breaks, paragraphs, and inline code / strong /
 * emphasis / links / bare URLs. Raw HTML is deliberately NOT interpreted — it
 * renders as text, so a gateway reply can never inject markup into the harness
 * UI.
 *
 * @module @company/dsh-starbridge-client/markdown
 */

/** Inline span kinds the panel knows how to render. */
export type InlineNode =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly children: readonly InlineNode[] }
  | { readonly kind: 'em'; readonly children: readonly InlineNode[] }
  | { readonly kind: 'link'; readonly href: string; readonly children: readonly InlineNode[] }

/** Block kinds the panel knows how to render. */
export type BlockNode =
  | { readonly kind: 'heading'; readonly level: number; readonly children: readonly InlineNode[] }
  | { readonly kind: 'paragraph'; readonly children: readonly InlineNode[] }
  | { readonly kind: 'code'; readonly language: string; readonly value: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly (readonly InlineNode[])[] }
  | { readonly kind: 'quote'; readonly lines: readonly (readonly InlineNode[])[] }
  | { readonly kind: 'table'; readonly header: readonly (readonly InlineNode[])[]; readonly rows: readonly (readonly (readonly InlineNode[])[])[] }
  | { readonly kind: 'rule' }

/** Fence marker line: ``` or ~~~ with an optional info string. */
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)\s*$/
/** ATX heading line. */
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
/** Thematic break line. */
const RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/
/** Unordered list item. */
const BULLET = /^(\s*)([-*+])\s+(.*)$/
/** Ordered list item. */
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
/** Blockquote line. */
const QUOTE = /^ {0,3}>\s?(.*)$/
/** Table delimiter row, e.g. `| --- | :--: |`. */
const TABLE_DELIMITER = /^ {0,3}\|?[\s:|-]+\|[\s:|-]*$/
/** A bare http(s) URL inside text. */
const BARE_URL = /^(https?:\/\/[^\s<>()[\]]+)/

/**
 * Split a table row into trimmed cells, tolerating leading/trailing pipes.
 * @param line - raw table row.
 * @returns the cell texts in column order.
 */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

/**
 * Parse inline markup in one span of text.
 *
 * Deliberately single-pass and non-backtracking: `**bold**`, `*em*`, `` `code` ``
 * and `[label](href)` are recognised left to right, and anything unterminated
 * stays literal text. That keeps a half-streamed model reply stable to render.
 *
 * @param text - raw inline source.
 * @returns the inline node list.
 */
export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = []
  let buffer = ''
  let index = 0

  const flush = (): void => {
    if (buffer.length > 0) {
      nodes.push({ kind: 'text', text: buffer })
      buffer = ''
    }
  }

  while (index < text.length) {
    const rest = text.slice(index)

    // Code span wins over every other marker so `**` inside it stays literal.
    if (rest.startsWith('`')) {
      const ticks = /^`+/.exec(rest)?.[0] ?? '`'
      const close = text.indexOf(ticks, index + ticks.length)
      if (close !== -1) {
        flush()
        nodes.push({ kind: 'code', text: text.slice(index + ticks.length, close).trim() })
        index = close + ticks.length
        continue
      }
    }

    // Strong: **text** or __text__.
    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest)
    if (strong?.[2] !== undefined) {
      flush()
      nodes.push({ kind: 'strong', children: parseInline(strong[2]) })
      index += strong[0].length
      continue
    }

    // Emphasis: *text* or _text_ (single marker, must hug non-space content).
    const em = /^(\*|_)(?=\S)([\s\S]*?\S)\1/.exec(rest)
    if (em?.[2] !== undefined) {
      flush()
      nodes.push({ kind: 'em', children: parseInline(em[2]) })
      index += em[0].length
      continue
    }

    // Link: [label](href).
    const link = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest)
    if (link?.[1] !== undefined && link[2] !== undefined) {
      flush()
      nodes.push({ kind: 'link', href: link[2], children: parseInline(link[1]) })
      index += link[0].length
      continue
    }

    // Bare URL, so a gateway reply can cite a source without Markdown syntax.
    const bare = text.startsWith('http', index) ? BARE_URL.exec(rest) : null
    if (bare?.[1] !== undefined) {
      flush()
      const href = bare[1]
      nodes.push({ kind: 'link', href, children: [{ kind: 'text', text: href }] })
      index += href.length
      continue
    }

    buffer += text[index]
    index += 1
  }

  flush()
  return nodes
}

/**
 * Parse a Markdown document into render-ready blocks.
 *
 * @param source - full assistant reply text.
 * @returns the block list, in document order.
 */
export function parseMarkdown(source: string): BlockNode[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: BlockNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''

    if (line.trim().length === 0) {
      i += 1
      continue
    }

    // Fenced code block: consume until the matching fence or end of input.
    const fence = FENCE.exec(line)
    if (fence?.[1] !== undefined) {
      const marker = fence[1]
      const language = fence[2] ?? ''
      const body: string[] = []
      i += 1
      while (i < lines.length) {
        const candidate = lines[i] ?? ''
        if (candidate.trim().startsWith(marker)) {
          i += 1
          break
        }
        body.push(candidate)
        i += 1
      }
      blocks.push({ kind: 'code', language, value: body.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading?.[1] !== undefined) {
      blocks.push({
        kind: 'heading',
        level: heading[1].length,
        children: parseInline(heading[2] ?? ''),
      })
      i += 1
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      i += 1
      continue
    }

    // Table: a row followed by a delimiter row.
    if (line.includes('|') && TABLE_DELIMITER.test(lines[i + 1] ?? '')) {
      const header = splitRow(line).map(parseInline)
      const rows: InlineNode[][][] = []
      i += 2
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim().length > 0) {
        rows.push(splitRow(lines[i] ?? '').map(parseInline))
        i += 1
      }
      blocks.push({ kind: 'table', header, rows })
      continue
    }

    // Blockquote: consecutive `>` lines, rendered as separate paragraphs.
    if (QUOTE.test(line)) {
      const quoted: InlineNode[][] = []
      while (i < lines.length && QUOTE.test(lines[i] ?? '')) {
        quoted.push(parseInline(QUOTE.exec(lines[i] ?? '')?.[1] ?? ''))
        i += 1
      }
      blocks.push({ kind: 'quote', lines: quoted })
      continue
    }

    // Lists: one block per run of same-kind markers.
    const bullet = BULLET.exec(line)
    const ordered = ORDERED.exec(line)
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null
      const items: InlineNode[][] = []
      while (i < lines.length) {
        const current = lines[i] ?? ''
        const nextOrdered = ORDERED.exec(current)
        const nextBullet = BULLET.exec(current)
        if (isOrdered && nextOrdered !== null) items.push(parseInline(nextOrdered[3] ?? ''))
        else if (!isOrdered && nextBullet !== null) items.push(parseInline(nextBullet[3] ?? ''))
        else if (current.trim().length === 0) break
        else if (/^\s{2,}\S/.test(current) && items.length > 0) {
          // Continuation line of the previous item.
          const previous = items[items.length - 1] ?? []
          items[items.length - 1] = [...previous, { kind: 'text', text: ' ' }, ...parseInline(current.trim())]
        } else break
        i += 1
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items })
      continue
    }

    // Paragraph: consume until a blank line or a line that starts another block.
    const paragraph: string[] = []
    while (i < lines.length) {
      const current = lines[i] ?? ''
      if (
        current.trim().length === 0
        || FENCE.test(current)
        || HEADING.test(current)
        || RULE.test(current)
        || QUOTE.test(current)
        || BULLET.test(current)
        || ORDERED.test(current)
      ) break
      paragraph.push(current.trim())
      i += 1
    }
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join(' ')) })
  }

  return blocks
}
