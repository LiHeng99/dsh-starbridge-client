/**
 * StarBridge configuration: the Config Schema every deployment parameter lives
 * in, plus the validation that makes a bad deployment fail loudly at load time
 * instead of mysteriously at the first request.
 *
 * Nothing in this plugin hardcodes an address, a credential, or an identity:
 * everything deployment-specific is a schema field below, and every field has a
 * default that is safe to ship (the gateway default points at the company host,
 * not at a developer machine).
 *
 * @module @company/dsh-starbridge-client/config
 */

import Schema from '@deepseek-ai/schemastery'

/** Gateway connection and retry policy. */
export interface StarBridgeGatewayConfig {
  /** Base URL of the company AI gateway, including its API version prefix. */
  gatewayUrl: string
  /**
   * Static gateway credential. Prefer the environment: set
   * `STARBRIDGE_GATEWAY_API_KEY` and leave this empty so the key never lands in
   * a profile's `cordis.patch.yml`.
   */
  apiKey: string
  /** Per-attempt request timeout in milliseconds. */
  timeoutMs: number
  /** Retries after the first attempt, for transport errors and 5xx only. */
  maxRetries: number
  /** Base delay of the exponential retry backoff, in milliseconds. */
  retryBackoffMs: number
  /**
   * Provider route name DSH's model calls should use.
   *
   * The settings page can point this route at a different address at runtime and
   * switch the default model to it, which is what "route every model call
   * through StarBridge" means in practice. It must name a route the composition
   * declares (the shipped bundle declares `starbridge`) — registering a
   * competing adapter for an existing route is a hard conflict, so the plugin
   * updates the declared route instead of adding one.
   */
  modelProvider: string
}

/** OIDC Authorization Code + PKCE configuration. */
export interface StarBridgeOidcConfig {
  /** Issuer base URL, e.g. `https://sso.company.com/realms/staff`. */
  issuerUrl: string
  /** Public client id registered with the identity provider. */
  clientId: string
  /**
   * Client secret. Only for confidential clients; a PKCE public client leaves
   * this empty. Prefer `STARBRIDGE_OIDC_CLIENT_SECRET` over writing it here.
   */
  clientSecret: string
  /** Requested scopes. */
  scopes: string[]
  /** Force the provider's login screen instead of reusing its session. */
  prompt: '' | 'login' | 'consent' | 'select_account'
  /** Refresh this many milliseconds before the access token actually expires. */
  refreshSkewMs: number
}

/**
 * Employee identity stamped onto every gateway request. Fields fall back to the
 * matching `STARBRIDGE_USER_ID` / `STARBRIDGE_DEPARTMENT` environment variable
 * when left empty, which is how a shared workstation profile stays anonymous in
 * the config file.
 */
export interface StarBridgeIdentityConfig {
  /** Stable employee identifier reported to the gateway. */
  userId: string
  /** Organisation unit the usage is booked against. */
  department: string
  /** Default scenario key; each tool may override it per call. */
  scenario: string
}

/** Behaviour knobs for chat, feedback, and knowledge-base calls. */
export interface StarBridgeBehaviorConfig {
  /** Ask the gateway for a knowledge-base-augmented answer by default. */
  useKnowledgeBase: boolean
  /** Scenario key used by `starbridge_kb_query`. */
  knowledgeBaseScenario: string
  /** Maximum KB hits returned to the model. */
  knowledgeBaseTopK: number
  /** Forward feedback to the gateway in addition to the local session log. */
  forwardFeedback: boolean
}

/** Local persistence knobs. */
export interface StarBridgeStorageConfig {
  /** Session-event name feedback is appended to. */
  feedbackEventName: string
  /** How many feedback records to retain in memory for the settings panel. */
  feedbackMemoryLimit: number
  /**
   * Directory holding the encrypted session vault. Empty resolves to the DSH
   * home; points the vault at a per-user location on a shared workstation.
   */
  directory: string
}

/** The complete plugin configuration. */
export interface StarBridgeConfig {
  /** Gateway connection and retry policy. */
  gateway: StarBridgeGatewayConfig
  /** OIDC Authorization Code + PKCE configuration. */
  oidc: StarBridgeOidcConfig
  /** Employee identity stamped onto every request. */
  identity: StarBridgeIdentityConfig
  /** Behaviour knobs for the tools. */
  behavior: StarBridgeBehaviorConfig
  /** Local persistence knobs. */
  storage: StarBridgeStorageConfig
}

/**
 * The Config Schema the DSH loader validates this plugin's `config:` row
 * against. Every leaf is defaulted, so a bare plugin row is a working
 * deployment: the loader fills each section from its leaves, and a deployment
 * only has to state the values it changes. Every secret is additionally
 * overridable by environment variable so it never has to be written down.
 */
export const Config: Schema<StarBridgeConfig> = Schema.object({
  gateway: Schema.object({
    gatewayUrl: Schema.string().default('https://starbridge-gateway.company.com/v1'),
    apiKey: Schema.string().default(''),
    timeoutMs: Schema.number().default(30_000),
    maxRetries: Schema.number().default(2),
    retryBackoffMs: Schema.number().default(500),
    modelProvider: Schema.string().default('starbridge'),
  }),

  oidc: Schema.object({
    issuerUrl: Schema.string().default(''),
    clientId: Schema.string().default(''),
    clientSecret: Schema.string().default(''),
    scopes: Schema.array(Schema.string()).default(['openid', 'profile', 'email']),
    prompt: Schema.union(['', 'login', 'consent', 'select_account']).default(''),
    refreshSkewMs: Schema.number().default(60_000),
  }),

  identity: Schema.object({
    userId: Schema.string().default(''),
    department: Schema.string().default(''),
    scenario: Schema.string().default('chat'),
  }),

  behavior: Schema.object({
    useKnowledgeBase: Schema.boolean().default(false),
    knowledgeBaseScenario: Schema.string().default('kb'),
    knowledgeBaseTopK: Schema.number().default(5),
    forwardFeedback: Schema.boolean().default(true),
  }),

  storage: Schema.object({
    feedbackEventName: Schema.string().default('starbridge/feedback'),
    feedbackMemoryLimit: Schema.number().default(200),
    directory: Schema.string().default(''),
  }),
})

/** A configuration that has passed {@link validateConfig}. */
export interface ResolvedConfig {
  readonly gateway: StarBridgeGatewayConfig & { readonly gatewayUrl: string }
  readonly oidc: StarBridgeOidcConfig
  readonly identity: StarBridgeIdentityConfig
  readonly behavior: StarBridgeBehaviorConfig
  readonly storage: StarBridgeStorageConfig
}

/**
 * Read a secret from the environment, falling back to the configured value.
 *
 * Environment wins so an operator can inject a credential into the harness
 * process without persisting it in the profile tree; the config file stays the
 * declarative default.
 *
 * @param name - environment variable name.
 * @param fallback - configured value used when the variable is unset/empty.
 * @returns the effective value.
 */
export function envOr(name: string, fallback: string): string {
  const value = process.env[name]
  return value !== undefined && value.length > 0 ? value : fallback
}

/**
 * Reject a configuration the plugin cannot honour, with the exact fix.
 *
 * This runs during plugin load: a deployment that mistypes the gateway URL
 * learns it while reading the startup log, not from a user reporting that chat
 * is broken.
 *
 * @param config - the schema-validated configuration.
 * @returns the configuration with environment overrides applied.
 * @throws {Error} naming the offending field and the accepted form.
 */
export function validateConfig(config: StarBridgeConfig): ResolvedConfig {
  const gatewayUrl = envOr('STARBRIDGE_GATEWAY_URL', config.gateway.gatewayUrl).trim()
  const apiKey = envOr('STARBRIDGE_GATEWAY_API_KEY', config.gateway.apiKey)

  if (gatewayUrl.length === 0) {
    throw new Error(
      'starbridge: gateway.gatewayUrl is empty. Set it in the plugin config, or set '
      + 'STARBRIDGE_GATEWAY_URL in the environment, e.g. "https://starbridge-gateway.company.com/v1".',
    )
  }

  let parsed: URL
  try {
    parsed = new URL(gatewayUrl)
  } catch {
    throw new Error(
      `starbridge: gateway.gatewayUrl is not an absolute URL (got "${gatewayUrl}"). `
      + 'Use an absolute http(s) URL, e.g. "https://starbridge-gateway.company.com/v1".',
    )
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(
      `starbridge: gateway.gatewayUrl must use http or https (got "${parsed.protocol}"). `
      + 'Company deployments should use https; plain http is accepted only for a local gateway.',
    )
  }
  // Normalise so later URL joins never double the separator.
  const normalised = parsed.toString().replace(/\/+$/, '')

  if (!Number.isFinite(config.gateway.timeoutMs) || config.gateway.timeoutMs <= 0) {
    throw new Error(
      `starbridge: gateway.timeoutMs must be a positive number of milliseconds (got ${String(config.gateway.timeoutMs)}).`,
    )
  }
  if (!Number.isInteger(config.gateway.maxRetries) || config.gateway.maxRetries < 0) {
    throw new Error(
      `starbridge: gateway.maxRetries must be a non-negative integer (got ${String(config.gateway.maxRetries)}).`,
    )
  }
  if (!Number.isFinite(config.gateway.retryBackoffMs) || config.gateway.retryBackoffMs < 0) {
    throw new Error(
      `starbridge: gateway.retryBackoffMs must be a non-negative number of milliseconds (got ${String(config.gateway.retryBackoffMs)}).`,
    )
  }
  const modelProvider = config.gateway.modelProvider.trim()
  if (modelProvider.length === 0) {
    throw new Error(
      'starbridge: gateway.modelProvider is empty. Name the llm provider route that should carry '
      + 'StarBridge model calls (the shipped bundle declares "starbridge").',
    )
  }

  const issuerUrl = envOr('STARBRIDGE_OIDC_ISSUER_URL', config.oidc.issuerUrl).trim()
  const clientId = envOr('STARBRIDGE_OIDC_CLIENT_ID', config.oidc.clientId).trim()
  const clientSecret = envOr('STARBRIDGE_OIDC_CLIENT_SECRET', config.oidc.clientSecret)

  // OIDC is optional: a deployment may front the gateway with a machine
  // credential and never sign users in. Half-configured OIDC is the error.
  if (issuerUrl.length > 0 || clientId.length > 0) {
    if (issuerUrl.length === 0) {
      throw new Error(
        'starbridge: oidc.clientId is set but oidc.issuerUrl is empty. Set the issuer base URL '
        + '(e.g. "https://sso.company.com/realms/staff") or clear oidc.clientId to run without SSO.',
      )
    }
    if (clientId.length === 0) {
      throw new Error(
        'starbridge: oidc.issuerUrl is set but oidc.clientId is empty. Register a public client with '
        + 'Authorization Code + PKCE at that issuer and put its client id here.',
      )
    }
    let issuer: URL
    try {
      issuer = new URL(issuerUrl)
    } catch {
      throw new Error(
        `starbridge: oidc.issuerUrl is not an absolute URL (got "${issuerUrl}").`,
      )
    }
    if (issuer.protocol !== 'https:' && issuer.hostname !== 'localhost' && issuer.hostname !== '127.0.0.1') {
      throw new Error(
        `starbridge: oidc.issuerUrl must use https outside localhost (got "${issuer.protocol}//${issuer.host}").`,
      )
    }
    if (config.oidc.scopes.length === 0) {
      throw new Error('starbridge: oidc.scopes must not be empty; OIDC requires at least "openid".')
    }
    if (!config.oidc.scopes.includes('openid')) {
      throw new Error(
        `starbridge: oidc.scopes must include "openid" (got ${JSON.stringify(config.oidc.scopes)}).`,
      )
    }
  }

  if (!Number.isInteger(config.behavior.knowledgeBaseTopK) || config.behavior.knowledgeBaseTopK < 1) {
    throw new Error(
      `starbridge: behavior.knowledgeBaseTopK must be a positive integer (got ${String(config.behavior.knowledgeBaseTopK)}).`,
    )
  }
  if (!Number.isInteger(config.storage.feedbackMemoryLimit) || config.storage.feedbackMemoryLimit < 1) {
    throw new Error(
      `starbridge: storage.feedbackMemoryLimit must be a positive integer (got ${String(config.storage.feedbackMemoryLimit)}).`,
    )
  }

  return {
    gateway: {
      ...config.gateway,
      gatewayUrl: normalised,
      apiKey,
      modelProvider,
    },
    oidc: {
      ...config.oidc,
      issuerUrl: issuerUrl.length > 0 ? issuerUrl.replace(/\/+$/, '') : '',
      clientId,
      clientSecret,
    },
    identity: {
      ...config.identity,
      userId: envOr('STARBRIDGE_USER_ID', config.identity.userId).trim(),
      department: envOr('STARBRIDGE_DEPARTMENT', config.identity.department).trim(),
      scenario: config.identity.scenario.trim().length > 0 ? config.identity.scenario.trim() : 'chat',
    },
    behavior: config.behavior,
    storage: config.storage,
  }
}

/**
 * Whether an operator configured OIDC for this deployment.
 * @param config - resolved configuration.
 * @returns true when both issuer and client id are present.
 */
export function isOidcConfigured(config: ResolvedConfig): boolean {
  return config.oidc.issuerUrl.length > 0 && config.oidc.clientId.length > 0
}

/**
 * Resolve the DSH home directory this profile belongs to.
 *
 * `DSH_HOME` is the launcher's own contract and wins when present; the fallback
 * mirrors the launcher's default so a plugin loaded by a bare Cordis host still
 * finds a per-user location. The result is only used to place the encrypted
 * session vault, never to modify anything the launcher owns.
 *
 * @returns the absolute home directory, or null when it cannot be determined.
 */
export function resolveDshHome(): string | null {
  const explicit = process.env.DSH_HOME
  if (explicit !== undefined && explicit.length > 0) return explicit.replace(/[/\\]+$/, '')

  const home = process.env.USERPROFILE ?? process.env.HOME
  if (home === undefined || home.length === 0) return null
  const base = home.replace(/[/\\]+$/, '')
  return process.platform === 'win32' ? `${base}\\.dsh` : `${base}/.dsh`
}
