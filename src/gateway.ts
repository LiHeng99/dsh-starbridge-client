/**
 * The StarBridge gateway client: one place that knows how to talk to the
 * company AI gateway.
 *
 * Responsibilities kept here (and deliberately NOT in the tools, the routes, or
 * the browser):
 *
 * - **Identity on every request.** `x-user-id`, `x-department`, `x-scenario`,
 *   and `x-trace-id` are stamped uniformly, so the gateway can attribute and
 *   rate-limit per employee and per scenario without trusting the caller.
 * - **Retry policy.** Transport failures and 5xx are retried with exponential
 *   backoff; 4xx never is (the request itself is wrong), and a streaming
 *   response never is once bytes have been emitted, because replaying a
 *   half-delivered answer would duplicate text in the user's transcript.
 * - **Response normalization.** The gateway may answer in OpenAI-compatible
 *   shape or in its own `{delta}` / `{text}` shape; both are folded into
 *   {@link StarBridgeChatDelta} so no caller branches on the provider.
 *
 * @module @company/dsh-starbridge-client/gateway
 */

import { StarBridgeError, redactUrl } from './errors.ts'
import type { ResolvedConfig } from './config.ts'
import type {
  StarBridgeChatDelta,
  StarBridgeChatMessage,
  StarBridgeFeedbackRecord,
  StarBridgeIdentity,
  StarBridgeKbHit,
} from './shared/protocol.ts'
import { newTraceId } from './trace.ts'

/** Dependency the gateway needs from the auth layer. */
export interface AccessTokenProvider {
  /**
   * Return a currently-valid bearer token.
   * @param traceId - correlation id for a refresh attempt.
   * @throws {StarBridgeError} `AUTH_REQUIRED` when nobody is signed in.
   */
  getAccessToken(traceId: string): Promise<string>
}

/** Minimal logger surface, so this module never depends on Cordis. */
export interface GatewayLogger {
  /** Informational line. */
  info(message: string): void
  /** Diagnostic line; never carries a credential. */
  warn(message: string): void
}

/** Options for one gateway call. */
export interface GatewayRequestOptions {
  /** HTTP method. */
  method: 'GET' | 'POST'
  /** Path below the configured base URL, e.g. `/chat/completions`. */
  path: string
  /** JSON body, when the call carries one. */
  body?: unknown
  /** Correlation id reused across retries of this call. */
  traceId?: string
  /** Scenario key for this call. */
  scenario?: string
  /** Whether the call may be retried. Defaults to true for GET/idempotent POSTs. */
  retryable?: boolean
  /** Whether the response is an SSE stream (never retried after the first byte). */
  stream?: boolean
  /** Caller cancellation, forwarded to `fetch`. */
  signal?: AbortSignal | undefined
}

/** One raw gateway response plus its correlation id. */
export interface GatewayResponse {
  /** Raw response; the caller owns the body. */
  readonly response: Response
  /** Correlation id stamped on the request. */
  readonly traceId: string
}

/** Shapes this client understands for a knowledge-base search reply. */
interface KbResponseBody {
  hits?: unknown
  results?: unknown
  data?: unknown
}

/**
 * HTTP client for the company gateway.
 *
 * One instance lives on the plugin fiber; it holds no connection pool of its
 * own (global `fetch` does), so teardown only has to abort in-flight calls,
 * which the tools' `exec.signal` already drives.
 */
export class StarBridgeGateway {
  private readonly config: ResolvedConfig
  private readonly tokens: AccessTokenProvider
  private readonly logger: GatewayLogger
  private readonly resolveBaseUrl: () => string
  private readonly resolveIdentity: () => { userId: string; department: string }
  private readonly inFlight = new Set<AbortController>()

  /**
   * @param config - resolved plugin configuration.
   * @param tokens - bearer-token source.
   * @param logger - diagnostic sink.
   * @param resolveBaseUrl - effective base URL; defaults to the configured one.
   *   Passed as a thunk because the user can change the address at runtime from
   *   the settings page, and a captured string would keep sending requests to
   *   the address that was configured when the plugin loaded.
   * @param resolveIdentity - effective employee identity, for the same reason.
   */
  constructor(
    config: ResolvedConfig,
    tokens: AccessTokenProvider,
    logger: GatewayLogger,
    resolveBaseUrl?: () => string,
    resolveIdentity?: () => { userId: string; department: string },
  ) {
    this.config = config
    this.tokens = tokens
    this.logger = logger
    this.resolveBaseUrl = resolveBaseUrl ?? (() => config.gateway.gatewayUrl)
    this.resolveIdentity = resolveIdentity ?? (() => ({
      userId: config.identity.userId,
      department: config.identity.department,
    }))
  }

  /** Effective gateway base URL (already normalized, no trailing slash). */
  get baseUrl(): string {
    return this.resolveBaseUrl()
  }

  /** Effective per-attempt timeout. */
  get timeoutMs(): number {
    return this.config.gateway.timeoutMs
  }

  /** Effective retry count. */
  get maxRetries(): number {
    return this.config.gateway.maxRetries
  }

  /**
   * Build the identity block stamped onto a request.
   *
   * @param traceId - correlation id.
   * @param scenario - scenario override; defaults to the configured one.
   * @returns the identity block.
   */
  identity(traceId: string, scenario?: string): StarBridgeIdentity {
    const resolved = this.resolveIdentity()
    return {
      userId: resolved.userId.length > 0 ? resolved.userId : 'anonymous',
      department: resolved.department,
      scenario: (scenario ?? this.config.identity.scenario) || 'chat',
      traceId,
    }
  }

  /**
   * Issue one request with retry, timeout, and uniform headers.
   *
   * @param options - request description.
   * @returns the raw response and its correlation id.
   * @throws {StarBridgeError} with a code that says which layer failed.
   */
  async request(options: GatewayRequestOptions): Promise<GatewayResponse> {
    const traceId = options.traceId ?? newTraceId(options.stream === true ? 'stream' : 'req')
    const identity = this.identity(traceId, options.scenario)
    const url = `${this.baseUrl}${options.path}`
    const retryable = options.retryable ?? true
    const attempts = retryable ? this.config.gateway.maxRetries + 1 : 1

    let lastError: StarBridgeError | null = null

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController()
      this.inFlight.add(controller)
      const onCallerAbort = (): void => controller.abort(options.signal?.reason)
      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          this.inFlight.delete(controller)
          throw new StarBridgeError('CALLER_ABORTED', 'The StarBridge request was cancelled before it was sent.')
        }
        options.signal.addEventListener('abort', onCallerAbort, { once: true })
      }
      const timer = setTimeout(
        () => controller.abort(new Error(`gateway request timed out after ${this.config.gateway.timeoutMs}ms`)),
        this.config.gateway.timeoutMs,
      )

      try {
        const headers = await this.buildHeaders(identity)
        const init: RequestInit = {
          method: options.method,
          headers,
          signal: controller.signal,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        }
        const response = await fetch(url, init)

        if (!response.ok) {
          const failure = await this.failureFor(response, identity)
          // Retry only server-side faults; a 4xx means the request is wrong.
          if (failure.status !== undefined && failure.status >= 500 && attempt < attempts) {
            lastError = failure
            this.logger.warn(`starbridge: ${redactUrl(url)} answered ${failure.status}; retrying (${attempt}/${attempts - 1})`)
            await this.sleepBeforeRetry(attempt, options.signal)
            continue
          }
          throw failure
        }

        return { response, traceId }
      } catch (error) {
        if (error instanceof StarBridgeError) {
          if (error.code === 'CALLER_ABORTED') throw error
          if ((error.status === undefined || error.status >= 500) && attempt < attempts) {
            lastError = error
            await this.sleepBeforeRetry(attempt, options.signal)
            continue
          }
          throw error
        }
        const aborted = controller.signal.aborted
        const callerAborted = options.signal?.aborted === true
        const wrapped = callerAborted
          ? new StarBridgeError('CALLER_ABORTED', 'The StarBridge request was cancelled.', { cause: error })
          : new StarBridgeError(
              aborted ? 'GATEWAY_TIMEOUT' : 'GATEWAY_UNREACHABLE',
              aborted
                ? `The StarBridge gateway did not answer ${redactUrl(url)} within ${this.config.gateway.timeoutMs}ms.`
                : `The StarBridge gateway at ${redactUrl(url)} could not be reached: ${String(error)}`,
              {
                hint: aborted
                  ? 'Raise gateway.timeoutMs for slow prompts, or check gateway health.'
                  : 'Check network access to the gateway host and that gateway.gatewayUrl is correct.',
                cause: error,
              },
            )
        if (aborted && !callerAborted && attempt < attempts) {
          lastError = wrapped
          await this.sleepBeforeRetry(attempt, options.signal)
          continue
        }
        if (callerAborted) throw wrapped
        if (attempt < attempts) {
          lastError = wrapped
          await this.sleepBeforeRetry(attempt, options.signal)
          continue
        }
        throw wrapped
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onCallerAbort)
        this.inFlight.delete(controller)
      }
    }

    throw lastError ?? new StarBridgeError('GATEWAY_UNREACHABLE', 'The StarBridge request failed for an unknown reason.')
  }

  /**
   * Wait out the exponential backoff before the next attempt.
   *
   * @param attempt - the 1-based attempt that just failed.
   * @param signal - caller cancellation, honoured so a cancelled call stops fast.
   */
  private async sleepBeforeRetry(attempt: number, signal: AbortSignal | undefined): Promise<void> {
    const delay = this.config.gateway.retryBackoffMs * 2 ** (attempt - 1)
    if (delay <= 0) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, delay)
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(new StarBridgeError('CALLER_ABORTED', 'The StarBridge request was cancelled during retry backoff.'))
      }
      if (signal?.aborted === true) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Assemble the request headers, resolving the bearer token.
   *
   * @param identity - identity block for this call.
   * @returns the header map.
   * @throws {StarBridgeError} `AUTH_REQUIRED` when no session is active.
   */
  private async buildHeaders(identity: StarBridgeIdentity): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-user-id': identity.userId,
      'x-department': identity.department,
      'x-scenario': identity.scenario,
      'x-trace-id': identity.traceId,
      'x-starbridge-client': 'dsh-starbridge-client/0.1.0',
    }
    if (this.config.gateway.apiKey.length > 0) headers['x-api-key'] = this.config.gateway.apiKey

    // A machine credential alone is a valid deployment: only ask for a user
    // token when the deployment configured sign-in.
    const token = await this.tokens.getAccessToken(identity.traceId)
    if (token.length > 0) headers.authorization = `Bearer ${token}`
    return headers
  }

  /**
   * Turn a non-2xx response into an actionable failure.
   *
   * @param response - the failed response.
   * @param identity - identity block, used to enrich the hint.
   * @returns the failure to throw.
   */
  private async failureFor(response: Response, identity: StarBridgeIdentity): Promise<StarBridgeError> {
    const detail = await response.text().catch(() => '')
    const trimmed = detail.slice(0, 500)
    if (response.status === 401 || response.status === 403) {
      return new StarBridgeError(
        'GATEWAY_REJECTED',
        `The gateway rejected the request (HTTP ${response.status}) for trace ${identity.traceId}.`,
        {
          hint: 'The session may have expired — sign in again from DSH Settings → 星桥 StarBridge. '
            + 'If it persists, ask the gateway team to check that this client is authorized for scenario '
            + `"${identity.scenario}".`,
          status: response.status,
        },
      )
    }
    return new StarBridgeError(
      'GATEWAY_HTTP',
      `The gateway answered HTTP ${response.status} for trace ${identity.traceId}.`,
      {
        hint: response.status >= 500
          ? 'This is a gateway-side fault; the request was retried. If it persists, quote the trace id to the gateway team.'
          : `The gateway rejected the request shape${trimmed.length > 0 ? `: ${trimmed}` : '.'}`,
        status: response.status,
      },
    )
  }

  /**
   * Send a chat turn and stream deltas back.
   *
   * @param input - messages, scenario, and caller cancellation.
   * @yields each delta as the gateway emits it, ending with `done: true`.
   * @throws {StarBridgeError} mapped from transport, auth, or stream failures.
   */
  async *streamChat(input: {
    messages: readonly StarBridgeChatMessage[]
    scenario?: string
    useKnowledgeBase?: boolean
    signal?: AbortSignal | undefined
  }): AsyncGenerator<StarBridgeChatDelta, { conversationId?: string; traceId: string }, void> {
    const traceId = newTraceId('chat')
    const scenario = (input.scenario ?? this.config.identity.scenario) || 'chat'
    const useKnowledgeBase = input.useKnowledgeBase ?? this.config.behavior.useKnowledgeBase
    const body = {
      stream: true,
      scenario,
      use_knowledge_base: useKnowledgeBase,
      messages: input.messages,
      identity: this.identity(traceId, scenario),
    }

    const { response } = await this.request({
      method: 'POST',
      path: '/chat/completions',
      body,
      traceId,
      scenario,
      stream: true,
      retryable: true,
      signal: input.signal,
    })

    if (response.body === null) {
      throw new StarBridgeError('GATEWAY_STREAM_ERROR', 'The gateway returned an empty stream body.', {
        hint: 'The gateway advertises SSE but sent no body; check its streaming support for this route.',
      })
    }

    let conversationId: string | undefined
    let sawDone = false

    for await (const event of readSseEvents(response.body, input.signal)) {
      if (event.data === '[DONE]') {
        sawDone = true
        break
      }
      if (event.event === 'error') {
        throw new StarBridgeError('GATEWAY_STREAM_ERROR', `The gateway aborted the stream: ${event.data}`, {
          hint: `Quote trace ${traceId} to the gateway team.`,
        })
      }

      let payload: unknown
      try {
        payload = JSON.parse(event.data)
      } catch {
        // A non-JSON data frame is still useful as literal text.
        yield { text: event.data, done: false }
        continue
      }

      for (const delta of normalizeChatFrame(payload)) {
        if (delta.conversationId !== undefined) conversationId = delta.conversationId
        if (delta.text.length > 0) yield { text: delta.text, done: false }
      }
    }

    yield { text: '', done: true, ...(conversationId === undefined ? {} : { conversationId }) }
    if (!sawDone) {
      this.logger.warn(`starbridge: stream for trace ${traceId} ended without a [DONE] frame; treating it as complete.`)
    }
    return { ...(conversationId === undefined ? {} : { conversationId }), traceId }
  }

  /**
   * Send a chat turn and buffer the whole reply.
   *
   * @param input - messages, scenario, and caller cancellation.
   * @returns the full reply plus correlation ids.
   */
  async completeChat(input: {
    messages: readonly StarBridgeChatMessage[]
    scenario?: string
    useKnowledgeBase?: boolean
    signal?: AbortSignal | undefined
  }): Promise<{ reply: string; conversationId?: string; traceId: string }> {
    const generator = this.streamChat(input)
    let reply = ''
    let step = await generator.next()
    while (step.done !== true) {
      reply += step.value.text
      step = await generator.next()
    }
    return {
      reply,
      ...(step.value.conversationId === undefined ? {} : { conversationId: step.value.conversationId }),
      traceId: step.value.traceId,
    }
  }

  /**
   * Probe the gateway for the settings panel's "test connectivity" button.
   *
   * @param signal - caller cancellation.
   * @returns reachability, status, and latency.
   */
  async probe(signal?: AbortSignal): Promise<{ reachable: boolean; status?: number; latencyMs: number; error?: string; hint?: string }> {
    const startedAt = Date.now()
    try {
      await this.request({ method: 'GET', path: '/health', traceId: newTraceId('probe'), scenario: 'health', retryable: false, signal })
      return { reachable: true, status: 200, latencyMs: Date.now() - startedAt }
    } catch (error) {
      const latencyMs = Date.now() - startedAt
      if (error instanceof StarBridgeError && error.code === 'GATEWAY_HTTP' && error.status !== undefined) {
        // A reachable host that answers 404/405 for /health is still reachable;
        // the operator needs to know the difference between "unreachable" and
        // "this route is missing".
        return {
          reachable: true,
          status: error.status,
          latencyMs,
          error: error.message,
          hint: 'The host answered but not on /health; confirm the gateway base path (gateway.gatewayUrl).',
        }
      }
      return {
        reachable: false,
        latencyMs,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof StarBridgeError && error.hint !== undefined ? { hint: error.hint } : {}),
      }
    }
  }

  /**
   * Search the company knowledge base.
   *
   * @param input - query, top-k, and caller cancellation.
   * @returns ranked hits and the correlation id.
   * @throws {StarBridgeError} when the gateway does not expose the KB route.
   */
  async queryKnowledgeBase(input: {
    query: string
    topK?: number
    scenario?: string
    signal?: AbortSignal | undefined
  }): Promise<{ hits: StarBridgeKbHit[]; traceId: string }> {
    const traceId = newTraceId('kb')
    const scenario = input.scenario ?? this.config.behavior.knowledgeBaseScenario
    const { response } = await this.request({
      method: 'POST',
      path: '/knowledge/search',
      body: {
        query: input.query,
        top_k: input.topK ?? this.config.behavior.knowledgeBaseTopK,
        scenario,
        identity: this.identity(traceId, scenario),
      },
      traceId,
      scenario,
      signal: input.signal,
    })

    const payload = (await response.json().catch((cause: unknown) => {
      throw new StarBridgeError('GATEWAY_BAD_RESPONSE', 'The knowledge-base route returned a body that is not JSON.', {
        hint: 'If this deployment has no RAG service, disable behavior.useKnowledgeBase and stop using starbridge_kb_query.',
        cause,
      })
    })) as KbResponseBody

    const raw = Array.isArray(payload.hits) ? payload.hits : Array.isArray(payload.results) ? payload.results : Array.isArray(payload.data) ? payload.data : null
    if (raw === null) {
      throw new StarBridgeError(
        'GATEWAY_BAD_RESPONSE',
        'The knowledge-base route returned no `hits` array.',
        { hint: 'The gateway does not appear to expose RAG search; treat starbridge_kb_query as unavailable here.' },
      )
    }

    const hits: StarBridgeKbHit[] = []
    for (const candidate of raw) {
      if (typeof candidate !== 'object' || candidate === null) continue
      const record = candidate as Record<string, unknown>
      const title = typeof record.title === 'string' ? record.title : typeof record.name === 'string' ? record.name : '(untitled)'
      const reference = typeof record.reference === 'string'
        ? record.reference
        : typeof record.url === 'string'
          ? record.url
          : typeof record.id === 'string'
            ? record.id
            : '(no reference)'
      const snippet = typeof record.snippet === 'string'
        ? record.snippet
        : typeof record.content === 'string'
          ? record.content
          : typeof record.text === 'string'
            ? record.text
            : ''
      const score = typeof record.score === 'number' && Number.isFinite(record.score) ? record.score : undefined
      hits.push({ title, reference, snippet, ...(score === undefined ? {} : { score }) })
    }

    return { hits, traceId }
  }

  /**
   * Forward one feedback record to the gateway.
   *
   * @param record - the feedback to forward.
   * @param signal - caller cancellation.
   * @returns the correlation id used.
   * @throws {StarBridgeError} when forwarding fails; the caller decides whether
   * that is fatal (it is not — the local write is the contract).
   */
  async submitFeedback(record: StarBridgeFeedbackRecord, signal?: AbortSignal): Promise<{ traceId: string }> {
    const traceId = newTraceId('fb')
    await this.request({
      method: 'POST',
      path: '/feedback',
      body: record,
      traceId,
      scenario: 'feedback',
      signal,
    })
    return { traceId }
  }

  /** Abort every request this client still has in flight (plugin teardown). */
  dispose(): void {
    for (const controller of this.inFlight) controller.abort(new Error('starbridge: plugin unloaded'))
    this.inFlight.clear()
  }
}

/** One decoded server-sent event. */
interface SseEvent {
  /** `event:` field, defaulting to `message`. */
  readonly event: string
  /** Joined `data:` lines. */
  readonly data: string
}

/**
 * Decode a `text/event-stream` body into events.
 *
 * Implemented directly rather than with a dependency so the retry/abort
 * semantics above stay in one place and no extra module has to be declared in
 * `dsh.client.external`.
 *
 * @param body - the response body stream.
 * @param signal - caller cancellation.
 * @yields one event per blank-line-terminated record.
 */
export async function* readSseEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      if (signal?.aborted === true) throw new StarBridgeError('CALLER_ABORTED', 'The stream was cancelled by the caller.')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let separator = findEventBoundary(buffer)
      while (separator !== null) {
        const chunk = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator.length)
        const event = parseSseChunk(chunk)
        if (event !== null) yield event
        separator = findEventBoundary(buffer)
      }
    }
    buffer += decoder.decode()
    const tail = parseSseChunk(buffer)
    if (tail !== null) yield tail
  } finally {
    reader.releaseLock()
  }
}

/**
 * Find the next event boundary (`\n\n` or `\r\n\r\n`).
 *
 * @param buffer - accumulated stream text.
 * @returns the boundary index and length, or null.
 */
function findEventBoundary(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return null
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 }
  return { index: lf, length: 2 }
}

/**
 * Parse one raw SSE record.
 *
 * @param chunk - record text without its terminating blank line.
 * @returns the decoded event, or null for comments/keep-alives.
 */
function parseSseChunk(chunk: string): SseEvent | null {
  let event = 'message'
  const data: string[] = []
  for (const rawLine of chunk.split(/\r?\n/)) {
    if (rawLine.length === 0 || rawLine.startsWith(':')) continue
    const colon = rawLine.indexOf(':')
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon)
    const value = colon === -1 ? '' : rawLine.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  if (data.length === 0) return null
  return { event, data: data.join('\n') }
}

/**
 * Fold whatever a gateway frame looks like into zero or more deltas.
 *
 * Recognised shapes, in order: OpenAI-compatible
 * `choices[0].delta.content`, a flat `delta`, a flat `text`, and finally a
 * `conversation_id` marker frame.
 *
 * @param payload - parsed SSE JSON payload.
 * @returns the deltas this frame carries (possibly empty).
 */
export function normalizeChatFrame(payload: unknown): StarBridgeChatDelta[] {
  if (typeof payload !== 'object' || payload === null) return []
  const frame = payload as Record<string, unknown>

  const conversationId = typeof frame.conversation_id === 'string'
    ? frame.conversation_id
    : typeof frame.conversationId === 'string'
      ? frame.conversationId
      : undefined
  const withConversation = conversationId === undefined ? {} : { conversationId }

  const choices = frame.choices
  if (Array.isArray(choices)) {
    const out: StarBridgeChatDelta[] = []
    for (const choice of choices) {
      if (typeof choice !== 'object' || choice === null) continue
      const record = choice as Record<string, unknown>
      const delta = record.delta
      if (typeof delta === 'object' && delta !== null) {
        const content = (delta as Record<string, unknown>).content
        if (typeof content === 'string' && content.length > 0) out.push({ text: content, done: false, ...withConversation })
      } else if (typeof record.text === 'string' && record.text.length > 0) {
        out.push({ text: record.text, done: false, ...withConversation })
      }
    }
    return out
  }

  if (typeof frame.delta === 'string' && frame.delta.length > 0) {
    return [{ text: frame.delta, done: false, ...withConversation }]
  }
  if (typeof frame.text === 'string' && frame.text.length > 0) {
    return [{ text: frame.text, done: false, ...withConversation }]
  }
  if (conversationId !== undefined) return [{ text: '', done: false, conversationId }]
  return []
}
