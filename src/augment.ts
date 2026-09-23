/**
 * Cordis declaration merging for the StarBridge plugin.
 *
 * The host registers its API as the `ctx.starBridge` service and reports every
 * recorded feedback item as the `starBridge/feedback` event. Declaring both here
 * is what makes `ctx.starBridge` and `ctx.emit('starBridge/feedback', …)` typed
 * for every other host plugin, and keeps the service surface documented in one
 * place instead of being inferred from a class body.
 *
 * This file therefore reads as a contract, not a module: it exports the service
 * interface and augments `Context` / `Events`. Note the deliberate
 * `import type { Context } from '@deepseek-ai/cordis'` below — it mirrors what
 * every shipped DSH package does (`dsh-tools`, `dsh-agent`, …), and the module
 * augmentation resolves against the same module identity only when this file
 * names the package itself.
 *
 * @module @company/dsh-starbridge-client/augment
 */

import type { Context } from '@deepseek-ai/cordis'

import type {
  StarBridgeAccessStatus,
  StarBridgeAuthStatus,
  StarBridgeChatDelta,
  StarBridgeChatMessage,
  StarBridgeConnectivityReport,
  StarBridgeConnectOutcome,
  StarBridgeFeedbackRecord,
  StarBridgeFeedbackResult,
  StarBridgeFeedbackVerdict,
  StarBridgeGatewaySettingsView,
  StarBridgeKbResult,
  StarBridgeLoginInput,
  StarBridgeModelRouteStatus,
  StarBridgeSettingsInput,
  StarBridgeStatusReport,
} from './shared/protocol.ts'

/** Reply returned by {@link StarBridgeService.chat}. */
export interface StarBridgeChatOutcome {
  /** Full assistant reply. */
  readonly reply: string
  /** Gateway conversation id, when the provider returned one. */
  readonly conversationId?: string
  /** Correlation id for this exchange. */
  readonly traceId: string
}

/** Input accepted by {@link StarBridgeService.chat} and `chatStream`. */
export interface StarBridgeChatInput {
  /** Conversation so far, oldest first. */
  readonly messages: readonly StarBridgeChatMessage[]
  /** Scenario override; defaults to the configured scenario. */
  readonly scenario?: string
  /** Ask the gateway to ground the answer in the knowledge base. */
  readonly useKnowledgeBase?: boolean
  /** Caller cancellation, forwarded to the gateway request. */
  readonly signal?: AbortSignal | undefined
}

/** Input accepted by {@link StarBridgeService.recordFeedback}. */
export interface StarBridgeFeedbackInput {
  /** Durable assistant message id being judged. */
  readonly messageId: string
  /** Like or dislike. */
  readonly verdict: StarBridgeFeedbackVerdict
  /** Correction or reason, in the user's words. */
  readonly note?: string
  /** The answer the user expected; used by the platform to grade answers. */
  readonly expectation?: string
  /** StarBridge conversation the message belongs to. */
  readonly conversationId?: string
  /** DSH session the feedback was collected in. */
  readonly sessionId?: string
  /** Caller cancellation, forwarded to the forwarding request. */
  readonly signal?: AbortSignal | undefined
}

/** Input accepted by {@link StarBridgeService.queryKnowledgeBase}. */
export interface StarBridgeKbQueryInput {
  /** Natural-language query. */
  readonly query: string
  /** Maximum hits to return; defaults to the configured limit. */
  readonly topK?: number
  /** Caller cancellation. */
  readonly signal?: AbortSignal | undefined
}

/**
 * The host-side StarBridge API.
 *
 * The three registered tools and every HTTP route are thin adapters over these
 * methods, so there is exactly one implementation of "what StarBridge does" and
 * the browser never reaches the gateway directly.
 */
export interface StarBridgeService {
  /** Non-secret status of the deployment and the current session. */
  status(): StarBridgeStatusReport

  /** Current authentication projection. */
  authStatus(): StarBridgeAuthStatus

  /** Whether this deployment configured sign-in. */
  readonly oidcConfigured: boolean

  /** Effective gateway base URL. */
  readonly gatewayUrl: string

  /**
   * Probe the gateway, optionally against a candidate URL.
   * @param gatewayUrlOverride - URL to test instead of the configured one.
   */
  testConnectivity(gatewayUrlOverride?: string): Promise<StarBridgeConnectivityReport>

  /** The gateway credential this user is presenting (non-secret projection). */
  accessStatus(): StarBridgeAccessStatus

  /** Where DSH's model calls go, and whether that is the StarBridge route. */
  modelRouteStatus(): StarBridgeModelRouteStatus

  /** The stored access configuration (address and identity, never secrets). */
  getGatewaySettings(): StarBridgeGatewaySettingsView

  /**
   * Update the stored access configuration.
   * @param patch - fields to change.
   */
  updateGatewaySettings(patch: StarBridgeSettingsInput): Promise<StarBridgeGatewaySettingsView>

  /**
   * Store an access key and switch this user to it.
   * @param accessKey - the key as typed.
   */
  useAccessKey(accessKey: string): Promise<StarBridgeAccessStatus>

  /**
   * Sign in with a platform account.
   * @param input - address (optional), account name, and password.
   */
  loginWithPlatform(input: StarBridgeLoginInput): Promise<StarBridgeConnectOutcome>

  /**
   * One-click connect with an access key: probe, store, and route model calls.
   * @param input - address, key, identity, and whether to route models.
   */
  connectWithAccessKey(input: {
    baseUrl?: string
    accessKey: string
    userId?: string
    department?: string
    routeModels?: boolean
  }): Promise<StarBridgeConnectOutcome>

  /**
   * Turn model routing on or off, applying it immediately.
   * @param enabled - whether new agents should default to the StarBridge route.
   */
  setModelRouting(enabled: boolean): Promise<StarBridgeConnectOutcome>

  /** Forget the stored gateway credential (platform session and access key). */
  forgetAccess(): Promise<StarBridgeAccessStatus>

  /**
   * Build the authorization URL for a new sign-in.
   * @param redirectUri - loopback callback registered with the provider.
   */
  beginLogin(redirectUri: string): Promise<string>

  /**
   * Complete a sign-in from the provider callback.
   * @param code - authorization code.
   * @param state - CSRF state echoed by the provider.
   * @param redirectUri - the same callback used to start the flow.
   */
  completeLogin(code: string, state: string, redirectUri: string): Promise<StarBridgeAuthStatus>

  /** Forget the session (memory and the encrypted vault). */
  logout(): Promise<void>

  /**
   * Run one chat exchange and buffer the reply.
   * @param input - messages, scenario, and cancellation.
   */
  chat(input: StarBridgeChatInput): Promise<StarBridgeChatOutcome>

  /**
   * Run one chat exchange as a delta stream.
   * @param input - messages, scenario, and cancellation.
   */
  chatStream(input: StarBridgeChatInput): AsyncGenerator<StarBridgeChatDelta, { traceId: string; conversationId?: string }, void>

  /**
   * Search the company knowledge base.
   * @param input - query, top-k, and cancellation.
   */
  queryKnowledgeBase(input: StarBridgeKbQueryInput): Promise<StarBridgeKbResult>

  /**
   * Record feedback locally and optionally forward it to the gateway.
   * @param input - the judgement to record.
   */
  recordFeedback(input: StarBridgeFeedbackInput): Promise<StarBridgeFeedbackResult>

  /** Recent feedback records, newest first (settings panel read). */
  feedbackHistory(limit?: number): StarBridgeFeedbackRecord[]

  /** Abort in-flight work and drop retained state (plugin teardown). */
  dispose(): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** StarBridge client service, provided while this plugin is loaded. */
    starBridge: StarBridgeService
  }

  interface Events {
    /**
     * One piece of StarBridge feedback was recorded. Fired in addition to the
     * gateway forward, so a deployment can build its own review queue without
     * polling the gateway.
     * @param record - the recorded judgement.
     */
    'starBridge/feedback'(record: StarBridgeFeedbackRecord): void
  }
}

/** Re-exported so consumers can name the service type without a second import. */
export type { Context }
