/**
 * StarBridge wire protocol shared by the host and browser halves.
 *
 * This module is TYPE-ONLY plus a few frozen constants: the host compiles it
 * into `lib/`, the client bundle inlines it, and `scripts/verify.mjs` imports
 * the built host artifact. Keeping it dependency-free is what lets one file be
 * the single authority for the request/response shapes crossing the
 * `/starbridge/api` boundary.
 *
 * @module @company/dsh-starbridge-client/protocol
 */

/** Route prefix of every HTTP endpoint this plugin owns on the DSH web server. */
export const STARBRIDGE_ROUTE_PREFIX = '/starbridge/api'

/**
 * Identity attached to every gateway request. `userId` / `department` /
 * `scenario` are employee facts the deployment supplies; `traceId` is minted
 * per call so a support ticket can be correlated end to end.
 */
export interface StarBridgeIdentity {
  /** Stable employee identifier (SSO subject). */
  readonly userId: string
  /** Organisation unit the request is booked against. */
  readonly department: string
  /** Calling scenario, e.g. `chat`, `kb`, `feedback`. */
  readonly scenario: string
  /** Per-call correlation id propagated to the gateway and echoed in logs. */
  readonly traceId: string
}

/** Authentication lifecycle as the browser is allowed to see it. */
export type StarBridgeAuthState = 'anonymous' | 'authenticating' | 'authenticated' | 'expired'

/** Non-secret authentication projection returned by the status route. */
export interface StarBridgeAuthStatus {
  readonly state: StarBridgeAuthState
  /** OIDC subject / preferred username, present once authenticated. */
  readonly subject?: string
  /** Configured department, or `null` when the deployment did not set one. */
  readonly department: string | null
  /** Epoch millis at which the access token stops being valid. */
  readonly expiresAt?: number
  /** Present when the last attempt failed; safe to render to the user. */
  readonly lastError?: string
}

/** One turn of chat history sent to the gateway. */
export interface StarBridgeChatMessage {
  /** `user`, `assistant`, or `system`. */
  readonly role: 'user' | 'assistant' | 'system'
  /** Plain-text content of the turn. */
  readonly content: string
}

/** Gateway chat request payload produced by the host. */
export interface StarBridgeChatRequest {
  /** Ordered conversation, oldest first. */
  readonly messages: readonly StarBridgeChatMessage[]
  /** Landing scenario key for gateway routing/telemetry. */
  readonly scenario: string
  /** Whether the deployment asked for a knowledge-base-augmented answer. */
  readonly useKnowledgeBase: boolean
  /** Identity block every StarBridge request carries. */
  readonly identity: StarBridgeIdentity
  /** Optional caller-supplied overrides the gateway understands. */
  readonly options?: Readonly<Record<string, string | number | boolean>>
}

/** One streamed delta from the gateway. */
export interface StarBridgeChatDelta {
  /** Text appended to the assistant message so far. */
  readonly text: string
  /** `true` on the terminal frame (carries no text). */
  readonly done: boolean
  /** Gateway conversation id, when the provider returns one. */
  readonly conversationId?: string
}

/** Terminal summary of one chat exchange — what the `starbridge_chat` tool returns. */
export interface StarBridgeChatResult {
  /** Full assistant reply. */
  readonly reply: string
  /** Gateway conversation id, for follow-ups and feedback correlation. */
  readonly conversationId?: string
  /** Correlation id, echoed so the model and the user can quote it in a ticket. */
  readonly traceId: string
}

/** Sentiment recorded by `starbridge_feedback`. */
export type StarBridgeFeedbackVerdict = 'up' | 'down'

/** Payload recorded by `starbridge_feedback` and mirrored into the session log. */
export interface StarBridgeFeedbackRecord {
  /** Which assistant message the judgement is about. */
  readonly messageId: string
  /** Like or dislike. */
  readonly verdict: StarBridgeFeedbackVerdict
  /** Free-text correction or reason, when the user supplied one. */
  readonly note?: string
  /**
   * What the answer should have been.
   *
   * Kept separate from {@link note} on purpose: `note` says what is wrong, this
   * says what is right. The platform's evaluation builds (question, expectation)
   * pairs from it, so a note used as an expectation would grade answers against
   * a complaint.
   */
  readonly expectation?: string
  /** Conversation the message belongs to, when known. */
  readonly conversationId?: string
  /** DSH session id the feedback was collected in. */
  readonly sessionId: string
  /** Epoch millis the feedback was recorded. */
  readonly recordedAt: number
}

/** Result of persisting feedback locally and (optionally) forwarding it. */
export interface StarBridgeFeedbackResult {
  /** Always `true`: the local write is the contract. */
  readonly recorded: boolean
  /** Where the local record was written. */
  readonly storage: 'session-event' | 'memory'
  /** Forwarding outcome: skipped, accepted, or the forwarding error text. */
  readonly forwarded: 'skipped' | 'accepted' | 'failed'
  /** Correlation id of the forwarding attempt, when one happened. */
  readonly traceId?: string
  /** Human-readable detail for a failed forward. */
  readonly detail?: string
}

/** One knowledge-base hit. */
export interface StarBridgeKbHit {
  /** Document title. */
  readonly title: string
  /** Stable document reference for citations. */
  readonly reference: string
  /** Relevance score reported by the gateway, when available. */
  readonly score?: number
  /** Matched passage. */
  readonly snippet: string
}

/** Result of `starbridge_kb_query`. */
export interface StarBridgeKbResult {
  /** Ranked hits, best first. */
  readonly hits: readonly StarBridgeKbHit[]
  /** Correlation id, for support tickets. */
  readonly traceId: string
}

/** Body of `POST /starbridge/api/chat`. */
export interface StarBridgeChatRouteRequest {
  /** Conversation so far, oldest first. */
  readonly messages: readonly StarBridgeChatMessage[]
  /** Optional scenario override; defaults to the configured one. */
  readonly scenario?: string
  /** Optional session id used to key feedback records. */
  readonly sessionId?: string
}

/** NDJSON frames emitted by `POST /starbridge/api/chat`. */
export type StarBridgeChatFrame =
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'done'; readonly conversationId?: string; readonly traceId: string }
  | { readonly type: 'error'; readonly code: string; readonly message: string; readonly hint?: string }

/** Body of `POST /starbridge/api/connectivity`. */
export interface StarBridgeConnectivityReport {
  /** Whether the gateway answered the probe. */
  readonly reachable: boolean
  /** HTTP status of the probe, when a response was received. */
  readonly status?: number
  /** Round-trip time in milliseconds. */
  readonly latencyMs: number
  /** Configured base URL the probe used. */
  readonly gatewayUrl: string
  /** Whether the probe presented an access token. */
  readonly authenticated: boolean
  /**
   * Whether the server says its own machine credential is configured.
   *
   * `false` is not "this client is broken": a server with no access-key set
   * answers `/gw/health` happily but rejects every protected route, so the
   * distinction is worth surfacing before the user blames their own setup.
   */
  readonly authReady?: boolean
  /** Failure text when `reachable` is false. */
  readonly error?: string
  /** Actionable next step for the operator. */
  readonly hint?: string
}

/** Body of `GET /starbridge/api/status`. */
export interface StarBridgeStatusReport {
  /** Authentication projection. */
  readonly auth: StarBridgeAuthStatus
  /** Effective (config-resolved) gateway base URL. */
  readonly gatewayUrl: string
  /** Machine face base URL (`<baseUrl>/gw`) requests are actually sent to. */
  readonly faceUrl: string
  /** Model face base URL (`<baseUrl>/gw/v1`) the llm provider route uses. */
  readonly modelUrl: string
  /** Effective request timeout in milliseconds. */
  readonly timeoutMs: number
  /** Effective retry count. */
  readonly maxRetries: number
  /** Whether OIDC is configured for this deployment. */
  readonly oidcConfigured: boolean
  /** OIDC issuer the browser will be redirected to, when configured. */
  readonly oidcIssuer: string | null
  /** Whether the knowledge-base scenario is enabled. */
  readonly knowledgeBaseEnabled: boolean
  /** The gateway credential this user is presenting. */
  readonly access: StarBridgeAccessStatus
  /** Where DSH's model calls are being sent. */
  readonly modelRoute: StarBridgeModelRouteStatus
  /** The non-secret access configuration, as stored. */
  readonly gatewaySettings: StarBridgeGatewaySettingsView
  /** Absolute path of the file the access configuration is stored in. */
  readonly settingsFile: string
  /** Whether that file could be written. */
  readonly settingsWritable: boolean
}

/**
 * The gateway credential, as the browser may see it.
 *
 * No field here is a credential: the key, the token, and any stored password
 * stay on the host. `kind: 'none'` with `authMode: 'access-key'` is therefore a
 * normal state — it means the key lives in the deployment's environment rather
 * than in this user's credential store.
 */
export interface StarBridgeAccessStatus {
  /**
   * Which credential is actually usable right now.
   *
   * `access-key` covers both the key this user typed and one the deployment
   * injected: from the gateway's point of view they are the same credential, and
   * the settings page only needs to know that one exists.
   */
  readonly kind: 'none' | 'access-key' | 'platform-token' | 'sso'
  /** Which credential the user selected as their way in. */
  readonly authMode: StarBridgeGatewayAuthMode
  /** Platform account signed in, when one is. */
  readonly account: string | null
  /** Epoch millis the platform token stops being valid, when known. */
  readonly expiresAt: number | null
  /** Identity reported to the gateway (token identity wins server-side). */
  readonly userId: string
  /** Last credential failure, safe to render. */
  readonly lastError: string | null
  /** Whether the stored credentials allow automatic renewal. */
  readonly canRenew: boolean
  /** The credential reference the model route resolves (display only). */
  readonly credentialRef: string
}

/** How this user proved who they are to the gateway. */
export type StarBridgeGatewayAuthMode = 'unconfigured' | 'access-key' | 'account' | 'sso'

/** Where DSH's model calls go, and whether that is the StarBridge route. */
export interface StarBridgeModelRouteStatus {
  /** Provider route name the plugin manages. */
  readonly provider: string
  /** Model (scenario key) the default selection uses. */
  readonly model: string
  /** Whether the user asked for model calls to go through StarBridge. */
  readonly routedThroughGateway: boolean
  /** Provider an agent would use right now, when DSH reports one. */
  readonly activeProvider: string | null
  /** Model an agent would use right now, when DSH reports one. */
  readonly activeModel: string | null
  /** Whether this DSH exposes the services needed to apply the routing. */
  readonly supported: boolean
  /** OpenAI-compatible base URL the route should point at. */
  readonly baseUrl: string
}

/** The non-secret access configuration, mirrored to the browser for editing. */
export interface StarBridgeGatewaySettingsView {
  /** Gateway base URL, normalized (no trailing slash). */
  readonly baseUrl: string
  /** Employee identifier reported to the gateway. */
  readonly userId: string
  /** Organisation unit usage is booked against. */
  readonly department: string
  /** Credential the user selected. */
  readonly authMode: StarBridgeGatewayAuthMode
  /** Provider route name the plugin manages. */
  readonly modelProvider: string
  /** Model (scenario key) the default selection uses. */
  readonly model: string
  /** Whether new agents default to the StarBridge route. */
  readonly routeModelsThroughGateway: boolean
}

/** Body of `POST /starbridge/api/gateway/settings`. */
export interface StarBridgeSettingsInput {
  /** Gateway address as typed; normalized by the host. */
  readonly baseUrl?: string
  /** Employee identifier. */
  readonly userId?: string
  /** Organisation unit. */
  readonly department?: string
  /** Credential to switch to. */
  readonly authMode?: StarBridgeGatewayAuthMode
  /** Provider route name to manage. */
  readonly modelProvider?: string
  /** Model (scenario key) to select. */
  readonly model?: string
  /** Whether new agents should default to the StarBridge route. */
  readonly routeModelsThroughGateway?: boolean
}

/** Body of `POST /starbridge/api/gateway/login`. */
export interface StarBridgeLoginInput {
  /** Address to sign in to; defaults to the stored one. */
  readonly baseUrl?: string
  /** Platform account name. */
  readonly username: string
  /** Platform account password. */
  readonly password: string
  /** Seal the credentials so the token can be renewed automatically. */
  readonly remember?: boolean
  /** Point model calls at the gateway as part of signing in. */
  readonly routeModels?: boolean
}

/** Body of `POST /starbridge/api/gateway/access-key`. */
export interface StarBridgeAccessKeyInput {
  /** Address to use; defaults to the stored one. */
  readonly baseUrl?: string
  /** The key the StarBridge console issued. */
  readonly accessKey: string
  /** Employee identifier to report. */
  readonly userId?: string
  /** Organisation unit to report. */
  readonly department?: string
  /** Point model calls at the gateway as part of connecting. */
  readonly routeModels?: boolean
}

/** One step of the "connect to StarBridge" sequence. */
export interface StarBridgeConnectStep {
  /** Stable step name: `address` | `reachable` | `credential` | `model-route`. */
  readonly name: string
  /** Whether the step succeeded. */
  readonly ok: boolean
  /** Human-readable outcome. */
  readonly detail: string
  /** Actionable next step when it failed. */
  readonly hint?: string
}

/** Result of a connect/sign-in sequence, rendered as a checklist. */
export interface StarBridgeConnectOutcome {
  /** Whether every step succeeded. */
  readonly ok: boolean
  /** The steps that ran, in order. */
  readonly steps: readonly StarBridgeConnectStep[]
  /** Status after the sequence, so the UI does not need a second round trip. */
  readonly status: StarBridgeStatusReport
}

/** Body of `POST /starbridge/api/feedback`. */
export interface StarBridgeFeedbackRouteRequest {
  /** Durable assistant message id supplied by the client slot. */
  readonly messageId: string
  /** Like or dislike. */
  readonly verdict: StarBridgeFeedbackVerdict
  /** Optional correction text. */
  readonly note?: string
  /** Optional expected answer (what the reply should have said). */
  readonly expectation?: string
  /** Conversation id, when the client knows it. */
  readonly conversationId?: string
  /** DSH session id; defaults to `unknown` when the caller has none. */
  readonly sessionId?: string
}

/** Uniform error envelope returned by every JSON route on failure. */
export interface StarBridgeErrorBody {
  /** Stable machine-readable code. */
  readonly code: string
  /** Human-readable message. */
  readonly message: string
  /** Actionable next step for the operator or user. */
  readonly hint?: string
}
