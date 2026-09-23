/**
 * Presentation tokens shared by the StarBridge browser components.
 *
 * The harness theme is exposed as CSS custom properties (`--dsw-*`), so the
 * panels are styled with inline objects that reference those variables and fall
 * back to neutral values. That keeps the plugin's look aligned with whatever
 * theme the user selected without reading theme state, and without shipping a
 * stylesheet, which is one less lifecycle to manage on unload.
 *
 * @module dsh-starbridge-client/client/theme
 */

import type { CSSProperties } from 'react'

/** Read a theme variable with a literal fallback. */
function token(name: string, fallback: string): string {
  return `var(${name}, ${fallback})`
}

/** Resolved colour and spacing tokens. */
export const tokens = {
  bg: token('--dsw-alias-bg-base', '#0f1115'),
  bgElevated: token('--dsw-alias-bg-elevated', '#151922'),
  bgSubtle: token('--dsw-alias-bg-subtle', '#1b2029'),
  border: token('--dsw-alias-border-base', '#262b36'),
  text: token('--dsw-alias-text-base', '#e6e8ee'),
  textMuted: token('--dsw-alias-text-secondary', '#9aa3b2'),
  accent: token('--dsw-alias-brand-primary', '#4d7cfe'),
  accentText: token('--dsw-alias-brand-primary-contrast', '#ffffff'),
  danger: token('--dsw-alias-danger-base', '#e5484d'),
  success: token('--dsw-alias-success-base', '#30a46c'),
  warning: token('--dsw-alias-warning-base', '#f5a524'),
  radius: token('--dsw-alias-radius-md', '8px'),
  radiusSmall: token('--dsw-alias-radius-sm', '6px'),
  fontMono: token('--dsw-font-mono', 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'),
} as const

/** Shared style objects. */
export const styles = {
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    padding: '16px',
    height: '100%',
    minHeight: '320px',
    color: tokens.text,
    background: tokens.bg,
    boxSizing: 'border-box',
  } satisfies CSSProperties,

  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    flexWrap: 'wrap',
  } satisfies CSSProperties,

  title: {
    fontSize: '14px',
    fontWeight: 600,
    margin: 0,
  } satisfies CSSProperties,

  subtitle: {
    fontSize: '12px',
    color: tokens.textMuted,
    margin: 0,
  } satisfies CSSProperties,

  transcript: {
    flex: '1 1 auto',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    padding: '4px',
    minHeight: '160px',
  } satisfies CSSProperties,

  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    padding: '8px 12px',
    borderRadius: tokens.radius,
    background: tokens.accent,
    color: tokens.accentText,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  } satisfies CSSProperties,

  assistantBubble: {
    alignSelf: 'flex-start',
    maxWidth: '92%',
    padding: '10px 12px',
    borderRadius: tokens.radius,
    background: tokens.bgElevated,
    border: `1px solid ${tokens.border}`,
    wordBreak: 'break-word',
  } satisfies CSSProperties,

  systemBubble: {
    alignSelf: 'stretch',
    padding: '8px 12px',
    borderRadius: tokens.radiusSmall,
    background: tokens.bgSubtle,
    border: `1px solid ${tokens.border}`,
    color: tokens.textMuted,
    fontSize: '12px',
  } satisfies CSSProperties,

  composer: {
    display: 'flex',
    gap: '8px',
    alignItems: 'flex-end',
  } satisfies CSSProperties,

  textarea: {
    flex: '1 1 auto',
    minHeight: '44px',
    maxHeight: '180px',
    resize: 'vertical',
    padding: '10px 12px',
    borderRadius: tokens.radius,
    border: `1px solid ${tokens.border}`,
    background: tokens.bgElevated,
    color: tokens.text,
    font: 'inherit',
    boxSizing: 'border-box',
  } satisfies CSSProperties,

  button: {
    padding: '9px 14px',
    borderRadius: tokens.radius,
    border: `1px solid ${tokens.border}`,
    background: tokens.bgElevated,
    color: tokens.text,
    font: 'inherit',
    cursor: 'pointer',
  } satisfies CSSProperties,

  primaryButton: {
    padding: '9px 14px',
    borderRadius: tokens.radius,
    border: '1px solid transparent',
    background: tokens.accent,
    color: tokens.accentText,
    font: 'inherit',
    fontWeight: 600,
    cursor: 'pointer',
  } satisfies CSSProperties,

  codeBlock: {
    margin: '8px 0',
    padding: '10px 12px',
    borderRadius: tokens.radiusSmall,
    background: tokens.bgSubtle,
    border: `1px solid ${tokens.border}`,
    overflowX: 'auto',
    fontFamily: tokens.fontMono,
    fontSize: '12.5px',
    lineHeight: 1.55,
  } satisfies CSSProperties,

  inlineCode: {
    padding: '1px 5px',
    borderRadius: '4px',
    background: tokens.bgSubtle,
    border: `1px solid ${tokens.border}`,
    fontFamily: tokens.fontMono,
    fontSize: '0.92em',
  } satisfies CSSProperties,

  notice: {
    padding: '10px 12px',
    borderRadius: tokens.radius,
    border: `1px solid ${tokens.border}`,
    background: tokens.bgElevated,
    fontSize: '13px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  } satisfies CSSProperties,

  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
  } satisfies CSSProperties,

  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    marginBottom: '12px',
  } satisfies CSSProperties,

  label: {
    fontSize: '12px',
    color: tokens.textMuted,
  } satisfies CSSProperties,

  input: {
    padding: '8px 10px',
    borderRadius: tokens.radiusSmall,
    border: `1px solid ${tokens.border}`,
    background: tokens.bgElevated,
    color: tokens.text,
    font: 'inherit',
    boxSizing: 'border-box',
    width: '100%',
  } satisfies CSSProperties,

  badge: {
    fontSize: '11px',
    padding: '2px 7px',
    borderRadius: '999px',
    border: `1px solid ${tokens.border}`,
    color: tokens.textMuted,
    whiteSpace: 'nowrap',
  } satisfies CSSProperties,

  feedbackBar: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    marginTop: '8px',
  } satisfies CSSProperties,

  feedbackButton: {
    padding: '3px 8px',
    fontSize: '11px',
    borderRadius: tokens.radiusSmall,
    border: `1px solid ${tokens.border}`,
    background: 'transparent',
    color: tokens.textMuted,
    cursor: 'pointer',
    font: 'inherit',
  } satisfies CSSProperties,
} as const

/** Per-token colours for highlighted code. */
export const tokenColors: Record<string, string> = {
  plain: tokens.text,
  keyword: token('--dsw-alias-code-keyword', '#c792ea'),
  string: token('--dsw-alias-code-string', '#a5d6a7'),
  comment: token('--dsw-alias-code-comment', '#6b7d8f'),
  number: token('--dsw-alias-code-number', '#f78c6c'),
  function: token('--dsw-alias-code-function', '#82aaff'),
  type: token('--dsw-alias-code-type', '#ffcb6b'),
  operator: token('--dsw-alias-code-operator', '#89ddff'),
}
