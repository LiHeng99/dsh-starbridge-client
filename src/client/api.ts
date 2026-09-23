/**
 * Browser-side StarBridge API client.
 *
 * The browser talks ONLY to this plugin's own host routes; it never learns the
 * gateway URL's credentials, never holds an access token, and never retries —
 * all of that is the host half's job. This module is therefore thin on purpose:
 * build a request, read the NDJSON frame stream, and turn the server's typed
 * error envelope into an exception the UI can branch on.
 *
 * @module dsh-starbridge-client/client/api
 */

import { STARBRIDGE_ROUTE_PREFIX } from '../shared/protocol.ts'
import type {
  StarBridgeAccessKeyInput,
  StarBridgeChatFrame,
  StarBridgeChatMessage,
  StarBridgeConnectivityReport,
  StarBridgeConnectOutcome,
  StarBridgeErrorBody,
  StarBridgeFeedbackResult,
  StarBridgeFeedbackVerdict,
  StarBridgeLoginInput,
  StarBridgeSettingsInput,
  StarBridgeStatusReport,
} from '../shared/protocol.ts'

/** A failure reported by the host half, with its actionable hint. */
export class StarBridgeClientError extends Error {
  /** Stable machine-readable code from the host envelope. */
  readonly code: string

  /** Actionable next step, when the host supplied one. */
  readonly hint: string | undefined

  /** HTTP status, when the failure was an HTTP response. */
  readonly status: number

  /**
   * @param code - machine-readable code.
   * @param message - human-readable message.
   * @param options - HTTP status and actionable hint.
   */
  constructor(code: string, message: string, options: { status?: number; hint?: string } = {}) {
    super(message)
    this.name = 'StarBridgeClientError'
    this.code = code
    this.hint = options.hint
    this.status = options.status ?? 0
  }

  /** Whether the user must sign in before this call can succeed. */
  get needsLogin(): boolean {
    return this.code === 'AUTH_REQUIRED' || this.code === 'AUTH_NOT_CONFIGURED' || this.status === 401
  }
}

/**
 * Issue one JSON request against the plugin's host routes.
 *
 * @param path - route path below the plugin prefix.
 * @param init - fetch options.
 * @returns the parsed JSON body.
 * @throws {StarBridgeClientError} on transport failure or a host error envelope.
 */
async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${STARBRIDGE_ROUTE_PREFIX}${path}`, {
      ...init,
      headers: { accept: 'application/json', 'content-type': 'application/json', ...init.headers },
    })
  } catch (cause) {
    throw new StarBridgeClientError(
      'HOST_UNREACHABLE',
      `The DSH host could not be reached (${String(cause)}).`,
      { hint: 'The DSH server may have stopped. Reload the page once it is back.' },
    )
  }

  const text = await response.text()
  let body: unknown = null
  if (text.length > 0) {
    try {
      body = JSON.parse(text)
    } catch {
      throw new StarBridgeClientError(
        'HOST_BAD_RESPONSE',
        `The host answered ${response.status} with a body that is not JSON.`,
        { status: response.status },
      )
    }
  }

  if (!response.ok) {
    const envelope = body as StarBridgeErrorBody | null
    throw new StarBridgeClientError(
      envelope?.code ?? `HTTP_${response.status}`,
      envelope?.message ?? `The host answered HTTP ${response.status}.`,
      {
        status: response.status,
        ...(envelope?.hint === undefined ? {} : { hint: envelope.hint }),
      },
    )
  }
  return body as T
}

/** One streamed chat frame handed to the panel. */
export type ChatStreamEvent =
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'done'; readonly traceId: string; readonly conversationId?: string }

/** StarBridge browser API. */
export const starBridgeApi = {
  /**
   * Read the deployment and session status.
   * @returns the host status report.
   */
  async status(): Promise<StarBridgeStatusReport> {
    return requestJson<StarBridgeStatusReport>('/status')
  },

  /**
   * Probe the gateway, optionally against a candidate URL.
   * @param gatewayUrl - candidate URL to test instead of the configured one.
   * @returns the connectivity report.
   */
  async testConnectivity(gatewayUrl?: string): Promise<StarBridgeConnectivityReport> {
    return requestJson<StarBridgeConnectivityReport>('/connectivity', {
      method: 'POST',
      body: JSON.stringify(gatewayUrl === undefined || gatewayUrl.length === 0 ? {} : { gatewayUrl }),
    })
  },

  /**
   * Stream one chat exchange, invoking `onEvent` per frame.
   *
   * @param input - conversation and scenario.
   * @param onEvent - called for every delta and for the terminal frame.
   * @param signal - caller cancellation.
   * @throws {StarBridgeClientError} on a host error envelope or a mid-stream error frame.
   */
  async chat(
    input: { messages: readonly StarBridgeChatMessage[]; scenario?: string },
    onEvent: (event: ChatStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    let response: Response
    try {
      response = await fetch(`${STARBRIDGE_ROUTE_PREFIX}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify(input),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (cause) {
      if (signal?.aborted === true) return
      throw new StarBridgeClientError('HOST_UNREACHABLE', `The DSH host could not be reached (${String(cause)}).`)
    }

    // A failure BEFORE the stream starts arrives as a normal JSON envelope.
    if (!response.ok) {
      const envelope = await response.json().catch(() => null) as StarBridgeErrorBody | null
      throw new StarBridgeClientError(
        envelope?.code ?? `HTTP_${response.status}`,
        envelope?.message ?? `The host answered HTTP ${response.status}.`,
        { status: response.status, ...(envelope?.hint === undefined ? {} : { hint: envelope.hint }) },
      )
    }
    if (response.body === null) {
      throw new StarBridgeClientError('HOST_BAD_RESPONSE', 'The host returned an empty chat stream.', {
        status: response.status,
      })
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line.length > 0) handleFrame(line, onEvent)
          newline = buffer.indexOf('\n')
        }
      }
      const tail = buffer.trim()
      if (tail.length > 0) handleFrame(tail, onEvent)
    } finally {
      reader.releaseLock()
    }
  },

  /**
   * Record feedback for one assistant message.
   * @param input - message id, verdict, and optional note / expected answer.
   * @returns the host result, including the forwarding outcome.
   */
  async feedback(input: {
    messageId: string
    verdict: StarBridgeFeedbackVerdict
    note?: string
    expectation?: string
    conversationId?: string
    sessionId?: string
  }): Promise<StarBridgeFeedbackResult> {
    return requestJson<StarBridgeFeedbackResult>('/feedback', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  /**
   * Ask the host for an authorization URL.
   * @returns the URL to open in a new tab.
   */
  async beginLogin(): Promise<{ authorizeUrl: string; redirectUri: string }> {
    return requestJson<{ authorizeUrl: string; redirectUri: string }>('/login', { method: 'POST' })
  },

  /** Forget the session on the host. */
  async logout(): Promise<void> {
    await requestJson<{ ok: boolean }>('/logout', { method: 'POST' })
  },

  /**
   * Save the access configuration the user filled in.
   *
   * @param settings - address, identity, and any routing preferences to change.
   * @returns the stored settings and the refreshed status.
   */
  async saveGatewaySettings(settings: StarBridgeSettingsInput): Promise<{ ok: boolean; status: StarBridgeStatusReport }> {
    return requestJson<{ ok: boolean; status: StarBridgeStatusReport }>('/gateway/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    })
  },

  /**
   * Connect with an access key: probe, store, and route model calls.
   *
   * @param input - address, key, identity, and whether to route models.
   * @returns the step checklist plus the refreshed status.
   */
  async connectWithAccessKey(input: StarBridgeAccessKeyInput): Promise<StarBridgeConnectOutcome> {
    return requestJson<StarBridgeConnectOutcome>('/gateway/access-key', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  /**
   * Sign in with a StarBridge platform account.
   *
   * @param input - account name, password, and whether to remember them.
   * @returns the step checklist plus the refreshed status.
   */
  async loginWithPlatform(input: StarBridgeLoginInput): Promise<StarBridgeConnectOutcome> {
    return requestJson<StarBridgeConnectOutcome>('/gateway/login', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  /**
   * Turn DSH model routing through StarBridge on or off.
   *
   * @param enabled - whether new sessions should default to the StarBridge route.
   * @returns the step checklist plus the refreshed status.
   */
  async setModelRouting(enabled: boolean): Promise<StarBridgeConnectOutcome> {
    return requestJson<StarBridgeConnectOutcome>('/gateway/model-route', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    })
  },

  /**
   * Remove the stored gateway credential (platform session and access key).
   *
   * @returns the refreshed status.
   */
  async forgetAccess(): Promise<{ ok: boolean; status: StarBridgeStatusReport }> {
    return requestJson<{ ok: boolean; status: StarBridgeStatusReport }>('/gateway/forget', { method: 'POST' })
  },
}

/**
 * Apply one NDJSON frame to the caller.
 *
 * @param line - one frame's JSON text.
 * @param onEvent - frame sink.
 * @throws {StarBridgeClientError} when a frame is malformed or reports an error.
 */
function handleFrame(line: string, onEvent: (event: ChatStreamEvent) => void): void {
  let frame: StarBridgeChatFrame
  try {
    frame = JSON.parse(line) as StarBridgeChatFrame
  } catch {
    // A partial line should be impossible (frames are newline-delimited), but a
    // stray chunk must not kill an in-progress answer.
    return
  }
  if (frame.type === 'delta') {
    onEvent({ type: 'delta', text: frame.text })
    return
  }
  if (frame.type === 'done') {
    onEvent({
      type: 'done',
      traceId: frame.traceId,
      ...(frame.conversationId === undefined ? {} : { conversationId: frame.conversationId }),
    })
    return
  }
  throw new StarBridgeClientError(frame.code, frame.message, {
    ...(frame.hint === undefined ? {} : { hint: frame.hint }),
  })
}
