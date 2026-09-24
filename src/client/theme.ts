/**
 * Presentation layer shared by the StarBridge browser components.
 *
 * Two things were wrong with the first cut of this module, and both explain the
 * shape it has now.
 *
 * 1. **It named variables the harness does not define.** Every name it used for
 *    text, surfaces, borders, state colours, the monospace family and the corner
 *    radii was invented; DSH's real vocabulary is `label-primary`,
 *    `bg-layer-1..3`, `border-l1..4`, `state-error-primary`,
 *    `font-markdown-code`, and it ships no radius token at all. An unknown
 *    `var()` silently resolves to its fallback, and every fallback here was a
 *    dark palette — so the plugin painted itself dark inside DSH's light
 *    settings panel. Each token below is now a real variable read out of
 *    `@deepseek-ai/dsh-client-ui-theme` (the package that defines them on `body`,
 *    with a `body[data-ds-dark-theme]` override), carrying the light-theme
 *    literal as its fallback — the same convention `dshmarket` uses. The
 *    verifier's `no invented token` check keeps the vocabulary honest.
 * 2. **Inline styles cannot express state.** `:hover`, `:focus-visible`,
 *    `::placeholder`, `:disabled` and the `+` sibling separator are not
 *    properties of a `CSSProperties` object, so a control built that way can
 *    never behave like a DSH control. Those states therefore live in one small
 *    stylesheet, injected once behind the same `data-plugin-css` idempotence
 *    guard the harness's own client packages use. Everything that needs no
 *    state stays inline, which is why most of the components' element trees are
 *    unchanged.
 *
 * Geometry is literal because DSH ships no radius token: 8px for fields, 12px
 * for inset panels, 16px for cards, 22px for the user bubble — the values the
 * harness's own settings fields, plugin cards and chat bubble use. Font ramps
 * are read as longhands rather than through the `font` shorthand, because React
 * writes a style object's declarations in key order and the shorthand resets
 * `font-weight`; see {@link font}.
 *
 * @module dsh-starbridge-client/client/theme
 */

import type { CSSProperties } from 'react'

/** Read a theme variable with a literal fallback. */
function token(name: string, fallback: string): string {
  return `var(${name}, ${fallback})`
}

/** Tint a state colour the way the harness's Tag primitive does. */
function tint(name: string, fallback: string, percent: number): string {
  return `color-mix(in srgb, ${token(name, fallback)} ${percent}%, transparent)`
}

/** The harness font stack, used when `--dsw-font-family` is unavailable. */
const FALLBACK_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'

/** Fallback metrics for the ramps reachable through {@link font}. */
const RAMP_FALLBACK: Record<string, readonly [string, string]> = {
  's-14': ['14px', '22px'],
  'xs-13': ['13px', '20px'],
  'xxs-12': ['12px', '18px'],
  'xxxs-11': ['11px', '14px'],
}

/**
 * Read one harness font ramp as longhands.
 *
 * The `font` shorthand cannot be combined with an explicit `fontWeight` here:
 * React emits a style object's declarations in key order, and `font` resets
 * `font-weight`, so the result would depend on which key happened to come first.
 * DSH publishes each ramp as `-font-family`/`-font-size`/`-line-height`
 * longhands as well, so those are read instead and the weight stays ours.
 *
 * @param ramp - ramp name without the `--dsw-font-` prefix, e.g. `s-14`.
 * @returns the three longhands for that ramp.
 */
function font(ramp: 's-14' | 'xs-13' | 'xxs-12' | 'xxxs-11'): CSSProperties {
  const [size, lineHeight] = RAMP_FALLBACK[ramp] ?? ['14px', '22px']
  return {
    fontFamily: token(`--dsw-font-${ramp}-font-family`, FALLBACK_FONT),
    fontSize: token(`--dsw-font-${ramp}-font-size`, size),
    lineHeight: token(`--dsw-font-${ramp}-line-height`, lineHeight),
  }
}

/** The monospace ramp DSH uses for code, as longhands. */
function codeFont(): CSSProperties {
  return {
    fontFamily: token('--dsw-font-markdown-code-font-family', 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'),
    fontSize: token('--dsw-font-markdown-code-font-size', '12px'),
    lineHeight: token('--dsw-font-markdown-code-line-height', '19px'),
  }
}

/**
 * Resolved colour tokens.
 *
 * The comment on each group names the harness surface the value is taken from,
 * so a future reviewer can re-derive it rather than guess.
 */
export const tokens = {
  // Surfaces. DSH separates its cards with a hairline border rather than a fill:
  // in the light theme every background layer resolves to the same white.
  bg: token('--dsw-alias-bg-base', '#ffffff'),
  bgLayer3: token('--dsw-alias-bg-layer-3', '#ffffff'),
  bgModulePlatform: token('--dsw-alias-bg-module-platform', '#f5f6f7'),
  /** The harness chat bubble (`--dsw-specific-bubble`), used for user turns. */
  bubble: token('--dsw-specific-bubble', '#edf3fe'),
  /**
   * The harness composer surface (`--dsw-specific-input-major`). The settings
   * panel's own single-line inputs sit on `bg-layer-3`; a multi-line composer
   * gets its own token, and the chat and correction boxes are the latter.
   */
  inputMajor: token('--dsw-specific-input-major', '#ffffff'),

  // Hairlines. DSH draws every card, field and divider with one of these four
  // and almost always at 0.5px.
  borderL1: token('--dsw-alias-border-l1', '#0000000a'),
  borderL2: token('--dsw-alias-border-l2', '#0000001a'),
  borderL3: token('--dsw-alias-border-l3', '#0000001f'),
  borderL4: token('--dsw-alias-border-l4', '#00000029'),

  // Text ramp: primary > secondary > tertiary > dimmed.
  text: token('--dsw-alias-label-primary', '#0f1115'),
  textSecondary: token('--dsw-alias-label-secondary', '#61666b'),
  textMuted: token('--dsw-alias-label-tertiary', '#81858c'),
  textDimmed: token('--dsw-alias-label-dimmed', '#e1e5ee'),
  /** Foreground for a filled primary button. */
  textOnPrimary: token('--dsw-alias-label-primary-foreground', '#ffffff'),

  // Brand. In DSH the brand colour is monochrome (near-black in light, near-white
  // in dark), so a filled primary button is ink-on-paper rather than blue.
  accent: token('--dsw-alias-brand-primary', '#0f1115'),
  primaryFill: token('--dsw-alias-button-primary-fill', '#0f1115'),
  primaryHover: token('--dsw-alias-button-primary-hover', '#43454a'),
  /** Interaction fill for hover on any non-filled surface. */
  ghostHover: token('--dsw-alias-interactive-bg-hover', '#2631480f'),
  ghostActive: token('--dsw-alias-interactive-bg-active', '#2631481a'),

  // State colours, with the 10%-tint fills the harness Tag and Toast use.
  danger: token('--dsw-alias-state-error-primary', '#ec1313'),
  dangerTint: tint('--dsw-alias-state-error-primary', '#ec1313', 8),
  success: token('--dsw-alias-state-success-primary', '#22c55e'),
  successTint: tint('--dsw-alias-state-success-primary', '#22c55e', 10),
  warning: token('--dsw-alias-state-warn-primary', '#f59e0b'),
  warningTint: tint('--dsw-alias-state-warn-primary', '#f59e0b', 12),
  warningLabel: token('--dsw-alias-state-warn-label', '#dd8629'),
  /** The blue DSH spends on links, selections and "this one is active". */
  info: token('--dsw-alias-state-business-primary', '#4176e6'),
  infoTint: tint('--dsw-alias-state-business-primary', '#4176e6', 8),
  link: token('--dsw-alias-link', '#4176e6'),

  // Code surfaces.
  codeBlock: token('--dsw-alias-markdown-code-block', '#f9fafb'),
  inlineCode: token('--dsw-alias-markdown-inline-code', '#fafafa'),
} as const

/**
 * Type ramps, as ready-to-spread style objects.
 *
 * Kept beside {@link tokens} rather than inside it because each one is a set of
 * three properties, not a single value.
 */
export const text = {
  /** 14px/22 — panel titles and message text. */
  panel: font('s-14'),
  /** 13px/20 — settings field labels and card descriptions. */
  field: font('xs-13'),
  /** 12px/18 — hints, list captions, trace ids. */
  caption: font('xxs-12'),
  /** 11px/14 — tag text. */
  micro: font('xxxs-11'),
  /** 12px/19 code ramp. */
  code: codeFont(),
} as const

/** Radii. DSH has no radius token, so these mirror its literal values. */
export const radii = {
  /** Settings inputs and buttons. */
  field: '8px',
  /** Inset panels nested inside a card. */
  inset: '12px',
  /** Cards and file chips. */
  card: '16px',
  /** The harness chat bubble. */
  bubble: '22px',
  /** Pills and tags. */
  capsule: '999px',
} as const

/** Stylesheet identity: also the idempotence key for its injection. */
const STYLESHEET_ID = 'dsh-starbridge-client/client/styles.css'

/**
 * The one declaration block inline styles cannot carry.
 *
 * Every selector here exists because the property it sets is a pseudo-class, a
 * pseudo-element, or a sibling combinator — the three things a React inline
 * style object has no syntax for. Nothing cosmetic belongs here; if a rule could
 * have been an inline property it is one.
 */
const STYLESHEET = `
.sb-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  box-sizing: border-box;
  height: 32px;
  padding: 0 14px;
  border: 0.5px solid ${tokens.borderL2};
  border-radius: ${radii.field};
  background: transparent;
  color: ${tokens.text};
  font-family: inherit;
  font-size: 13px;
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}
.sb-button:hover:not(:disabled) {
  background: ${tokens.ghostHover};
  border-color: ${tokens.borderL3};
}
.sb-button:active:not(:disabled) {
  background: ${tokens.ghostActive};
}
.sb-button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.sb-button:focus-visible {
  outline: 2px solid ${tokens.accent};
  outline-offset: 1px;
}

.sb-button--primary {
  border-color: transparent;
  background: ${tokens.primaryFill};
  color: ${tokens.textOnPrimary};
  font-weight: 500;
}
.sb-button--primary:hover:not(:disabled),
.sb-button--primary:active:not(:disabled) {
  border-color: transparent;
  background: ${tokens.primaryHover};
}

.sb-button--subtle {
  height: 26px;
  padding: 0 8px;
  border-color: transparent;
  border-radius: 13px;
  color: ${tokens.textMuted};
  font-size: 12px;
  line-height: 18px;
}
.sb-button--subtle:hover:not(:disabled) {
  border-color: transparent;
  color: ${tokens.text};
}
.sb-button--subtle[data-active='true'] {
  color: ${tokens.info};
  background: ${tokens.infoTint};
}
/* Restated with the hover pseudo-class: a plain attribute selector is one class
   of specificity, so the hover rule above would otherwise win over the active
   tint on the very button the user is about to click again. */
.sb-button--subtle[data-active='true']:hover:not(:disabled) {
  color: ${tokens.info};
  background: ${tokens.infoTint};
}

.sb-input,
.sb-textarea {
  box-sizing: border-box;
  width: 100%;
  padding: 0 12px;
  border: 0.5px solid ${tokens.borderL4};
  border-radius: ${radii.field};
  background: ${tokens.inputMajor};
  color: ${tokens.text};
  font-family: inherit;
  font-size: 13px;
  line-height: 20px;
}
.sb-input {
  height: 34px;
}
.sb-textarea {
  min-height: 44px;
  padding: 8px 12px;
  resize: vertical;
}
.sb-input:focus-visible,
.sb-textarea:focus-visible {
  border-color: ${tokens.accent};
  outline: none;
}
.sb-input:disabled,
.sb-textarea:disabled {
  color: ${tokens.textMuted};
  cursor: not-allowed;
}
.sb-input::placeholder,
.sb-textarea::placeholder {
  color: ${tokens.textDimmed};
}

.sb-checkbox {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: ${tokens.primaryFill};
  cursor: pointer;
}
.sb-checkbox:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Field rows: the hairline between two adjacent fields is what makes a settings
   page read as a DSH page, and `+` is the only way to say "not the first one". */
.sb-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
}
.sb-field + .sb-field {
  border-top: 0.5px solid ${tokens.borderL2};
}

/* Syntax palette. The harness hands shiki its colours inline and ships no token
   for them, so the plugin owns this pair; the dark override is keyed off the
   same attribute DSH sets on <body>. */
body {
  --sb-code-keyword: #a626a4;
  --sb-code-string: #1a7f37;
  --sb-code-comment: #8b93a1;
  --sb-code-number: #b25409;
  --sb-code-function: #3b6fd4;
  --sb-code-type: #8a6300;
  --sb-code-operator: #0b7285;
}
body[data-ds-dark-theme] {
  --sb-code-keyword: #c792ea;
  --sb-code-string: #a5d6a7;
  --sb-code-comment: #6b7d8f;
  --sb-code-number: #f78c6c;
  --sb-code-function: #82aaff;
  --sb-code-type: #ffcb6b;
  --sb-code-operator: #89ddff;
}
`

/**
 * Inject the state stylesheet once per document.
 *
 * DSH's own client packages run this at module scope with the same
 * `data-plugin-css` guard, so a reload of the bundle replaces nothing and a
 * second call is a no-op. The `document` check keeps the module importable in a
 * non-DOM host (the offline verifier runs the bundle in a bare `vm` context).
 */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${STYLESHEET_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-starbridge-client'
  tag.dataset.pluginCss = STYLESHEET_ID
  tag.textContent = STYLESHEET
  document.head.appendChild(tag)
}

ensureStyles()

/** Class names for the controls the stylesheet owns. */
export const classes = {
  button: 'sb-button',
  primaryButton: 'sb-button sb-button--primary',
  subtleButton: 'sb-button sb-button--subtle',
  input: 'sb-input',
  textarea: 'sb-textarea',
  checkbox: 'sb-checkbox',
  field: 'sb-field',
} as const

/** Notice emphasis. */
export type NoticeTone = 'info' | 'success' | 'warning' | 'danger'

/** Tag emphasis, mirroring the harness Tag primitive's palette. */
export type TagTone = 'neutral' | 'outline' | 'info' | 'success' | 'warning' | 'danger'

/**
 * Build a tag (the harness's 11px capsule).
 *
 * @param tone - palette; `neutral` is the quiet filled chip, `outline` the bare one.
 * @returns the tag's style object.
 */
export function tagStyle(tone: TagTone = 'neutral'): CSSProperties {
  const base: CSSProperties = {
    ...text.micro,
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '1px 8px',
    borderRadius: radii.capsule,
    fontWeight: 500,
    whiteSpace: 'nowrap',
  }
  switch (tone) {
    case 'outline':
      return { ...base, border: `0.5px solid ${tokens.borderL4}`, color: tokens.textMuted }
    case 'info':
      return { ...base, background: tokens.infoTint, color: tokens.info }
    case 'success':
      return { ...base, background: tokens.successTint, color: tokens.success }
    case 'warning':
      return { ...base, background: tokens.warningTint, color: tokens.warningLabel }
    case 'danger':
      return { ...base, background: tokens.dangerTint, color: tokens.danger }
    default:
      return { ...base, background: tokens.bgModulePlatform, color: tokens.textSecondary }
  }
}

/**
 * Build a notice banner.
 *
 * The tone bar on the leading edge is an inset shadow rather than a second
 * `border-*` declaration: React writes a style object in key order, and mixing
 * the `border` shorthand with a longhand in one object is a conflict the DOM
 * only resolves by ordering.
 *
 * @param tone - emphasis; anything other than `info` also colours the outline.
 * @returns the banner's style object.
 */
export function noticeStyle(tone: NoticeTone = 'info'): CSSProperties {
  const accent = tone === 'danger'
    ? tokens.danger
    : tone === 'warning'
      ? tokens.warning
      : tone === 'success'
        ? tokens.success
        : tokens.info
  return {
    ...text.caption,
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '10px 12px',
    border: `0.5px solid ${tone === 'info' ? tokens.borderL2 : accent}`,
    boxShadow: `inset 2px 0 0 0 ${accent}`,
    borderRadius: radii.field,
    background: tone === 'danger'
      ? tokens.dangerTint
      : tone === 'warning'
        ? tokens.warningTint
        : tokens.bgModulePlatform,
    color: tokens.text,
  }
}

/** Shared style objects (layout and colour only; state lives in the stylesheet). */
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
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '12px',
    flexWrap: 'wrap',
  } satisfies CSSProperties,

  title: {
    ...text.panel,
    fontWeight: 600,
    margin: 0,
  } satisfies CSSProperties,

  subtitle: {
    ...text.caption,
    color: tokens.textMuted,
    margin: 0,
  } satisfies CSSProperties,

  /** The settings body: one 760px column, DSH's section width. */
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    maxWidth: '760px',
    width: '100%',
    color: tokens.text,
  } satisfies CSSProperties,

  /** The page heading of a settings section. */
  sectionTitle: {
    fontSize: '18px',
    fontWeight: 600,
    lineHeight: '26px',
    margin: 0,
  } satisfies CSSProperties,

  sectionIntro: {
    ...text.field,
    color: tokens.textMuted,
    margin: 0,
  } satisfies CSSProperties,

  /** One group card, matching the harness plugin card. */
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '14px 16px',
    border: `0.5px solid ${tokens.borderL4}`,
    borderRadius: radii.card,
    background: tokens.bgLayer3,
  } satisfies CSSProperties,

  cardHead: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
  } satisfies CSSProperties,

  /** The heading of a group inside a card. */
  cardTitle: {
    ...text.panel,
    fontWeight: 600,
    margin: 0,
    marginRight: 'auto',
  } satisfies CSSProperties,

  cardDesc: {
    ...text.field,
    color: tokens.textMuted,
    margin: 0,
  } satisfies CSSProperties,

  /** A settings field's label, matching the harness plugin field. */
  fieldLabel: {
    ...text.field,
    fontWeight: 500,
    color: tokens.text,
  } satisfies CSSProperties,

  fieldHint: {
    ...text.caption,
    color: tokens.textMuted,
  } satisfies CSSProperties,

  /** A checkbox plus its label, on one line. */
  checkRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    ...text.field,
    color: tokens.text,
    cursor: 'pointer',
    userSelect: 'none',
  } satisfies CSSProperties,

  /** The two-column credential area. */
  cards: {
    display: 'flex',
    gap: '12px',
    flexWrap: 'wrap',
  } satisfies CSSProperties,

  /** A selectable panel nested inside a card. */
  inset: {
    flex: '1 1 300px',
    minWidth: '260px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '12px',
    border: `0.5px solid ${tokens.borderL3}`,
    borderRadius: radii.inset,
    background: tokens.bgModulePlatform,
  } satisfies CSSProperties,

  /** {@link styles.inset}, marked as the credential currently in use. */
  insetActive: {
    flex: '1 1 300px',
    minWidth: '260px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '12px',
    border: `0.5px solid ${tokens.info}`,
    borderRadius: radii.inset,
    background: tokens.infoTint,
  } satisfies CSSProperties,

  /** Term/value grid for the effective endpoint and route readout. */
  defs: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr)',
    gap: '6px 14px',
    ...text.caption,
    marginTop: '4px',
  } satisfies CSSProperties,

  defsTerm: {
    color: tokens.textMuted,
  } satisfies CSSProperties,

  /** The connect checklist: one row per step the host reported. */
  step: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
    ...text.field,
  } satisfies CSSProperties,

  stepMark: {
    flex: '0 0 auto',
    lineHeight: '20px',
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

  /** The harness chat bubble, verbatim from `ui-chat`'s bubble module. */
  userBubble: {
    ...text.panel,
    alignSelf: 'flex-end',
    maxWidth: '100%',
    padding: '10px 16px',
    borderRadius: radii.bubble,
    background: tokens.bubble,
    color: tokens.text,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  } satisfies CSSProperties,

  assistantBubble: {
    ...text.panel,
    alignSelf: 'flex-start',
    maxWidth: '100%',
    minWidth: 0,
    padding: '2px 0',
    color: tokens.text,
    wordBreak: 'break-word',
  } satisfies CSSProperties,

  systemBubble: {
    ...text.caption,
    alignSelf: 'stretch',
    padding: '8px 12px',
    borderRadius: radii.field,
    background: tokens.bgModulePlatform,
    color: tokens.textMuted,
  } satisfies CSSProperties,

  composer: {
    display: 'flex',
    gap: '8px',
    alignItems: 'flex-end',
  } satisfies CSSProperties,

  inlineCode: {
    padding: '1px 5px',
    borderRadius: '4px',
    border: `0.5px solid ${tokens.borderL1}`,
    background: tokens.inlineCode,
    ...text.code,
  } satisfies CSSProperties,

  codeBlock: {
    margin: 0,
    padding: '10px 12px',
    borderRadius: radii.field,
    border: `0.5px solid ${tokens.borderL1}`,
    background: tokens.codeBlock,
    overflowX: 'auto',
    ...text.code,
  } satisfies CSSProperties,

  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
  } satisfies CSSProperties,

  feedbackBar: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '2px',
    flexWrap: 'wrap',
  } satisfies CSSProperties,
} as const

/** Per-token colours for highlighted code; defined in the injected stylesheet. */
export const tokenColors: Record<string, string> = {
  plain: tokens.text,
  keyword: token('--sb-code-keyword', '#a626a4'),
  string: token('--sb-code-string', '#1a7f37'),
  comment: token('--sb-code-comment', '#8b93a1'),
  number: token('--sb-code-number', '#b25409'),
  function: token('--sb-code-function', '#3b6fd4'),
  type: token('--sb-code-type', '#8a6300'),
  operator: token('--sb-code-operator', '#0b7285'),
}
