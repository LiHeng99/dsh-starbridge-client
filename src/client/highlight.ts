/**
 * Source highlighting for the chat panel's code blocks.
 *
 * A dedicated syntax-highlighting package would have to be declared in
 * `dsh.client.external` and answered by another plugin row, which turns a
 * presentation detail into a deployment dependency. Instead this module is a
 * small, dependency-free scanner: enough to make a code answer readable
 * (keywords, strings, comments, numbers, function names) for the languages a
 * company assistant actually emits, with graceful degradation to plain text for
 * everything else.
 *
 * The scanner is intentionally NOT a parser. It never produces HTML — it
 * returns token spans that React renders as elements — so no `innerHTML` and no
 * injection surface exists anywhere in the rendering path.
 *
 * @module @company/dsh-starbridge-client/client/highlight
 */

/** Token categories the panel styles. */
export type TokenKind = 'plain' | 'keyword' | 'string' | 'comment' | 'number' | 'function' | 'type' | 'operator'

/** One highlighted span. */
export interface Token {
  /** Category, mapped to a CSS class by the renderer. */
  readonly kind: TokenKind
  /** Literal source text. */
  readonly text: string
}

/** Language families sharing one scanner. */
type Family = 'clike' | 'python' | 'shell' | 'sql' | 'markup' | 'css' | 'yaml' | 'json' | 'plain'

/** Keyword sets per family. Kept small and high-signal on purpose. */
const KEYWORDS: Record<Exclude<Family, 'plain'>, readonly string[]> = {
  clike: [
    'abstract', 'any', 'as', 'async', 'await', 'boolean', 'break', 'case', 'catch', 'class', 'const', 'constructor',
    'continue', 'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
    'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'is', 'keyof', 'let',
    'namespace', 'new', 'null', 'number', 'object', 'of', 'private', 'protected', 'public', 'readonly', 'return',
    'satisfies', 'set', 'static', 'string', 'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof',
    'undefined', 'var', 'void', 'while', 'yield',
  ],
  python: [
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
    'False', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'None', 'nonlocal', 'not',
    'or', 'pass', 'raise', 'return', 'True', 'try', 'while', 'with', 'yield', 'self', 'match', 'case',
  ],
  shell: [
    'case', 'do', 'done', 'elif', 'else', 'esac', 'export', 'fi', 'for', 'function', 'if', 'in', 'local', 'return',
    'then', 'until', 'while', 'source', 'set', 'echo', 'cd', 'sudo',
  ],
  sql: [
    'ALTER', 'AND', 'AS', 'ASC', 'BEGIN', 'BY', 'CASE', 'COMMIT', 'CREATE', 'DELETE', 'DESC', 'DISTINCT', 'DROP',
    'ELSE', 'END', 'EXISTS', 'FROM', 'GROUP', 'HAVING', 'IN', 'INDEX', 'INNER', 'INSERT', 'INTO', 'JOIN', 'LEFT',
    'LIKE', 'LIMIT', 'NOT', 'NULL', 'ON', 'OR', 'ORDER', 'OUTER', 'PRIMARY', 'ROLLBACK', 'SELECT', 'SET', 'TABLE',
    'THEN', 'UNION', 'UPDATE', 'VALUES', 'WHEN', 'WHERE', 'WITH',
  ],
  markup: [],
  css: [],
  yaml: ['true', 'false', 'null', 'yes', 'no'],
  json: ['true', 'false', 'null'],
}

/**
 * Map an info-string language name onto a scanner family.
 *
 * @param language - the fence info string, e.g. `ts`, `Python`, `bash`.
 * @returns the family whose scanner should run.
 */
export function familyOf(language: string): Family {
  const name = language.trim().toLowerCase()
  if (name.length === 0) return 'plain'
  if (['ts', 'tsx', 'typescript', 'js', 'jsx', 'javascript', 'mjs', 'cjs', 'java', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'csharp', 'go', 'golang', 'rust', 'rs', 'swift', 'kotlin', 'kt', 'scala', 'php', 'dart'].includes(name)) return 'clike'
  if (['py', 'python', 'python3'].includes(name)) return 'python'
  if (['sh', 'bash', 'zsh', 'shell', 'console', 'powershell', 'ps1', 'pwsh', 'cmd', 'bat'].includes(name)) return 'shell'
  if (['sql', 'postgres', 'postgresql', 'mysql', 'sqlite'].includes(name)) return 'sql'
  if (['json', 'jsonc', 'json5'].includes(name)) return 'json'
  if (['yaml', 'yml'].includes(name)) return 'yaml'
  if (['html', 'xml', 'svg', 'vue', 'svelte'].includes(name)) return 'markup'
  if (['css', 'scss', 'sass', 'less'].includes(name)) return 'css'
  return 'plain'
}

/** Whether a character can start or continue an identifier. */
function isWordChar(character: string): boolean {
  return /[A-Za-z0-9_$]/.test(character)
}

/** Whether a language's comments use `#` line markers. */
function usesHashComments(family: Family): boolean {
  return family === 'python' || family === 'shell' || family === 'yaml'
}

/**
 * Tokenize source text for one language.
 *
 * Single forward pass: at each position the scanner tries comment, string,
 * number, identifier, and operator/punctuation in that order, then falls back to
 * consuming one plain character. Nothing is ever re-scanned, so a pathological
 * input cannot blow up.
 *
 * @param code - the code block's source.
 * @param language - the fence info string.
 * @returns the token list, covering the input exactly.
 */
export function tokenize(code: string, language: string): Token[] {
  const family = familyOf(language)
  if (family === 'plain') return code.length === 0 ? [] : [{ kind: 'plain', text: code }]

  const keywords = KEYWORDS[family as Exclude<Family, 'plain'>]
  const keywordSet = new Set(family === 'sql'
    ? keywords.map((word) => word.toUpperCase())
    : family === 'clike' || family === 'python'
      ? keywords
      : keywords)
  const caseInsensitiveKeywords = family === 'sql'

  const tokens: Token[] = []
  let plain = ''
  let index = 0

  const push = (kind: TokenKind, text: string): void => {
    if (text.length === 0) return
    if (kind === 'plain') {
      plain += text
      return
    }
    if (plain.length > 0) {
      tokens.push({ kind: 'plain', text: plain })
      plain = ''
    }
    const last = tokens[tokens.length - 1]
    if (last !== undefined && last.kind === kind) {
      tokens[tokens.length - 1] = { kind, text: last.text + text }
      return
    }
    tokens.push({ kind, text })
  }

  while (index < code.length) {
    const rest = code.slice(index)
    const character = code[index] ?? ''

    // Line comments.
    if (rest.startsWith('//') && !usesHashComments(family)) {
      const end = code.indexOf('\n', index)
      const stop = end === -1 ? code.length : end
      push('comment', code.slice(index, stop))
      index = stop
      continue
    }
    if (rest.startsWith('#') && usesHashComments(family)) {
      const end = code.indexOf('\n', index)
      const stop = end === -1 ? code.length : end
      push('comment', code.slice(index, stop))
      index = stop
      continue
    }
    if (rest.startsWith('--') && family === 'sql') {
      const end = code.indexOf('\n', index)
      const stop = end === -1 ? code.length : end
      push('comment', code.slice(index, stop))
      index = stop
      continue
    }
    // Block comments (C-like, CSS, SQL).
    if (rest.startsWith('/*')) {
      const end = code.indexOf('*/', index + 2)
      const stop = end === -1 ? code.length : end + 2
      push('comment', code.slice(index, stop))
      index = stop
      continue
    }
    if (family === 'markup' && rest.startsWith('<!--')) {
      const end = code.indexOf('-->', index + 4)
      const stop = end === -1 ? code.length : end + 3
      push('comment', code.slice(index, stop))
      index = stop
      continue
    }

    // Strings, including triple-quoted Python strings.
    if (family === 'python' && (rest.startsWith('"""') || rest.startsWith("'''"))) {
      const marker = rest.slice(0, 3)
      const end = code.indexOf(marker, index + 3)
      const stop = end === -1 ? code.length : end + 3
      push('string', code.slice(index, stop))
      index = stop
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      let cursor = index + 1
      while (cursor < code.length) {
        const current = code[cursor]
        if (current === '\\') {
          cursor += 2
          continue
        }
        if (current === character) {
          cursor += 1
          break
        }
        if (current === '\n' && character !== '`') break
        cursor += 1
      }
      push('string', code.slice(index, cursor))
      index = cursor
      continue
    }

    // Numbers (including 0x/0b literals and decimal fractions).
    if (/[0-9]/.test(character) && !isWordChar(code[index - 1] ?? '')) {
      const match = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/.exec(rest)
      if (match !== null) {
        push('number', match[0])
        index += match[0].length
        continue
      }
    }

    // Identifiers: keyword, type-ish name, call target, or plain.
    if (/[A-Za-z_$]/.test(character)) {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest)
      const word = match === null ? character : match[0]
      const comparison = caseInsensitiveKeywords ? word.toUpperCase() : word
      const next = code[index + word.length]
      if (keywordSet.has(comparison)) push('keyword', word)
      else if (next === '(') push('function', word)
      else if (/^[A-Z]/.test(word)) push('type', word)
      else push('plain', word)
      index += word.length
      continue
    }

    // Operators and punctuation get their own span so the renderer can dim them.
    if (/[+\-*/%=<>!&|^~?:;,.()[\]{}]/.test(character)) {
      push('operator', character)
      index += 1
      continue
    }

    push('plain', character)
    index += 1
  }

  push('plain', '')
  if (plain.length > 0) tokens.push({ kind: 'plain', text: plain })
  return tokens
}
