/**
 * Markdown renderer for StarBridge assistant replies.
 *
 * Renders the block/inline tree produced by `shared/markdown.ts` as React
 * elements. No HTML string is ever produced, so a reply — which is untrusted
 * company-gateway output — cannot inject markup into the harness UI.
 *
 * @module dsh-starbridge-client/client/MarkdownView
 */

import type { CSSProperties, ReactElement, ReactNode } from 'react'

import { parseMarkdown, type BlockNode, type InlineNode } from '../shared/markdown.ts'
import { tokenize } from './highlight.ts'
import { styles, tagStyle, text, tokenColors, tokens } from './theme.ts'

/** Props of {@link MarkdownView}. */
export interface MarkdownViewProps {
  /** Raw Markdown source. */
  source: string
}

/**
 * Render one inline node tree.
 *
 * @param nodes - inline nodes from the parser.
 * @param keyPrefix - stable key prefix for React reconciliation.
 * @returns React children.
 */
function renderInline(nodes: readonly InlineNode[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`
    switch (node.kind) {
      case 'text':
        return node.text
      case 'code':
        return <code key={key} style={styles.inlineCode}>{node.text}</code>
      case 'strong':
        return <strong key={key}>{renderInline(node.children, key)}</strong>
      case 'em':
        return <em key={key}>{renderInline(node.children, key)}</em>
      case 'link':
        return (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: tokens.link, textDecoration: 'underline' }}
          >
            {renderInline(node.children, key)}
          </a>
        )
      default:
        return null
    }
  })
}

/**
 * Render a fenced code block with token highlighting.
 *
 * @param language - fence info string.
 * @param value - block source.
 * @param key - React key.
 * @returns the rendered block.
 */
function renderCodeBlock(language: string, value: string, key: string): ReactElement {
  const tokensOfCode = tokenize(value, language)
  return (
    <div key={key} style={{ margin: '8px 0' }}>
      {language.length > 0 && (
        <div style={{ ...tagStyle('outline'), display: 'inline-block', marginBottom: '4px' }}>{language}</div>
      )}
      <pre style={styles.codeBlock}>
        <code>
          {tokensOfCode.map((token, index) => (
            <span
              key={`${key}-t${index}`}
              style={token.kind === 'plain' ? undefined : { color: tokenColors[token.kind] }}
            >
              {token.text}
            </span>
          ))}
        </code>
      </pre>
    </div>
  )
}

/** Heading sizes, indexed by level. */
const HEADING_SIZE: Record<number, string> = {
  1: '1.35em',
  2: '1.2em',
  3: '1.08em',
  4: '1em',
  5: '0.95em',
  6: '0.9em',
}

/**
 * Render one block node.
 *
 * @param block - block node from the parser.
 * @param index - position in the document, used for keys.
 * @returns the rendered element.
 */
function renderBlock(block: BlockNode, index: number): ReactElement | null {
  const key = `b${index}`
  switch (block.kind) {
    case 'heading':
      return (
        <div
          key={key}
          style={{
            fontSize: HEADING_SIZE[block.level] ?? '1em',
            fontWeight: 600,
            margin: '10px 0 4px',
          }}
        >
          {renderInline(block.children, key)}
        </div>
      )
    case 'paragraph':
      return (
        <p key={key} style={{ margin: '6px 0', lineHeight: 1.6 }}>
          {renderInline(block.children, key)}
        </p>
      )
    case 'code':
      return renderCodeBlock(block.language, block.value, key)
    case 'list':
      return block.ordered
        ? (
            <ol key={key} style={{ margin: '6px 0', paddingLeft: '22px', lineHeight: 1.6 }}>
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-i${itemIndex}`}>{renderInline(item, `${key}-i${itemIndex}`)}</li>
              ))}
            </ol>
          )
        : (
            <ul key={key} style={{ margin: '6px 0', paddingLeft: '22px', lineHeight: 1.6 }}>
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-i${itemIndex}`}>{renderInline(item, `${key}-i${itemIndex}`)}</li>
              ))}
            </ul>
          )
    case 'quote':
      return (
        <blockquote
          key={key}
          style={{
            margin: '8px 0',
            paddingLeft: '10px',
            borderLeft: `2px solid ${tokens.borderL2}`,
            color: tokens.textMuted,
          }}
        >
          {block.lines.map((line, lineIndex) => (
            <p key={`${key}-l${lineIndex}`} style={{ margin: '4px 0' }}>
              {renderInline(line, `${key}-l${lineIndex}`)}
            </p>
          ))}
        </blockquote>
      )
    case 'table':
      return (
        <div key={key} style={{ overflowX: 'auto', margin: '8px 0' }}>
          <table style={{ borderCollapse: 'collapse', ...text.caption }}>
            <thead>
              <tr>
                {block.header.map((cell, cellIndex) => (
                  <th
                    key={`${key}-h${cellIndex}`}
                    style={{
                      border: `0.5px solid ${tokens.borderL2}`,
                      padding: '5px 9px',
                      textAlign: 'left',
                      fontWeight: 600,
                      background: tokens.bgModulePlatform,
                    }}
                  >
                    {renderInline(cell, `${key}-h${cellIndex}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${key}-r${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`${key}-r${rowIndex}c${cellIndex}`}
                      style={{ border: `0.5px solid ${tokens.borderL2}`, padding: '5px 9px' }}
                    >
                      {renderInline(cell, `${key}-r${rowIndex}c${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'rule':
      return (
        <hr
          key={key}
          style={{ border: 'none', borderTop: `0.5px solid ${tokens.borderL2}`, margin: '10px 0' } satisfies CSSProperties}
        />
      )
    default:
      return null
  }
}

/**
 * Render Markdown source.
 *
 * @param props - the source text.
 * @returns the rendered document.
 */
export function MarkdownView({ source }: MarkdownViewProps): ReactElement {
  const blocks = parseMarkdown(source)
  return <div>{blocks.map((block, index) => renderBlock(block, index))}</div>
}
