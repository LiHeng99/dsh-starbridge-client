/**
 * The three model-facing StarBridge tools.
 *
 * Two conventions are load-bearing here:
 *
 * 1. **Failures are values, not throws.** The DSH tool pipeline turns a thrown
 *    error into `Error: <message>` and ends the turn, so a failure the model can
 *    route around — not signed in, gateway down, KB disabled — is RETURNED as
 *    `{ ok: false, error }`. A broken deployment therefore tells the model what
 *    to say to the user instead of silently ending the turn.
 * 2. **`exec.signal` is always forwarded**, so cancelling a call stops the
 *    upstream HTTP request rather than leaving it to finish into a dead turn.
 *
 * @module dsh-starbridge-client/tools
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import { StarBridgeError, describeError } from './errors.ts'
import type { StarBridgeService } from './augment.ts'
import type { StarBridgeChatMessage } from './shared/protocol.ts'

/** Cooperative timeout for chat calls; the operation is long by nature. */
const CHAT_TOOL_TIMEOUT_MS = 120_000

/** Cooperative timeout for knowledge-base lookups. */
const KB_TOOL_TIMEOUT_MS = 30_000

/** Cooperative timeout for a feedback write. */
const FEEDBACK_TOOL_TIMEOUT_MS = 15_000

/**
 * Cooperative timeout for a configuration action.
 *
 * Larger than a feedback write because the connect sequence probes the gateway
 * and, on the account path, performs a login round trip before it stores
 * anything.
 */
const GATEWAY_TOOL_TIMEOUT_MS = 45_000

/** One plain text block for the model. */
function text(value: string): ContentBlock {
  return { type: 'text', text: value }
}

/**
 * Turn a domain failure into the `error` string carried by the tool result.
 *
 * @param error - the failure to describe.
 * @returns an actionable, single-line description.
 */
function failureText(error: unknown): string {
  return describeError(error)
}

/**
 * Build every StarBridge tool definition.
 *
 * The caller registers each one with `ctx.tools.register(...)`; registration
 * effects are owned by the plugin fiber, so unreregistration on unload is
 * automatic and no explicit disposer bookkeeping is needed here.
 *
 * @param service - the host-side StarBridge service.
 * @returns the tool definitions, in registration order.
 */
export function createStarBridgeTools(service: StarBridgeService): ToolDefinition[] {
  const chat = defineTool({
    name: 'starbridge_chat',
    description:
      'Ask the company StarBridge AI platform a question and get an answer grounded in company context. '
      + 'Use this for company-specific questions (policies, internal systems, product knowledge) or whenever the '
      + 'user asks to consult StarBridge. The reply is returned in full; the call blocks until the platform finishes '
      + 'answering. Requires an active StarBridge session — if it reports AUTH_REQUIRED, tell the user to sign in from '
      + 'DSH Settings → 星桥 StarBridge and do not retry in a loop.',
    parameters: {
      messages: {
        type: 'array',
        required: true,
        description:
          'Conversation so far, oldest first. Send the user\'s actual question as the final entry; include earlier '
          + 'turns only when the follow-up depends on them.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            role: { type: 'string', enum: ['user', 'assistant', 'system'], required: true },
            content: { type: 'string', required: true },
          },
        },
      },
      scenario: {
        type: 'string',
        description:
          'Gateway routing/telemetry scenario key (for example "chat", "code-review", "hr"). Defaults to the '
          + 'configured scenario when omitted.',
      },
      use_knowledge_base: {
        type: 'boolean',
        description:
          'Ask the gateway to ground the answer in the company knowledge base. Defaults to the deployment setting.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reply: { type: 'string' },
          conversationId: { type: 'string' },
          traceId: { type: 'string', required: true },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        if (value.ok) {
          const reply = value.reply ?? ''
          return [text(`${reply}\n\n— StarBridge (trace ${value.traceId})`)]
        }
        return [text(`StarBridge could not answer.\n${value.error ?? 'No detail was reported.'}\n(trace ${value.traceId})`)]
      },
    },
    timeoutMs: CHAT_TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const messages: StarBridgeChatMessage[] = args.messages.map((message) => ({
        role: message.role,
        content: message.content,
      }))
      if (messages.length === 0) {
        return {
          ok: false,
          traceId: 'n/a',
          error: failureText(new StarBridgeError('INVALID_ARGUMENT', 'starbridge_chat needs at least one message.', {
            hint: 'Send the user\'s question as a single { role: "user", content: "…" } entry.',
          })),
        }
      }

      try {
        const result = await service.chat({
          messages,
          ...(args.scenario === undefined ? {} : { scenario: args.scenario }),
          ...(args.use_knowledge_base === undefined ? {} : { useKnowledgeBase: args.use_knowledge_base }),
          signal: exec.signal,
        })
        return {
          ok: true,
          reply: result.reply,
          traceId: result.traceId,
          ...(result.conversationId === undefined ? {} : { conversationId: result.conversationId }),
        }
      } catch (error) {
        return { ok: false, traceId: 'n/a', error: failureText(error) }
      }
    },
  })

  const feedback = defineTool({
    name: 'starbridge_feedback',
    description:
      'Record the user\'s judgement on one StarBridge or assistant answer: a like, a dislike, or a correction. '
      + 'Call this when the user says an answer was wrong, unhelpful, or particularly good — it feeds the company '
      + 'quality-review queue. The record is always stored in the local session; forwarding to the platform is a '
      + 'deployment setting and its failure does not lose the feedback.',
    parameters: {
      message_id: {
        type: 'string',
        required: true,
        description: 'Identifier of the message being judged. Use the assistant message id when you have it, otherwise '
          + 'a stable label such as the trace id returned by starbridge_chat.',
      },
      verdict: {
        type: 'string',
        enum: ['up', 'down'],
        required: true,
        description: '"up" for helpful/correct, "down" for wrong or unhelpful.',
      },
      note: {
        type: 'string',
        description: 'The correction or reason, in the user\'s own words. Strongly preferred for a "down" verdict: it '
          + 'is what a reviewer reads.',
      },
      expectation: {
        type: 'string',
        description: 'What the answer should have been. Fill this in when you know the correct answer: the platform '
          + 'builds (question, expectation) pairs from it to score answers and generate improvement suggestions. '
          + 'Leave it out when you only know that the answer is wrong.',
      },
      conversation_id: {
        type: 'string',
        description: 'StarBridge conversation id returned by starbridge_chat, when the judgement is about a platform answer.',
      },
      session_id: {
        type: 'string',
        description: 'DSH session id the feedback belongs to; defaults to the current session when omitted.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          recorded: { type: 'boolean', required: true },
          storage: { type: 'string', required: true },
          forwarded: { type: 'string', required: true },
          traceId: { type: 'string' },
          detail: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        if (value.error !== undefined) return [text(`StarBridge feedback was not recorded.\n${value.error}`)]
        const forward = value.forwarded === 'accepted'
          ? `forwarded to the platform${value.traceId === undefined ? '' : ` (trace ${value.traceId})`}`
          : value.forwarded === 'failed'
            ? `stored locally only — forwarding failed${value.detail === undefined ? '' : `: ${value.detail}`}`
            : 'stored locally; forwarding is disabled for this deployment'
        return [text(`StarBridge feedback recorded (${value.storage}): ${forward}.`)]
      },
    },
    timeoutMs: FEEDBACK_TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      try {
        const result = await service.recordFeedback({
          messageId: args.message_id,
          verdict: args.verdict,
          ...(args.note === undefined ? {} : { note: args.note }),
          ...(args.expectation === undefined ? {} : { expectation: args.expectation }),
          ...(args.conversation_id === undefined ? {} : { conversationId: args.conversation_id }),
          ...(args.session_id === undefined ? {} : { sessionId: args.session_id }),
          signal: exec.signal,
        })
        return {
          recorded: result.recorded,
          storage: result.storage,
          forwarded: result.forwarded,
          ...(result.traceId === undefined ? {} : { traceId: result.traceId }),
          ...(result.detail === undefined ? {} : { detail: result.detail }),
        }
      } catch (error) {
        return {
          recorded: false,
          storage: 'none',
          forwarded: 'skipped',
          error: failureText(error),
        }
      }
    },
  })

  const kbQuery = defineTool({
    name: 'starbridge_kb_query',
    description:
      'Search the company knowledge base and return the best-matching passages with their references. Use this to '
      + 'ground an answer in company documentation, or to cite the source of a company policy. Availability depends on '
      + 'the deployment: if the gateway does not expose a knowledge-base route, this tool reports that clearly and you '
      + 'should answer from what you already know and say the search was unavailable.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Natural-language search query, phrased as the question to answer.',
      },
      top_k: {
        type: 'integer',
        description: 'Maximum number of passages to return. Defaults to the configured limit.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                reference: { type: 'string', required: true },
                snippet: { type: 'string', required: true },
                score: { type: 'number' },
              },
            },
          },
          traceId: { type: 'string', required: true },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        if (!value.ok) return [text(`StarBridge knowledge-base search failed.\n${value.error ?? 'No detail was reported.'}`)]
        const hits = value.hits ?? []
        if (hits.length === 0) return [text(`No knowledge-base passage matched. (trace ${value.traceId})`)]
        const body = hits
          .map((hit, index) => {
            const score = hit.score === undefined ? '' : ` (score ${hit.score.toFixed(3)})`
            return `${index + 1}. ${hit.title}${score}\n   ref: ${hit.reference}\n   ${hit.snippet}`
          })
          .join('\n\n')
        return [text(`${body}\n\n— StarBridge knowledge base (trace ${value.traceId})`)]
      },
    },
    timeoutMs: KB_TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      if (args.query.trim().length === 0) {
        return {
          ok: false,
          traceId: 'n/a',
          error: failureText(new StarBridgeError('INVALID_ARGUMENT', 'starbridge_kb_query needs a non-empty query.', {
            hint: 'Phrase the question you want company documentation to answer.',
          })),
        }
      }
      try {
        const result = await service.queryKnowledgeBase({
          query: args.query,
          ...(args.top_k === undefined ? {} : { topK: args.top_k }),
          signal: exec.signal,
        })
        return {
          ok: true,
          traceId: result.traceId,
          hits: result.hits.map((hit) => ({
            title: hit.title,
            reference: hit.reference,
            snippet: hit.snippet,
            ...(hit.score === undefined ? {} : { score: hit.score }),
          })),
        }
      } catch (error) {
        return { ok: false, traceId: 'n/a', error: failureText(error) }
      }
    },
  })

  // The gateway tool is how a user configures StarBridge from the conversation
  // instead of hunting for a settings page: report what is in force, save an
  // access key they pasted, or sign in with their platform account.
  //
  // It deliberately does NOT take the password as a tool argument on the
  // "sign-in" path unless the user typed it into the conversation themselves.
  // The password is used once and sealed for renewal; nothing about it — not the
  // value, not its length — is ever echoed back in the result.
  const gateway = defineTool({
    name: 'starbridge_gateway',
    description:
      'Configure and inspect the StarBridge (星桥) connection: which gateway address is in force, which credential is '
      + 'being used, whether DSH model calls are routed through the platform, and the stored access key / login state. '
      + 'Actions: "status" (default) reports the current configuration; "save" stores the gateway address and identity; '
      + '"use_access_key" stores an access key the user pasted; "login" signs in with a StarBridge platform account; '
      + '"route_models" turns DSH model routing through StarBridge on or off; "forget" removes the stored credential. '
      + 'Never invent an access key or password — only pass values the user actually supplied.',
    parameters: {
      action: {
        type: 'string',
        enum: ['status', 'save', 'use_access_key', 'login', 'route_models', 'forget'],
        description: 'What to do. Defaults to "status", which changes nothing.',
      },
      base_url: {
        type: 'string',
        description: 'StarBridge address, e.g. "https://starbridge.example.com/starbridge/gw". Used by "save", "use_access_key" and "login".',
      },
      user_id: {
        type: 'string',
        description: 'Employee identifier reported to the gateway (for per-person attribution). Used by "save" and "use_access_key".',
      },
      department: {
        type: 'string',
        description: 'Organisation unit usage is booked against. Used by "save" and "use_access_key".',
      },
      access_key: {
        type: 'string',
        description: 'The access key the user pasted, for "use_access_key". Stored in the DSH credential store, never in a config file.',
      },
      username: {
        type: 'string',
        description: 'StarBridge platform account name, for "login".',
      },
      password: {
        type: 'string',
        description: 'StarBridge platform password, for "login". Only pass it when the user supplied it in this conversation.',
      },
      remember: {
        type: 'boolean',
        description: 'For "login": seal the credentials so the token can be renewed automatically before it expires. Defaults to true.',
      },
      route_models: {
        type: 'boolean',
        description: 'Whether new DSH sessions should default to the StarBridge model route. Used by "route_models" and as an opt-out for the other actions.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          summary: { type: 'string', required: true },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
                detail: { type: 'string', required: true },
                hint: { type: 'string' },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        const lines = [value.summary]
        for (const step of value.steps ?? []) {
          lines.push(`  ${step.ok ? '✓' : '✗'} ${step.name}: ${step.detail}${step.hint === undefined ? '' : ` — ${step.hint}`}`)
        }
        if (value.error !== undefined) lines.push(value.error)
        return [text(lines.join('\n'))]
      },
    },
    timeoutMs: GATEWAY_TOOL_TIMEOUT_MS,
    async execute(args) {
      const action = args.action ?? 'status'
      const steps: { name: string; ok: boolean; detail: string; hint?: string }[] = []
      try {
        if (action === 'save') {
          const settings = await service.updateGatewaySettings({
            ...(args.base_url === undefined ? {} : { baseUrl: args.base_url }),
            ...(args.user_id === undefined ? {} : { userId: args.user_id }),
            ...(args.department === undefined ? {} : { department: args.department }),
          })
          steps.push({ name: 'save', ok: true, detail: `地址 ${settings.baseUrl}（身份 ${settings.userId.length > 0 ? settings.userId : '未设置'}）` })
        } else if (action === 'use_access_key') {
          const outcome = await service.connectWithAccessKey({
            accessKey: args.access_key ?? '',
            ...(args.base_url === undefined ? {} : { baseUrl: args.base_url }),
            ...(args.user_id === undefined ? {} : { userId: args.user_id }),
            ...(args.department === undefined ? {} : { department: args.department }),
            ...(args.route_models === undefined ? {} : { routeModels: args.route_models }),
          })
          steps.push(...outcome.steps)
          return { ok: outcome.ok, summary: outcome.ok ? '星桥已接通' : '接通未完成', steps }
        } else if (action === 'login') {
          const outcome = await service.loginWithPlatform({
            username: args.username ?? '',
            password: args.password ?? '',
            ...(args.base_url === undefined ? {} : { baseUrl: args.base_url }),
            ...(args.remember === undefined ? {} : { remember: args.remember }),
            ...(args.route_models === undefined ? {} : { routeModels: args.route_models }),
          })
          steps.push(...outcome.steps)
          return { ok: outcome.ok, summary: outcome.ok ? '已用平台账号登录' : '登录未完成', steps }
        } else if (action === 'route_models') {
          if (args.route_models === undefined) {
            return {
              ok: false,
              summary: '需要 route_models',
              error: failureText(new StarBridgeError('INVALID_ARGUMENT', 'route_models requires `route_models: true|false`.')),
            }
          }
          const outcome = await service.setModelRouting(args.route_models)
          steps.push(...outcome.steps)
          return { ok: outcome.ok, summary: args.route_models ? '模型路由已打开' : '模型路由已关闭', steps }
        } else if (action === 'forget') {
          const access = await service.forgetAccess()
          steps.push({ name: 'forget', ok: true, detail: `已清除本机保存的凭据（${access.credentialRef}）` })
        }

        const status = service.status()
        steps.push(
          { name: 'address', ok: status.gatewayUrl.length > 0, detail: status.gatewayUrl },
          {
            name: 'credential',
            ok: status.auth.state === 'authenticated' || status.access.kind !== 'none' || status.access.authMode === 'access-key',
            detail: `${status.access.authMode}${status.access.account === null ? '' : ` · ${status.access.account}`}`
              + `${status.access.expiresAt === null ? '' : ` · 有效至 ${new Date(status.access.expiresAt).toLocaleString()}`}`,
          },
          {
            name: 'model-route',
            ok: status.modelRoute.routedThroughGateway === false || status.modelRoute.supported,
            detail: status.modelRoute.routedThroughGateway
              ? `经星桥网关：${status.modelRoute.activeProvider ?? status.modelRoute.provider}/${status.modelRoute.activeModel ?? status.modelRoute.model}`
              : '未接管：模型调用仍走 DSH 当前默认提供方',
          },
        )
        return { ok: true, summary: '星桥接入配置', steps }
      } catch (error) {
        return { ok: false, summary: '星桥接入配置操作失败', error: failureText(error) }
      }
    },
  })

  return [chat, feedback, kbQuery, gateway]
}
