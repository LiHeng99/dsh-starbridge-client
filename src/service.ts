/**
 * The host-side StarBridge service: composition root for auth, gateway, and
 * feedback, and the single implementation behind the tools and the HTTP routes.
 *
 * Kept out of `index.ts` so the plugin entry point is readable as a
 * composition, and out of `gateway.ts` so the transport never learns about
 * sessions or feedback. Nothing here is Cordis-aware beyond the logger shape,
 * which is what lets `scripts/verify.mjs` drive the whole host half under plain
 * Node.
 *
 * Two credential worlds meet here and are deliberately kept apart:
 *
 * - the **gateway credential** (access key or platform token) is the user's,
 *   entered on the settings page, and it is what routes model calls through the
 *   platform;
 * - the **OIDC session** is the deployment's, unchanged, and still takes part in
 *   tool calls when a site runs single sign-on.
 *
 * @module @company/dsh-starbridge-client/service
 */

import { AuthManager, EncryptedTokenPersistence, MemoryTokenPersistence, type TokenPersistence } from './auth.ts'
import { isOidcConfigured, type ResolvedConfig } from './config.ts'
import { StarBridgeError } from './errors.ts'
import { FeedbackStore, type FeedbackSessionSink } from './feedback-store.ts'
import {
  GatewayAccess,
  MODEL_ROUTE_CREDENTIAL_REF,
  loginToPlatform,
  probeGatewayFace,
  type PlatformLoginOutcome,
} from './gateway-access.ts'
import {
  defaultGatewaySettings,
  gatewayUrls,
  normalizeGatewayBaseUrl,
  type GatewayConfigStore,
  type StarBridgeGatewaySettings,
} from './gateway-config.ts'
import { StarBridgeGateway, type AccessTokenProvider } from './gateway.ts'
import type {
  StarBridgeChatInput,
  StarBridgeFeedbackInput,
  StarBridgeKbQueryInput,
  StarBridgeService as StarBridgeServiceContract,
} from './augment.ts'
import type {
  StarBridgeAccessStatus,
  StarBridgeAuthStatus,
  StarBridgeChatDelta,
  StarBridgeConnectivityReport,
  StarBridgeConnectOutcome,
  StarBridgeConnectStep,
  StarBridgeFeedbackRecord,
  StarBridgeFeedbackResult,
  StarBridgeKbResult,
  StarBridgeLoginInput,
  StarBridgeModelRouteStatus,
  StarBridgeSettingsInput,
  StarBridgeStatusReport,
} from './shared/protocol.ts'

/** Logger surface the service needs; satisfied by `ctx.logger`. */
export interface ServiceLogger {
  /** Informational line. */
  info(message: string): void
  /** Diagnostic line. */
  warn(message: string): void
}

/** Where persisted tokens live when the deployment wants them to survive a restart. */
export type PersistenceChoice = { kind: 'encrypted'; directory: string } | { kind: 'memory' }

/** What the service needs from the DSH host to route model calls through StarBridge. */
export interface ModelRouteOps {
  /**
   * Point the deployment's StarBridge provider route at an address.
   * @param baseUrl - gateway base URL as stored.
   * @returns the effective model-face URL the route now uses.
   */
  pointRouteAt(baseUrl: string): Promise<{ modelUrl: string; detail: string }>

  /**
   * Store the credential the route resolves through its `apiKeyEnv`.
   * @param credential - token or access key.
   */
  storeCredential(credential: string): Promise<void>

  /**
   * Read that credential back, or an empty string when none is stored.
   *
   * This is what makes an access key the user typed on the settings page
   * survive a DSH restart: the only durable copy of it is this reference.
   */
  readCredential(): Promise<string>

  /** Remove the stored credential. */
  clearCredential(): Promise<void>

  /**
   * Make new agents default to the StarBridge route.
   * @param provider - provider route name.
   * @param model - model (scenario key).
   * @returns the new selection, for reporting.
   */
  selectDefaultModel(provider: string, model: string): Promise<{ provider: string; model: string; previous: string }>

  /**
   * Report the currently effective model selection.
   * @returns the provider/model an agent would use right now.
   */
  currentSelection(): { provider: string; model: string }
}

/**
 * Host-side implementation of the `ctx.starBridge` contract declared in
 * `augment.ts`. The class name is deliberately distinct from the interface: the
 * contract is what other plugins see, this is how it is built.
 */
export class StarBridgeClient implements StarBridgeServiceContract {
  private readonly config: ResolvedConfig
  private readonly auth: AuthManager
  private readonly gateway: StarBridgeGateway
  private readonly feedback: FeedbackStore
  private readonly logger: ServiceLogger
  private readonly gatewayStore: GatewayConfigStore
  private readonly access: GatewayAccess
  private readonly modelRoute: ModelRouteOps | undefined
  private storeAvailable = true
  private disposed = false

  /**
   * @param options - resolved config, sink for session feedback, persistence
   * choice, the gateway settings store, and the model-route operations.
   */
  constructor(options: {
    config: ResolvedConfig
    logger: ServiceLogger
    sink: FeedbackSessionSink
    persistence: PersistenceChoice
    /** Durable store for the address/identity the user filled in. */
    gatewayStore: GatewayConfigStore
    /** Model-route operations; absent when DSH exposes no model services. */
    modelRoute?: ModelRouteOps | undefined
  }) {
    this.config = options.config
    this.logger = options.logger
    this.gatewayStore = options.gatewayStore
    this.modelRoute = options.modelRoute

    const persistence: TokenPersistence = options.persistence.kind === 'encrypted'
      ? new EncryptedTokenPersistence(options.persistence.directory, options.logger)
      : new MemoryTokenPersistence()

    this.auth = new AuthManager({
      issuerUrl: options.config.oidc.issuerUrl,
      clientId: options.config.oidc.clientId,
      clientSecret: options.config.oidc.clientSecret,
      scopes: options.config.oidc.scopes,
      prompt: options.config.oidc.prompt,
      refreshSkewMs: options.config.oidc.refreshSkewMs,
      timeoutMs: options.config.gateway.timeoutMs,
      department: options.config.identity.department,
      persistence,
      logger: options.logger,
    })

    // The gateway credential is the user's, so this layer always asks the
    // access manager for it; a deployment with neither sign-in nor a key gets a
    // clear AUTH_NOT_CONFIGURED from `configOps` below.
    const access = new GatewayAccess({
      directory: options.persistence.kind === 'encrypted' ? options.persistence.directory : '',
      logger: options.logger,
      // An access key can live in three places, in this order of authority: the
      // one the user typed on the settings page (held by `GatewayAccess`), the
      // one this plugin wrote to the credentials store for the model route
      // (which is what survives a restart), and the deployment's own
      // `gateway.apiKey` / environment variable.
      //
      // Only consulted in access-key mode: that same reference holds the
      // platform token when the user signed in with an account, and mistaking a
      // token for an access key would send it as `x-api-key`.
      readAccessKey: async () => {
        if (this.settings.authMode !== 'access-key') return options.config.gateway.apiKey
        const stored = await this.modelRoute?.readCredential().catch(() => '') ?? ''
        if (stored.length > 0) return stored
        return options.config.gateway.apiKey
      },
      login: (request) => loginToPlatform(request, options.config.gateway.timeoutMs),
      renewSkewMs: options.config.oidc.refreshSkewMs,
    })
    this.access = access
    access.setBaseUrl(this.settings.baseUrl)

    const tokens: AccessTokenProvider = {
      getAccessToken: async (traceId: string): Promise<string> => {
        if (isOidcConfigured(options.config)) {
          // A site running SSO already has a token; prefer it, because it is the
          // deployment's own identity source and the existing behaviour.
          try {
            const token = await this.auth.getAccessToken(traceId)
            if (token.length > 0) return token
          } catch (error) {
            if (!(error instanceof StarBridgeError) || error.code !== 'AUTH_REQUIRED') throw error
          }
        }

        const platformToken = await access.getAccessToken(traceId)
        if (platformToken.length > 0) return platformToken

        // Nothing to present. Fail here with a code the tools turn into advice,
        // rather than sending an anonymous request for the gateway to reject:
        // "sign in first" is actionable, "HTTP 401 from the gateway" is not.
        if (options.config.gateway.apiKey.length === 0) {
          throw new StarBridgeError('AUTH_REQUIRED', 'No StarBridge session is active.', {
            hint: 'Open DSH Settings → 星桥 StarBridge and either paste an access key or sign in with your '
              + 'platform account; or set gateway.apiKey (STARBRIDGE_GATEWAY_API_KEY) for a machine credential.',
          })
        }
        return ''
      },
    }

    this.gateway = new StarBridgeGateway(
      options.config,
      tokens,
      options.logger,
      () => this.settings.baseUrl,
      // The identity is resolved through the same precedence as the status
      // report, so what the settings page shows is literally what the gateway
      // receives rather than a second, independently computed answer.
      () => ({
        userId: this.effectiveUserId(),
        department: this.effectiveDepartment(),
      }),
    )
    this.feedback = new FeedbackStore({
      eventName: options.config.storage.feedbackEventName,
      limit: options.config.storage.feedbackMemoryLimit,
      sink: options.sink,
      logger: options.logger,
    })

    this.logger.info(
      `starbridge: gateway ${this.settings.baseUrl} (timeout ${options.config.gateway.timeoutMs}ms, `
      + `retries ${options.config.gateway.maxRetries}, `
      + `${isOidcConfigured(options.config) ? `sso via ${options.config.oidc.issuerUrl}` : 'no sso configured'}, `
      + `access ${this.settings.authMode})`,
    )
  }

  /**
   * The effective access configuration.
   *
   * Read through the store on every access rather than copied: the disk load
   * finishes after this constructor returns (DSH does not await plugin setup),
   * so a copy taken here would pin the session to the deployment defaults.
   */
  private get settings(): StarBridgeGatewaySettings {
    return this.gatewayStore.effective()
  }

  /** Effective gateway base URL (what every request and route use). */
  get gatewayUrl(): string {
    return this.settings.baseUrl
  }

  /** Whether this deployment configured OIDC sign-in. */
  get oidcConfigured(): boolean {
    return isOidcConfigured(this.config)
  }

  /** Effective gateway settings (non-secret half). */
  getGatewaySettings(): StarBridgeGatewaySettings {
    return { ...this.settings }
  }

  /** @returns the deployment and session status the settings panel renders. */
  status(): StarBridgeStatusReport {
    const urls = gatewayUrls(this.settings.baseUrl)
    return {
      auth: this.authStatus(),
      gatewayUrl: this.settings.baseUrl,
      faceUrl: urls.faceUrl,
      modelUrl: urls.modelUrl,
      timeoutMs: this.gateway.timeoutMs,
      maxRetries: this.gateway.maxRetries,
      oidcConfigured: this.oidcConfigured,
      oidcIssuer: this.config.oidc.issuerUrl.length > 0 ? this.config.oidc.issuerUrl : null,
      knowledgeBaseEnabled: this.config.behavior.useKnowledgeBase,
      access: this.accessStatus(),
      modelRoute: this.modelRouteStatus(),
      gatewaySettings: this.getGatewaySettings(),
      settingsFile: this.gatewayStore.path,
      // True once a configuration was saved (or loaded from disk). Before that
      // there is nothing stored, and the settings page says so rather than
      // claiming a write capability nothing has exercised yet.
      settingsWritable: this.storeAvailable && (this.gatewayStore.hasStoredFile || this.savedOnce),
    }
  }

  /** Whether this session has successfully written the configuration once. */
  private savedOnce = false

  /** @returns the gateway-credential projection the settings panel renders. */
  accessStatus(): StarBridgeAccessStatus {
    // What is actually available, not just what this process typed in: a
    // deployment-level machine credential is a perfectly good way in, and
    // reporting it as "none" would make the settings page tell the user they
    // are not connected while every request succeeds.
    let kind: StarBridgeAccessStatus['kind'] = 'none'
    if (this.access.kind === 'platform-token') kind = 'platform-token'
    else if (this.access.accessKeyPresent || this.config.gateway.apiKey.length > 0) kind = 'access-key'
    else if (this.oidcConfigured && this.auth.getStatus().state === 'authenticated') kind = 'sso'

    return {
      kind,
      authMode: this.settings.authMode,
      account: this.access.accountName ?? this.settings.accountName ?? null,
      expiresAt: this.access.expiresAt ?? this.settings.tokenExpiresAt ?? null,
      userId: this.effectiveUserId(),
      lastError: this.access.error,
      canRenew: this.access.canRenew,
      credentialRef: MODEL_ROUTE_CREDENTIAL_REF,
    }
  }

  /**
   * The identity reported to the gateway.
   *
   * Precedence: what the user filled in on the settings page, then the
   * deployment's `identity.userId`, then the platform account that signed in,
   * then `anonymous`. The value is telemetry for the platform's audit trail —
   * when a platform token is present the server derives the real identity from
   * the token and ignores this header entirely.
   */
  private effectiveUserId(): string {
    if (this.settings.userId.length > 0) return this.settings.userId
    if (this.config.identity.userId.length > 0) return this.config.identity.userId
    return this.access.accountName ?? 'anonymous'
  }

  /** The department reported to the gateway (same precedence as the user id). */
  private effectiveDepartment(): string {
    if (this.settings.department.length > 0) return this.settings.department
    return this.config.identity.department
  }

  /** @returns the model-route projection (what DSH actually calls). */
  modelRouteStatus(): StarBridgeModelRouteStatus {
    const current = this.modelRoute?.currentSelection() ?? null
    return {
      provider: this.settings.modelProvider,
      model: this.settings.model,
      routedThroughGateway: this.settings.routeModelsThroughGateway,
      activeProvider: current?.provider ?? null,
      activeModel: current?.model ?? null,
      supported: this.modelRoute !== undefined,
      baseUrl: gatewayUrls(this.settings.baseUrl).modelUrl,
    }
  }

  /** @returns the current authentication projection. */
  authStatus(): StarBridgeAuthStatus {
    return this.auth.getStatus()
  }

  /**
   * Probe the gateway, optionally against a candidate URL.
   *
   * The override runs against the candidate's own face URL so the settings page
   * can answer "is this address right?" before the user commits it.
   *
   * @param gatewayUrlOverride - candidate base URL.
   * @returns the connectivity report.
   */
  async testConnectivity(gatewayUrlOverride?: string): Promise<StarBridgeConnectivityReport> {
    const candidate = gatewayUrlOverride?.trim()
    if (candidate === undefined || candidate.length === 0) {
      const probe = await probeGatewayFace(this.settings.baseUrl, this.config.gateway.timeoutMs)
      return {
        ...probe,
        gatewayUrl: this.settings.baseUrl,
        authenticated: (await this.access.hasPlatformSession()) || this.config.gateway.apiKey.length > 0,
      }
    }

    const normalized = normalizeGatewayBaseUrl(candidate)
    if (normalized.baseUrl.length === 0) {
      return {
        reachable: false,
        latencyMs: 0,
        gatewayUrl: candidate,
        authenticated: false,
        error: `"${candidate}" is not an absolute URL.`,
        hint: 'Use an address like "https://starbridge.company.com/starbridge/gw".',
      }
    }

    const probe = await probeGatewayFace(normalized.baseUrl, this.config.gateway.timeoutMs)
    return {
      ...probe,
      gatewayUrl: normalized.baseUrl,
      authenticated: await this.access.hasPlatformSession(),
    }
  }

  /**
   * Update the stored access configuration.
   *
   * The address is validated here rather than at write time only, because the
   * same value also feeds the model route: a URL the tools could tolerate but
   * the model route could not would produce a half-working deployment.
   *
   * @param patch - fields to change.
   * @returns the settings as stored.
   * @throws {StarBridgeError} `INVALID_ARGUMENT` when the address is unusable.
   */
  async updateGatewaySettings(patch: StarBridgeSettingsInput): Promise<StarBridgeGatewaySettings> {
    this.assertLive()
    const next: StarBridgeGatewaySettings = { ...this.settings }

    if (patch.baseUrl !== undefined) {
      const normalized = normalizeGatewayBaseUrl(patch.baseUrl)
      if (normalized.baseUrl.length === 0) {
        throw new StarBridgeError('INVALID_ARGUMENT', `"${patch.baseUrl}" is not a usable StarBridge address.`, {
          hint: 'Enter an absolute http(s) address, e.g. "https://starbridge.company.com/starbridge/gw".',
        })
      }
      next.baseUrl = normalized.baseUrl
    }
    if (patch.userId !== undefined) next.userId = patch.userId.trim()
    if (patch.department !== undefined) next.department = patch.department.trim()
    if (patch.modelProvider !== undefined && patch.modelProvider.trim().length > 0) {
      next.modelProvider = patch.modelProvider.trim()
    }
    if (patch.model !== undefined && patch.model.trim().length > 0) next.model = patch.model.trim()
    if (patch.routeModelsThroughGateway !== undefined) next.routeModelsThroughGateway = patch.routeModelsThroughGateway
    if (patch.authMode !== undefined) next.authMode = patch.authMode

    await this.persist(next)
    this.logger.info(`starbridge: access configuration updated (${next.baseUrl}, ${next.authMode})`)
    return { ...next }
  }

  /**
   * Store an access key and switch this user to it.
   *
   * @param accessKey - the key as typed.
   * @returns the status after the change.
   * @throws {StarBridgeError} `INVALID_ARGUMENT` when the key is empty.
   */
  async useAccessKey(accessKey: string): Promise<StarBridgeAccessStatus> {
    this.assertLive()
    const key = accessKey.trim()
    if (key.length === 0) {
      throw new StarBridgeError('INVALID_ARGUMENT', 'The access key is empty.', {
        hint: 'Paste the key the StarBridge console issues, or sign in with your platform account instead.',
      })
    }

    // Order matters: the model route may already be active, so the credential
    // has to exist before the route's next request resolves it.
    if (this.modelRoute !== undefined && this.settings.routeModelsThroughGateway) {
      await this.modelRoute.storeCredential(key)
    }
    await this.access.useAccessKey(key)
    // `accountName` / `tokenExpiresAt` are dropped rather than carried: the
    // coercion that re-reads this record recognises only present string/number
    // values, so an explicit `undefined` would be ignored and a stale account
    // label would survive a switch to key-based access.
    const { accountName: _account, tokenExpiresAt: _expiry, ...rest } = this.settings
    await this.persist({ ...rest, authMode: 'access-key' })
    this.logger.info('starbridge: an access key was stored for this user')
    return this.accessStatus()
  }

  /**
   * Sign in with a platform account.
   *
   * @param input - address (optional), username, and password.
   * @returns the outcome, including what happened to the model route.
   * @throws {StarBridgeError} `AUTH_FAILED` when the platform rejects the credentials.
   */
  async loginWithPlatform(input: StarBridgeLoginInput): Promise<StarBridgeConnectOutcome> {
    this.assertLive()
    const url = input.baseUrl === undefined ? this.settings.baseUrl : normalizeGatewayBaseUrl(input.baseUrl).baseUrl
    if (url.length === 0) {
      throw new StarBridgeError('INVALID_ARGUMENT', 'No usable StarBridge address is configured.', {
        hint: 'Fill in the StarBridge address first, then sign in.',
      })
    }
    if (input.username.trim().length === 0 || input.password.length === 0) {
      throw new StarBridgeError('INVALID_ARGUMENT', 'Both the account name and the password are required.')
    }

    const outcome: PlatformLoginOutcome = await this.access.signInPlatform(
      { baseUrl: url, username: input.username.trim(), password: input.password },
      input.remember !== false,
    )

    await this.persist({
      ...this.settings,
      baseUrl: url,
      authMode: 'account',
      accountName: outcome.username,
      ...(outcome.expiresIn > 0 ? { tokenExpiresAt: Date.now() + outcome.expiresIn * 1000 } : {}),
    })
    this.access.setBaseUrl(url)
    this.logger.info(`starbridge: signed in to the platform as ${outcome.username}`)

    const steps: StarBridgeConnectStep[] = [
      { name: 'address', ok: true, detail: url },
      { name: 'credential', ok: true, detail: `平台账号 ${outcome.username}` },
    ]

    if (input.routeModels !== false) {
      steps.push(await this.applyModelRoute())
    } else {
      steps.push({ name: 'model-route', ok: true, detail: '未改动（按请求保留当前模型路由）' })
    }

    return {
      ok: steps.every((step) => step.ok),
      steps,
      status: this.status(),
    }
  }

  /**
   * One-click connect with an access key: test the address, store the key, and
   * point model calls at the gateway.
   *
   * @param input - address, access key, identity, and whether to route models.
   * @returns a step-by-step outcome the UI can render as a checklist.
   */
  async connectWithAccessKey(input: {
    baseUrl?: string
    accessKey: string
    userId?: string
    department?: string
    routeModels?: boolean
  }): Promise<StarBridgeConnectOutcome> {
    this.assertLive()
    const steps: StarBridgeConnectStep[] = []

    const normalized = normalizeGatewayBaseUrl(input.baseUrl ?? this.settings.baseUrl)
    if (normalized.baseUrl.length === 0) {
      return {
        ok: false,
        steps: [{ name: 'address', ok: false, detail: '请填写星桥地址', hint: '例如 https://starbridge.company.com/starbridge/gw' }],
        status: this.status(),
      }
    }
    steps.push({ name: 'address', ok: true, detail: normalized.baseUrl })

    const probe = await probeGatewayFace(normalized.baseUrl, this.config.gateway.timeoutMs)
    if (!probe.reachable) {
      steps.push({
        name: 'reachable',
        ok: false,
        detail: probe.error ?? '星桥服务不可达',
        ...(probe.hint === undefined ? {} : { hint: probe.hint }),
      })
      return { ok: false, steps, status: this.status() }
    }
    steps.push({
      name: 'reachable',
      ok: true,
      detail: `可达（${probe.latencyMs} ms）${probe.authReady === false ? '，但服务端未配置机器凭据' : ''}`,
    })

    if (input.accessKey.trim().length === 0) {
      steps.push({ name: 'credential', ok: false, detail: '请填写访问密钥', hint: '也可以改用平台账号登录。' })
      return { ok: false, steps, status: this.status() }
    }

    const next: StarBridgeGatewaySettings = {
      ...this.settings,
      baseUrl: normalized.baseUrl,
      authMode: 'access-key',
      ...(input.userId === undefined ? {} : { userId: input.userId.trim() }),
      ...(input.department === undefined ? {} : { department: input.department.trim() }),
    }
    // A switch to key-based access drops the platform account labels, for the
    // same reason as in `useAccessKey`.
    delete next.accountName
    delete next.tokenExpiresAt
    const previousRoute = next.routeModelsThroughGateway
    next.routeModelsThroughGateway = input.routeModels ?? true
    await this.persist(next)
    this.access.setBaseUrl(normalized.baseUrl)

    if (this.modelRoute !== undefined && next.routeModelsThroughGateway) {
      await this.modelRoute.storeCredential(input.accessKey.trim())
    }
    await this.access.useAccessKey(input.accessKey.trim())
    steps.push({ name: 'credential', ok: true, detail: '访问密钥已保存（存放在 DSH 凭据库，不写入配置文件）' })

    if (next.routeModelsThroughGateway && this.modelRoute !== undefined) {
      steps.push(await this.applyModelRoute())
    } else if (this.modelRoute === undefined) {
      steps.push({ name: 'model-route', ok: false, detail: '当前 DSH 未提供模型服务，无法接管模型路由' })
    } else {
      // Turning routing off is a legitimate choice; restore what was there.
      if (previousRoute) await this.modelRoute.clearCredential().catch(() => undefined)
      steps.push({ name: 'model-route', ok: true, detail: '已保持默认模型不变' })
    }

    return { ok: steps.every((step) => step.ok), steps, status: this.status() }
  }

  /**
   * Turn model routing on or off, applying it immediately.
   *
   * @param enabled - whether new agents should default to the StarBridge route.
   * @returns the step outcome.
   */
  async setModelRouting(enabled: boolean): Promise<StarBridgeConnectOutcome> {
    this.assertLive()
    const steps: StarBridgeConnectStep[] = []
    await this.persist({ ...this.settings, routeModelsThroughGateway: enabled })

    if (!enabled) {
      if (this.modelRoute !== undefined) await this.modelRoute.clearCredential().catch(() => undefined)
      steps.push({ name: 'model-route', ok: true, detail: '已关闭：新会话不再默认走星桥网关' })
      return { ok: true, steps, status: this.status() }
    }

    if (this.modelRoute === undefined) {
      steps.push({ name: 'model-route', ok: false, detail: '当前 DSH 未提供模型服务，无法接管模型路由' })
      return { ok: false, steps, status: this.status() }
    }

    const credential = await this.access.credentialForModelRoute()
    if (credential === null) {
      await this.persist({ ...this.settings, routeModelsThroughGateway: false })
      steps.push({ name: 'credential', ok: false, detail: '还没有可用的凭据', hint: '先填访问密钥或用平台账号登录，再打开模型路由。' })
      return { ok: false, steps, status: this.status() }
    }
    await this.modelRoute.storeCredential(credential)
    steps.push({ name: 'credential', ok: true, detail: '凭据已写入模型路由使用的凭据引用' })
    steps.push(await this.applyModelRoute())
    return { ok: steps.every((step) => step.ok), steps, status: this.status() }
  }

  /** Point the provider route at the current address and switch the default model. */
  private async applyModelRoute(): Promise<StarBridgeConnectStep> {
    const route = this.modelRoute
    if (route === undefined) {
      return { name: 'model-route', ok: false, detail: '当前 DSH 未提供模型服务，无法接管模型路由' }
    }
    try {
      const { modelUrl, detail } = await route.pointRouteAt(this.settings.baseUrl)
      const credential = await this.access.credentialForModelRoute()
      if (credential === null) {
        return {
          name: 'model-route',
          ok: false,
          detail: '还没有可用的凭据',
          hint: '先填访问密钥或用平台账号登录，再打开模型路由。',
        }
      }
      await route.storeCredential(credential)
      const selection = await route.selectDefaultModel(this.settings.modelProvider, this.settings.model)
      return {
        name: 'model-route',
        ok: true,
        detail: `${detail}；默认模型 ${selection.provider}/${selection.model}`
          + `${selection.previous.length > 0 ? `（原为 ${selection.previous}）` : ''}`,
        hint: modelUrl,
      }
    } catch (error) {
      return {
        name: 'model-route',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        hint: error instanceof StarBridgeError ? error.hint : undefined,
      }
    }
  }

  /**
   * Forget the gateway credential (platform session and, optionally, the key).
   *
   * @returns the status after the change.
   */
  async forgetAccess(): Promise<StarBridgeAccessStatus> {
    this.assertLive()
    await this.access.clear()
    if (this.modelRoute !== undefined) await this.modelRoute.clearCredential().catch(() => undefined)
    const { accountName: _account, tokenExpiresAt: _expiry, ...rest } = this.settings
    await this.persist({ ...rest, authMode: 'unconfigured' })
    this.logger.info('starbridge: the stored gateway credential was removed')
    return this.accessStatus()
  }

  /**
   * Build the authorization URL for a new OIDC sign-in.
   *
   * @param redirectUri - loopback callback registered with the provider.
   * @returns the URL to open in the browser.
   */
  async beginLogin(redirectUri: string): Promise<string> {
    return this.auth.buildAuthorizeUrl(redirectUri)
  }

  /**
   * Complete an OIDC sign-in from the provider callback.
   *
   * @param code - authorization code.
   * @param state - CSRF state echoed by the provider.
   * @param redirectUri - the same callback used to start the flow.
   * @returns the authenticated status.
   */
  async completeLogin(code: string, state: string, redirectUri: string): Promise<StarBridgeAuthStatus> {
    return this.auth.completeLogin(code, state, redirectUri)
  }

  /** Forget the OIDC session (memory and the encrypted vault). */
  async logout(): Promise<void> {
    await this.auth.logout()
  }

  /**
   * Run one chat exchange and buffer the reply.
   *
   * @param input - messages, scenario, and cancellation.
   * @returns the full reply plus correlation ids.
   */
  async chat(input: StarBridgeChatInput): Promise<{ reply: string; conversationId?: string; traceId: string }> {
    this.assertLive()
    return this.gateway.completeChat(input)
  }

  /**
   * Run one chat exchange as a delta stream.
   *
   * @param input - messages, scenario, and cancellation.
   * @yields each delta and finally returns the correlation ids.
   */
  async *chatStream(input: StarBridgeChatInput): AsyncGenerator<StarBridgeChatDelta, { traceId: string; conversationId?: string }, void> {
    this.assertLive()
    return yield* this.gateway.streamChat(input)
  }

  /**
   * Search the company knowledge base.
   *
   * @param input - query, top-k, and cancellation.
   * @returns ranked hits and the correlation id.
   */
  async queryKnowledgeBase(input: StarBridgeKbQueryInput): Promise<StarBridgeKbResult> {
    this.assertLive()
    const { hits, traceId } = await this.gateway.queryKnowledgeBase(input)
    return { hits, traceId }
  }

  /**
   * Record feedback locally and, when configured, forward it to the gateway.
   *
   * Forwarding failures never throw: the user's judgement is already stored, and
   * the result says `forwarded: 'failed'` with the reason.
   *
   * @param input - the judgement to record.
   * @returns the local write outcome plus the forwarding outcome.
   */
  async recordFeedback(input: StarBridgeFeedbackInput): Promise<StarBridgeFeedbackResult> {
    this.assertLive()
    const record: StarBridgeFeedbackRecord = {
      messageId: input.messageId,
      verdict: input.verdict,
      sessionId: input.sessionId ?? 'unscoped',
      recordedAt: Date.now(),
      ...(input.note === undefined || input.note.length === 0 ? {} : { note: input.note }),
      ...(input.expectation === undefined || input.expectation.length === 0
        ? {}
        : { expectation: input.expectation }),
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    }

    const local = this.feedback.record(record)

    // Forwarding is a deployment choice: a site that keeps feedback on-prem
    // sets behavior.forwardFeedback false and gets a locally-recorded result.
    if (!this.config.behavior.forwardFeedback) return local

    try {
      const { traceId } = await this.gateway.submitFeedback(record, input.signal)
      return FeedbackStore.withForwarding(local, 'accepted', traceId)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.logger.warn(`starbridge: feedback stored locally but not forwarded (${detail})`)
      return FeedbackStore.withForwarding(local, 'failed', undefined, detail)
    }
  }

  /**
   * Recent feedback records, newest first.
   * @param limit - maximum rows.
   * @returns the requested window.
   */
  feedbackHistory(limit = 20): StarBridgeFeedbackRecord[] {
    return this.feedback.recent(limit)
  }

  /** Abort in-flight work and drop retained state. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.gateway.dispose()
    this.auth.dispose()
    this.feedback.clear()
  }

  /**
   * Persist settings, tolerating a deployment with no writable settings file.
   *
   * The store updates its in-memory value before writing, so a read-only
   * deployment keeps the change for this session even though it will not
   * survive a restart — the settings page says so.
   */
  private async persist(next: StarBridgeGatewaySettings): Promise<void> {
    this.access.setBaseUrl(next.baseUrl)
    try {
      await this.gatewayStore.save(next)
      this.storeAvailable = true
      this.savedOnce = true
    } catch (error) {
      this.storeAvailable = false
      this.logger.warn(
        `starbridge: the access configuration could not be saved to ${this.gatewayStore.path} `
        + `(${String(error)}); it applies to this session only.`,
      )
    }
  }

  /** Refuse work after teardown instead of failing obscurely mid-request. */
  private assertLive(): void {
    if (this.disposed) {
      throw new StarBridgeError('GATEWAY_UNREACHABLE', 'The StarBridge plugin was unloaded; its client is no longer usable.', {
        hint: 'Re-enable the @company/dsh-starbridge-client plugin for this profile and retry.',
      })
    }
  }
}

/**
 * Resolve where persisted tokens should live.
 *
 * Sign-in must survive a profile restart to be usable, so when a directory is
 * configured (or derivable from the DSH home) the refresh token is sealed to
 * disk; otherwise the session is deliberately memory-only and the settings
 * panel says so.
 *
 * @param config - resolved configuration.
 * @param dshHome - the DSH home directory, when known.
 * @returns the persistence choice.
 */
export function choosePersistence(config: ResolvedConfig, dshHome: string | null): PersistenceChoice {
  const configured = config.storage.directory.trim()
  const directory = configured.length > 0 ? configured : dshHome
  return directory === null || directory.length === 0
    ? { kind: 'memory' }
    : { kind: 'encrypted', directory }
}
