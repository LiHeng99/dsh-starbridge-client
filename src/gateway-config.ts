/**
 * The StarBridge access configuration a user fills in, and where it is kept.
 *
 * What this module exists to fix: before it, the gateway address and credential
 * were deployment facts. `gateway.gatewayUrl` lived in the plugin row, the
 * credential lived in an environment variable, and `identity.userId` had to be
 * patched into a profile file by hand. Every one of those is a per-person
 * decision — "which StarBridge am I on, and who am I there?" — so it belongs in
 * a settings page that writes a file, not in a composition the user does not own.
 *
 * Two secrets never enter this file:
 *
 * - the **access key** goes to the DSH credentials store (`ctx.credentials`),
 *   which is what the model route resolves through `apiKeyEnv`;
 * - the **platform token** goes to the same encrypted vault as the OIDC refresh
 *   token (`vault.ts`).
 *
 * What is left here is exactly the non-secret part, so the file can be read,
 * diffed, and backed up without leaking anything.
 *
 * @module @company/dsh-starbridge-client/gateway-config
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** How this user proved who they are to the gateway. */
export type StarBridgeAuthMode =
  /** Nothing configured yet. */
  | 'unconfigured'
  /** A machine/access key the user typed in (or a deployment injected). */
  | 'access-key'
  /** A platform account: signed in with username + password. */
  | 'account'
  /** Deployment-level OIDC sign-in (unchanged from before this feature). */
  | 'sso'

/** The non-secret half of the access configuration. */
export interface StarBridgeGatewaySettings {
  /** Gateway base URL (no trailing slash), e.g. `https://starbridge.company.com/v1`. */
  baseUrl: string
  /** Employee identifier reported to the gateway. */
  userId: string
  /** Organisation unit usage is booked against. */
  department: string
  /** Which credential this user is currently using. */
  authMode: StarBridgeAuthMode
  /**
   * The provider route DSH's model calls should use.
   *
   * It must name a route the composition actually declares (the shipped bundle
   * declares `starbridge`). The plugin updates that route's `baseURL` through
   * the settings service rather than registering a competing adapter, because
   * two adapters owning one route name is a hard registration conflict.
   */
  modelProvider: string
  /** Model (scenario key) the default selection should use. */
  model: string
  /** Whether new agents should default to the StarBridge route. */
  routeModelsThroughGateway: boolean
  /** Last successful platform sign-in, for display only. */
  accountName?: string
  /** Epoch millis at which the platform token stops being valid. */
  tokenExpiresAt?: number
}

/** Minimal logger surface, so this module never depends on Cordis. */
export interface GatewayConfigLogger {
  /** Informational line. */
  info(message: string): void
  /** Diagnostic line; never carries a credential. */
  warn(message: string): void
}

/**
 * Defaults used when nothing is stored.
 *
 * `modelProvider` defaults to the route the shipped bundle declares, so a
 * deployment that installs the bundle and does nothing else still has a working
 * "connect" button.
 *
 * @param fallbackBaseUrl - the composition's `gateway.gatewayUrl`, used so a
 * deployment that configured an address is not reset to the company default.
 * @param fallbackProvider - the composition's model route name.
 * @returns the default settings.
 */
export function defaultGatewaySettings(fallbackBaseUrl: string, fallbackProvider: string): StarBridgeGatewaySettings {
  return {
    baseUrl: normalizeGatewayBaseUrl(fallbackBaseUrl).baseUrl,
    userId: '',
    department: '',
    authMode: 'unconfigured',
    modelProvider: fallbackProvider.trim().length > 0 ? fallbackProvider.trim() : 'starbridge',
    model: 'general',
    routeModelsThroughGateway: false,
  }
}

/** Outcome of normalizing a user-entered gateway address. */
export interface NormalizedGatewayUrl {
  /** Canonical form to store and probe: the API root, without the gw segment. */
  readonly baseUrl: string
  /** Path prefix this deployment serves the machine face under (`''` or `/starbridge`). */
  readonly pathPrefix: string
  /** Base URL of the machine face, e.g. `https://host/starbridge/gw`. */
  readonly faceUrl: string
  /** Base URL of the OpenAI-compatible model face, e.g. `https://host/starbridge/gw/v1`. */
  readonly modelUrl: string
}

/**
 * Normalize whatever the user typed into the forms this client actually uses.
 *
 * People paste four different things, and all four are reasonable:
 *
 * | pasted | means |
 * |---|---|
 * | `https://host` | server root |
 * | `https://host/starbridge` | server root plus the router prefix |
 * | `https://host/starbridge/gw` | the machine face itself |
 * | `https://host/starbridge/gw/v1` | the model face (what the bundle declares) |
 *
 * All four collapse to one stored `baseUrl` plus a derived `pathPrefix`, so the
 * settings page can accept a pasted address without asking the user to know
 * which of the three faces this plugin happens to need.
 *
 * @param input - the raw address.
 * @returns the canonical forms; `baseUrl` is empty when the input is unusable.
 */
export function normalizeGatewayBaseUrl(input: string): NormalizedGatewayUrl {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    return { baseUrl: '', pathPrefix: '', faceUrl: '', modelUrl: '' }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { baseUrl: '', pathPrefix: '', faceUrl: '', modelUrl: '' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { baseUrl: '', pathPrefix: '', faceUrl: '', modelUrl: '' }
  }

  // Work on the path only; query and fragment are never meaningful here.
  let path = parsed.pathname.replace(/\/+$/, '')
  // Peel the known face suffixes, deepest first.
  for (const suffix of ['/gw/v1', '/gw/v1/chat/completions', '/v1/chat/completions']) {
    if (path.toLowerCase().endsWith(suffix)) {
      path = path.slice(0, path.length - suffix.length)
      break
    }
  }
  if (path.toLowerCase().endsWith('/gw')) {
    path = path.slice(0, path.length - 3)
  }
  // A BARE version segment belongs to the server's own API root (`/v1` on an
  // OpenAI-compatible deployment), not to the StarBridge model face, so it is
  // kept. A version segment after a router prefix is peeled like `/gw` is,
  // because `.../starbridge/gw/v1` names the same faces as `.../starbridge`.
  if (path.toLowerCase().endsWith('/v1') && path.length > 3) {
    path = path.slice(0, path.length - 3)
  }

  const pathPrefix = path.replace(/\/+$/, '')
  const serverRoot = `${parsed.protocol}//${parsed.host}`
  const baseUrl = `${serverRoot}${pathPrefix}`
  const faceUrl = `${baseUrl}/gw`
  return { baseUrl, pathPrefix, faceUrl, modelUrl: `${faceUrl}/v1` }
}

/**
 * Resolve the three URLs from a stored base URL.
 *
 * @param baseUrl - stored gateway base URL.
 * @returns the canonical forms (empty strings when `baseUrl` is unusable).
 */
export function gatewayUrls(baseUrl: string): NormalizedGatewayUrl {
  return normalizeGatewayBaseUrl(baseUrl)
}

/**
 * Merge a stored (possibly partial) record over the defaults.
 *
 * Unknown keys are dropped rather than carried: this file is user-writable, and
 * a stray key surviving into the service would be indistinguishable from a
 * supported one later.
 *
 * @param raw - parsed file content.
 * @param defaults - defaults to merge onto.
 * @returns settings with every field present and typed.
 */
export function coerceGatewaySettings(raw: unknown, defaults: StarBridgeGatewaySettings): StarBridgeGatewaySettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...defaults }
  const record = raw as Record<string, unknown>

  const authModes: readonly StarBridgeAuthMode[] = ['unconfigured', 'access-key', 'account', 'sso']
  const authMode = typeof record.authMode === 'string' && (authModes as readonly string[]).includes(record.authMode)
    ? (record.authMode as StarBridgeAuthMode)
    : defaults.authMode

  const normalized = normalizeGatewayBaseUrl(typeof record.baseUrl === 'string' ? record.baseUrl : '')

  return {
    baseUrl: normalized.baseUrl.length > 0 ? normalized.baseUrl : defaults.baseUrl,
    userId: typeof record.userId === 'string' ? record.userId.trim() : defaults.userId,
    department: typeof record.department === 'string' ? record.department.trim() : defaults.department,
    authMode,
    modelProvider: typeof record.modelProvider === 'string' && record.modelProvider.trim().length > 0
      ? record.modelProvider.trim()
      : defaults.modelProvider,
    model: typeof record.model === 'string' && record.model.trim().length > 0 ? record.model.trim() : defaults.model,
    routeModelsThroughGateway: typeof record.routeModelsThroughGateway === 'boolean'
      ? record.routeModelsThroughGateway
      : defaults.routeModelsThroughGateway,
    ...(typeof record.accountName === 'string' && record.accountName.length > 0 ? { accountName: record.accountName } : {}),
    ...(typeof record.tokenExpiresAt === 'number' && Number.isFinite(record.tokenExpiresAt)
      ? { tokenExpiresAt: record.tokenExpiresAt }
      : {}),
  }
}

/** File name this store owns inside the DSH home directory. */
export const GATEWAY_SETTINGS_FILENAME = 'starbridge-gateway.json'

/**
 * Durable store for {@link StarBridgeGatewaySettings}.
 *
 * Deliberately synchronous to *read*: the effective settings are needed while
 * the plugin is being applied, and DSH's loader does not await the plugin's
 * setup. The store therefore starts from the deployment defaults and lets the
 * first disk read — or a test — replace them, while every reader goes through
 * {@link effective} so it always sees the latest values.
 *
 * The write path is atomic (temp file + rename) for the same reason the token
 * vault is: a half-written settings file would be read back as "unconfigured"
 * and silently drop the user's address and identity.
 */
export class GatewayConfigStore {
  private readonly filePath: string
  private readonly logger: GatewayConfigLogger
  private readonly defaults: StarBridgeGatewaySettings
  private current: StarBridgeGatewaySettings
  private stored = false

  /**
   * @param directory - DSH home directory that holds the file.
   * @param defaults - deployment defaults used until (and for fields absent from) the file.
   * @param logger - diagnostic sink.
   */
  constructor(directory: string, defaults: StarBridgeGatewaySettings, logger: GatewayConfigLogger) {
    this.filePath = join(directory, GATEWAY_SETTINGS_FILENAME)
    this.defaults = defaults
    this.current = { ...defaults }
    this.logger = logger
  }

  /** Absolute path of the file this store owns (surfaced in the settings page). */
  get path(): string {
    return this.filePath
  }

  /** The effective settings; always current, never stale. */
  effective(): StarBridgeGatewaySettings {
    return { ...this.current }
  }

  /** Whether the last read found a stored file. */
  get hasStoredFile(): boolean {
    return this.stored
  }

  /**
   * Read the stored record from disk.
   *
   * Never throws: an unreadable or malformed file is reported and the
   * deployment defaults stay in force, which is exactly the pre-feature state.
   *
   * @returns whether a usable record was found.
   */
  async load(): Promise<boolean> {
    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`starbridge: could not read ${this.filePath} (${String(error)}); using deployment defaults.`)
      }
      this.stored = false
      return false
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      this.logger.warn(
        `starbridge: ${this.filePath} is not valid JSON (${String(error)}); using deployment defaults. `
        + 'Fix or delete the file from the StarBridge settings page.',
      )
      this.stored = false
      return false
    }

    this.replace(parsed)
    return true
  }

  /**
   * Adopt a record without touching the disk.
   *
   * Used by tests and by callers that already hold parsed content.
   *
   * @param raw - parsed record (partial records are merged over the defaults).
   */
  prime(raw: unknown): void {
    this.replace(raw)
  }

  /** Merge a parsed record over the defaults. */
  private replace(raw: unknown): void {
    this.current = coerceGatewaySettings(raw, this.defaults)
    this.stored = true
  }

  /**
   * Persist settings atomically.
   *
   * The in-memory value is updated FIRST, so a failed disk write still leaves a
   * usable session that behaves as the user asked — it just will not survive a
   * restart, and the settings page reports that.
   *
   * @param settings - the complete record to store.
   * @throws {Error} when the directory cannot be created or the write fails.
   */
  async save(settings: StarBridgeGatewaySettings): Promise<void> {
    const payload = `${JSON.stringify(settings, null, 2)}\n`
    this.current = { ...settings }
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.filePath)
    this.stored = true
  }
}
