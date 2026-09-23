/**
 * The StarBridge conversation panel.
 *
 * Occupies the `main` slot (central panel, dispatched by sidebar entry id), so
 * it renders as a full panel beside DSH's own Conversation rather than inside
 * it. Everything the panel needs comes from this plugin's host routes: the
 * browser holds no token and never calls the company gateway directly.
 *
 * History sync is opt-in per message: the transcript is kept in this component's
 * state, and the host is stateless about conversations, so a user can keep a
 * private exchange on screen without it leaving the machine (only the turns they
 * send go to the gateway, as they must).
 *
 * @module dsh-starbridge-client/client/ChatPanel
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import { starBridgeApi, StarBridgeClientError } from './api.ts'
import { FeedbackBar } from './FeedbackBar.tsx'
import { MarkdownView } from './MarkdownView.tsx'
import { startLogin } from './login.ts'
import { styles, tokens } from './theme.ts'
import type { StarBridgeChatMessage, StarBridgeStatusReport } from '../shared/protocol.ts'

/** One row of the panel transcript. */
interface TranscriptEntry {
  /** Local row identity. */
  readonly id: string
  /** Speaker. */
  readonly role: 'user' | 'assistant' | 'system'
  /** Markdown text (assistant) or plain text (user/system). */
  readonly text: string
  /** StarBridge conversation id, once a reply supplied one. */
  readonly conversationId?: string
  /** Correlation id of the exchange that produced this row. */
  readonly traceId?: string
  /** Whether the row is still being streamed. */
  readonly streaming?: boolean
}

/** Props of {@link ChatPanel}, as composed by the `main` slot. */
export interface ChatPanelProps {
  /** DSH session id, when the shell supplies one through the standard share. */
  sessionId?: string
}

/** Local row counter; stable ids keep React keys meaningful across streams. */
let entryCounter = 0

/**
 * Append-only conversation panel.
 *
 * @param props - slot-composed props.
 * @returns the panel.
 */
export function ChatPanel({ sessionId }: ChatPanelProps): ReactElement {
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<StarBridgeStatusReport | null>(null)
  const [error, setError] = useState<{ message: string; hint?: string; needsLogin?: boolean } | null>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      setStatus(await starBridgeApi.status())
    } catch (cause) {
      setStatus(null)
      if (cause instanceof StarBridgeClientError) {
        setError({ message: cause.message, ...(cause.hint === undefined ? {} : { hint: cause.hint }) })
      }
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
    // Signing in happens in another tab/popup; re-reading status when the window
    // regains focus is what makes "signed in over there" show up here.
    const onFocus = (): void => {
      void refreshStatus()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      abortRef.current?.abort()
    }
  }, [refreshStatus])

  useEffect(() => {
    const node = transcriptRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [entries])

  const send = useCallback(async (): Promise<void> => {
    const question = draft.trim()
    if (question.length === 0 || busy) return

    const history: StarBridgeChatMessage[] = entries
      .filter((entry) => entry.role !== 'system')
      .map((entry) => ({ role: entry.role, content: entry.text }))
    history.push({ role: 'user', content: question })

    const userRow: TranscriptEntry = { id: `u${entryCounter += 1}`, role: 'user', text: question }
    const assistantId = `a${entryCounter += 1}`
    setEntries((previous) => [
      ...previous,
      userRow,
      { id: assistantId, role: 'assistant', text: '', streaming: true },
    ])
    setDraft('')
    setBusy(true)
    setError(null)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      await starBridgeApi.chat(
        { messages: history },
        (event) => {
          if (event.type === 'delta') {
            setEntries((previous) => previous.map((entry) => (
              entry.id === assistantId ? { ...entry, text: entry.text + event.text } : entry
            )))
            return
          }
          setEntries((previous) => previous.map((entry) => (
            entry.id === assistantId
              ? {
                  ...entry,
                  streaming: false,
                  traceId: event.traceId,
                  ...(event.conversationId === undefined ? {} : { conversationId: event.conversationId }),
                }
              : entry
          )))
        },
        controller.signal,
      )
    } catch (cause) {
      if (cause instanceof StarBridgeClientError) {
        setError({
          message: cause.message,
          ...(cause.hint === undefined ? {} : { hint: cause.hint }),
          ...(cause.needsLogin ? { needsLogin: true } : {}),
        })
        setEntries((previous) => previous.map((entry) => (
          entry.id === assistantId
            ? { ...entry, streaming: false, text: entry.text.length > 0 ? entry.text : '_（未收到回复）_' }
            : entry
        )))
      } else {
        setError({ message: String(cause) })
      }
    } finally {
      abortRef.current = null
      setBusy(false)
    }
  }, [busy, draft, entries])

  const stop = useCallback((): void => {
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
    setEntries((previous) => previous.map((entry) => (entry.streaming === true ? { ...entry, streaming: false } : entry)))
  }, [])

  const signIn = useCallback(async (): Promise<void> => {
    const outcome = await startLogin()
    if (!outcome.ok) {
      setError({ message: outcome.message, ...(outcome.hint === undefined ? {} : { hint: outcome.hint }) })
      return
    }
    setError(null)
  }, [])

  const authBadge = status === null
    ? '未连接'
    : status.auth.state === 'authenticated'
      ? `已登录${status.auth.subject === undefined ? '' : ` · ${status.auth.subject}`}`
      : status.auth.state === 'expired'
        ? '登录已过期'
        : status.auth.state === 'authenticating'
          ? '登录中'
          : '未登录'

  const needsAttention = status !== null && status.auth.state !== 'authenticated' && status.oidcConfigured

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.title}>星桥 StarBridge</h2>
          <p style={styles.subtitle}>
            {status === null ? '正在读取网关配置…' : `网关 ${status.gatewayUrl}`}
          </p>
        </div>
        <div style={styles.row}>
          <span
            style={{
              ...styles.badge,
              color: status?.auth.state === 'authenticated' ? tokens.success : tokens.textMuted,
              borderColor: status?.auth.state === 'authenticated' ? tokens.success : tokens.border,
            }}
          >
            {authBadge}
          </span>
        </div>
      </div>

      {needsAttention && (
        <div style={{ ...styles.notice, borderColor: tokens.warning }}>
          <span>尚未登录星桥平台，无法发起对话。</span>
          <div style={styles.row}>
            <button type="button" style={styles.primaryButton} onClick={() => void signIn()}>
              使用公司账号登录
            </button>
          </div>
        </div>
      )}

      {error !== null && (
        <div style={{ ...styles.notice, borderColor: tokens.danger }}>
          <span>{error.message}</span>
          {error.hint !== undefined && <span style={{ fontSize: '12px', color: tokens.textMuted }}>{error.hint}</span>}
          {error.needsLogin === true && (
            <div style={styles.row}>
              <button type="button" style={styles.primaryButton} onClick={() => void signIn()}>
                重新登录
              </button>
            </div>
          )}
        </div>
      )}

      <div ref={transcriptRef} style={styles.transcript}>
        {entries.length === 0 && (
          <div style={{ ...styles.systemBubble, alignSelf: 'center', textAlign: 'center' }}>
            向星桥提问公司业务、流程或内部系统的问题。回复支持 Markdown 与代码高亮。
          </div>
        )}
        {entries.map((entry) => {
          if (entry.role === 'user') {
            return (
              <div key={entry.id} style={styles.userBubble}>
                {entry.text}
              </div>
            )
          }
          if (entry.role === 'system') {
            return (
              <div key={entry.id} style={styles.systemBubble}>
                {entry.text}
              </div>
            )
          }
          return (
            <div key={entry.id} style={styles.assistantBubble}>
              {entry.text.length === 0 && entry.streaming === true
                ? <span style={{ color: tokens.textMuted }}>星桥正在思考…</span>
                : <MarkdownView source={entry.text} />}
              {entry.streaming === true && entry.text.length > 0 && (
                <span style={{ color: tokens.accent }}>▍</span>
              )}
              {entry.streaming !== true && entry.text.length > 0 && (
                <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <FeedbackBar
                    messageId={entry.id}
                    {...(entry.conversationId === undefined ? {} : { conversationId: entry.conversationId })}
                    {...(sessionId === undefined ? {} : { sessionId })}
                  />
                  {entry.traceId !== undefined && (
                    <span style={{ fontSize: '11px', color: tokens.textMuted }}>trace {entry.traceId}</span>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div style={styles.composer}>
        <textarea
          value={draft}
          style={styles.textarea}
          placeholder="输入问题，Ctrl/⌘ + Enter 发送"
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void send()
            }
          }}
        />
        {busy
          ? (
              <button type="button" style={styles.button} onClick={stop}>
                停止
              </button>
            )
          : (
              <button
                type="button"
                style={{ ...styles.primaryButton, opacity: draft.trim().length === 0 ? 0.5 : 1 }}
                disabled={draft.trim().length === 0}
                onClick={() => void send()}
              >
                发送
              </button>
            )}
      </div>
    </div>
  )
}
