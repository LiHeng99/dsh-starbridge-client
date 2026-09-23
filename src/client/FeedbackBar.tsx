/**
 * Feedback control rendered under each finalized assistant message.
 *
 * Occupies the `conversation.chat.assistant-actions` slot, so it receives the
 * durable `messageId` of the message it sits under and nothing else: all the
 * policy (where feedback is stored, whether it is forwarded) lives on the host,
 * and this component only collects a verdict and a correction.
 *
 * @module @company/dsh-starbridge-client/client/FeedbackBar
 */

import { useCallback, useState, type ReactElement } from 'react'

import { starBridgeApi, StarBridgeClientError } from './api.ts'
import { openLoginWindow } from './login.ts'
import { styles, tokens } from './theme.ts'
import type { StarBridgeFeedbackVerdict } from '../shared/protocol.ts'

/** Props injected by the `conversation.chat.assistant-actions` slot. */
export interface FeedbackBarProps {
  /** Durable id of the assistant message this control belongs to. */
  messageId: string
  /** DSH session id, when the slot supplied one. */
  sessionId?: string
  /** StarBridge conversation id, when the panel knows it. */
  conversationId?: string
}

/** What the bar is currently doing. */
type Status =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved'; readonly detail: string }
  | { readonly kind: 'error'; readonly message: string; readonly hint?: string }

/**
 * Like / dislike / correct one assistant message.
 *
 * @param props - the message identity from the slot.
 * @returns the feedback bar.
 */
export function FeedbackBar({ messageId, sessionId, conversationId }: FeedbackBarProps): ReactElement {
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [verdict, setVerdict] = useState<StarBridgeFeedbackVerdict | null>(null)
  const [correction, setCorrection] = useState('')
  const [expectation, setExpectation] = useState('')
  const [correcting, setCorrecting] = useState(false)

  const submit = useCallback(
    async (
      next: StarBridgeFeedbackVerdict,
      note?: string,
      expected?: string,
    ): Promise<void> => {
      setStatus({ kind: 'saving' })
      setVerdict(next)
      try {
        const result = await starBridgeApi.feedback({
          messageId,
          verdict: next,
          ...(note === undefined || note.length === 0 ? {} : { note }),
          ...(expected === undefined || expected.length === 0 ? {} : { expectation: expected }),
          ...(conversationId === undefined ? {} : { conversationId }),
          ...(sessionId === undefined ? {} : { sessionId }),
        })
        setStatus({
          kind: 'saved',
          detail: result.forwarded === 'accepted'
            ? '已记录并同步到星桥平台'
            : result.forwarded === 'failed'
              ? `已本地记录（同步失败：${result.detail ?? '未知原因'}）`
              : '已本地记录',
        })
        setCorrecting(false)
        setCorrection('')
        setExpectation('')
      } catch (error) {
        if (error instanceof StarBridgeClientError) {
          setStatus({
            kind: 'error',
            message: error.message,
            ...(error.hint === undefined ? {} : { hint: error.hint }),
          })
          if (error.needsLogin) openLoginWindow()
        } else {
          setStatus({ kind: 'error', message: String(error) })
        }
      }
    },
    [conversationId, messageId, sessionId],
  )

  const buttonStyle = (active: boolean) => ({
    ...styles.feedbackButton,
    ...(active ? { color: tokens.accent, borderColor: tokens.accent } : {}),
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div style={styles.feedbackBar}>
        <button
          type="button"
          title="这条回答有帮助"
          aria-label="Like this answer"
          disabled={status.kind === 'saving'}
          style={buttonStyle(verdict === 'up')}
          onClick={() => void submit('up')}
        >
          👍 有帮助
        </button>
        <button
          type="button"
          title="这条回答不正确或没用"
          aria-label="Dislike this answer"
          disabled={status.kind === 'saving'}
          style={buttonStyle(verdict === 'down')}
          onClick={() => void submit('down')}
        >
          👎 有问题
        </button>
        <button
          type="button"
          title="写下正确答案，反馈给星桥质量队列"
          aria-label="Correct this answer"
          disabled={status.kind === 'saving'}
          style={buttonStyle(correcting)}
          onClick={() => setCorrecting((open) => !open)}
        >
          ✏️ 修正回答
        </button>
        {status.kind === 'saving' && <span style={{ fontSize: '11px', color: tokens.textMuted }}>提交中…</span>}
        {status.kind === 'saved' && <span style={{ fontSize: '11px', color: tokens.success }}>{status.detail}</span>}
      </div>

      {correcting && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxWidth: '520px' }}>
          <label style={{ fontSize: '11px', color: tokens.textMuted }}>
            问题所在（必填）：哪里不对、缺了什么
          </label>
          <textarea
            value={correction}
            onChange={(event) => setCorrection(event.target.value)}
            placeholder="例如：没有给出退款入口，只说了「请联系客服」。"
            rows={2}
            style={{ ...styles.textarea, minHeight: '52px', fontSize: '12.5px' }}
          />
          <label style={{ fontSize: '11px', color: tokens.textMuted }}>
            期望答案（建议填写）：这条应该怎么答。星桥用它来判断回答对错、并生成改进建议。
          </label>
          <textarea
            value={expectation}
            onChange={(event) => setExpectation(event.target.value)}
            placeholder="例如：应引导用户到「我的订单 → 申请退款」提交申请，并说明 1-3 个工作日到账。"
            rows={3}
            style={{ ...styles.textarea, minHeight: '64px', fontSize: '12.5px' }}
          />
          <div style={styles.row}>
            <button
              type="button"
              disabled={status.kind === 'saving' || correction.trim().length === 0}
              style={styles.primaryButton}
              onClick={() => void submit('down', correction.trim(), expectation.trim())}
            >
              提交修正
            </button>
            <button type="button" style={styles.button} onClick={() => setCorrecting(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      {status.kind === 'error' && (
        <div style={{ ...styles.notice, borderColor: tokens.danger }}>
          <span style={{ fontSize: '12px' }}>{status.message}</span>
          {status.hint !== undefined && <span style={{ fontSize: '11px', color: tokens.textMuted }}>{status.hint}</span>}
        </div>
      )}
    </div>
  )
}
