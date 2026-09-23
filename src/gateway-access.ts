/**
 * The credential this user presents to the StarBridge gateway.
 *
 * Two kinds, one seam. Everything downstream (tool calls, the browser routes,
 * the model route's `apiKeyEnv`) reads the credential through
 * {@link GatewayAccess.getAccessToken} and never branches on which kind it got —
 * which is what keeps "I typed an access key" and "I signed in with my account"
 * from becoming two parallel code paths through the whole plugin.
 *
 * Where each secret lives:
 *
 * - the **access key** is not kept here at all. It is written to the DSH
 *   credentials store, because that is what the model route resolves through
 *   `apiKeyEnv`; holding a second copy would inevitably drift from it.
 * - the **platform token** is sealed to
 *   `<DSH home>/starbridge-gateway-session.enc` under its own key file.
 *
 * Account sign-in also has to survive the token's expiry (the platform's JWT
 * lives for days, not hours). Rather than dropping the user back to a login
 * screen whenever it lapses, the credentials the user typed are sealed in the
 * same vault and used to renew before expiry — with an explicit "forget" action
 * that deletes them, for anyone who would rather sign in each time.
 *
 * @module dsh-starbridge-client/gateway-access
 */

import { join } from 'node:path'

import { SealedJsonFile, type AuthLogger } from './auth.ts'
import { StarBridgeError } from './errors.ts'
import { gatewayUrls } from './gateway-config.ts'
import { newTraceId } from './trace.ts'

/** Which credential is currently loaded. */
export type StarBridgeAccessKind = 'none' | 'access-key' | 'platform-token'

/** The platform-token record as sealed on disk. */
export interface PlatformSessionRecord {
  /** The token itself, presented as `Authorization: Bearer`. */
  readonly accessToken: string
  /** Epoch millis at which the platform stops accepting it. */
  readonly expiresAt: number
  /** Username, for display. */
  readonly username: string
  /** Password, retained only so the token can be renewed before it expires. */
  readonly password?: string
}

/** What a login attempt needs in order to be repeated automatically. */
export interface PlatformLoginRequest {
  /** Gateway base URL (server root plus router prefix). */
  readonly baseUrl: string
  /** Platform account name. */
  readonly username: string
  /** Platform account password (used once, then sealed for renewal). */
  readonly password: string
}

/** Successful platform login, as the host service consumes it. */
export interface PlatformLoginOutcome {
  /** The token to present. */
  readonly accessToken: string
  /** Seconds until it stops being valid (0 when the server did not say). */
  readonly expiresIn: number
  /** Resolved account name (the server echoes it). */
  readonly username: string
  /** The user's display name. */
  readonly nickName?: string
}

/** Dependency the access layer needs to sign in to the platform. */
export interface PlatformLoginFn {
  /**
   * Exchange username + password for a platform token.
   * @param request - address and credentials.
   * @returns the issued token.
   * @throws {StarBridgeError} when the platform rejects the credentials.
   */
  (request: PlatformLoginRequest): Promise<PlatformLoginOutcome>
}

/**
 * The credential reference the model route resolves through its `apiKeyEnv`.
 *
 * One name, stated once: the plugin writes the credential under it here, and the
 * composition's provider row points at it. If the two ever disagreed, "route all
 * model calls through the gateway" would fail with `MISSING_CREDENTIAL` while
 * every plugin-facing call kept working — the exact failure that is hardest to
 * attribute from the error alone.
 */
export const MODEL_ROUTE_CREDENTIAL_REF = 'STARBRIDGE_GATEWAY_API_KEY'

/** Options for {@link GatewayAccess}. */
export interface GatewayAccessOptions {
  /** Directory holding the sealed session (the DSH home). */
  readonly directory: string
  /** Logger for diagnostics that never carry a credential. */
  readonly logger: AuthLogger
  /** Read the stored access key (from the credentials store). */
  readonly readAccessKey: () => Promise<string>
  /** How the platform login is performed. */
  readonly login: PlatformLoginFn
  /** Renew this many milliseconds before the token actually expires. */
  readonly renewSkewMs: number
}

/** Result of {@link GatewayAccess.clear}. */
export interface ClearAccessOutcome {
  /** Whether a platform credential was deleted. */
  readonly clearedPlatform: boolean
  /** Whether an access key was deleted. */
  readonly clearedAccessKey: boolean
}

/**
 * Owns the credential the gateway sees, whichever kind it is.
 *
 * One instance per plugin activation. It holds the platform token in memory so
 * the hot path never touches the disk, and renews it through a single in-flight
 * promise so a burst of parallel model calls cannot stampede the login endpoint.
 */
export class GatewayAccess {
  private readonly options: GatewayAccessOptions
  private readonly vault: SealedJsonFile
  private session: PlatformSessionRecord | null = null
  private loadedFromDisk = false
  private renewing: Promise<string> | null = null
  private lastError: string | null = null
  private lastAccessKeyPresent = false
  /**
   * An access key the user typed in this process.
   *
   * The environment's `gateway.apiKey` is read live, but when the key exists
   * only because the user pasted it, nothing outside this object knows it — and
   * the model route has to be able to ask for it.
   */
  private manualAccessKey = ''
  /**
   * Base URL the last login or renewal targeted.
   *
   * Set by the service whenever the effective address changes, so a renewal
   * always targets the server the user is actually configured against rather
   * than the address that happened to be stored when the token was issued.
   */
  private lastBaseUrl = ''

  /**
   * @param options - directory, logger, login function, and key lookup.
   */
  constructor(options: GatewayAccessOptions) {
    this.options = options
    // Its own key file, deliberately not shared with the OIDC vault: revoking
    // one session must never invalidate the other.
    this.vault = new SealedJsonFile(
      join(options.directory, 'starbridge-gateway-session.enc'),
      join(options.directory, 'starbridge-gateway-session.key'),
      options.logger,
    )
  }

  /**
   * Point renewals at the currently configured address.
   * @param baseUrl - effective gateway base URL.
   */
  setBaseUrl(baseUrl: string): void {
    this.lastBaseUrl = baseUrl
  }

  /** Which credential is currently loaded. */
  get kind(): StarBridgeAccessKind {
    if (this.session !== null) return 'platform-token'
    return 'none'
  }

  /** The signed-in account, when a platform session is loaded. */
  get accountName(): string | null {
    return this.session?.username ?? null
  }

  /** When the loaded platform token stops being valid, if known. */
  get expiresAt(): number | null {
    return this.session?.expiresAt ?? null
  }

  /** Last authentication failure, for the settings panel. */
  get error(): string | null {
    return this.lastError
  }

  /**
   * The credential a model request must present, or null when none is available.
   *
   * The model route cannot call {@link getAccessToken} the way the tools do: a
   * standard OpenAI client resolves its credential once, before the request, so
   * the value has to be a plain string. Renewal therefore happens a little
   * earlier than strictly necessary — a renewal failure still leaves the
   * previously issued token usable until it truly expires.
   *
   * @returns the header value to store, or null when nothing is configured.
   */
  async credentialForModelRoute(): Promise<string | null> {
    if (await this.hasPlatformSession()) {
      const token = await this.getAccessToken('model-route').catch((error: unknown) => {
        this.options.logger.warn(`starbridge: could not refresh the token for the model route (${String(error)}).`)
        return this.session?.accessToken ?? ''
      })
      return token.length > 0 ? token : null
    }

    const key = await this.probeAccessKey()
    if (key.length > 0) return key

    // The platform session may exist but be expired with no stored password.
    return this.session !== null && this.session.accessToken.length > 0 ? this.session.accessToken : null
  }

  /**
   * Load the sealed platform session from disk once.
   *
   * Called on the first credential lookup rather than in the constructor, so a
   * deployment that never signs in never touches the vault.
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loadedFromDisk) return
    this.loadedFromDisk = true
    try {
      const record = await this.vault.load<PlatformSessionRecord>()
      if (record === null || typeof record.accessToken !== 'string' || record.accessToken.length === 0) return
      this.session = {
        accessToken: record.accessToken,
        expiresAt: typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt) ? record.expiresAt : 0,
        username: typeof record.username === 'string' ? record.username : '',
        ...(typeof record.password === 'string' && record.password.length > 0 ? { password: record.password } : {}),
      }
    } catch (error) {
      this.options.logger.warn(`starbridge: could not read the stored platform session (${String(error)}).`)
    }
  }

  /**
   * Whether a usable platform token is loaded (or can be renewed).
   *
   * @returns true when a token is present and not yet past its expiry.
   */
  async hasPlatformSession(): Promise<boolean> {
    await this.ensureLoaded()
    if (this.session === null) return false
    return this.session.expiresAt === 0 || this.session.expiresAt > Date.now()
  }

  /**
   * Return a bearer token, renewing or signing in as needed.
   *
   * @param traceId - correlation id for a renewal attempt.
   * @returns a token valid for at least the configured skew; an empty string
   * means "this request carries no bearer token", which is the access-key case.
   * @throws {StarBridgeError} `AUTH_REQUIRED` when nothing usable is configured.
   */
  async getAccessToken(traceId: string = newTraceId('auth')): Promise<string> {
    await this.ensureLoaded()
    const session = this.session
    if (session === null) return ''

    if (session.expiresAt === 0 || session.expiresAt - this.options.renewSkewMs > Date.now()) {
      return session.accessToken
    }
    if (session.password === undefined || session.username.length === 0) {
      // The user chose not to keep credentials around; make the remedy explicit
      // instead of failing a model call with an opaque 401 from the gateway.
      throw this.fail(
        'The StarBridge platform token has expired.',
        'Open DSH Settings → 星桥 StarBridge and sign in again (or store an access key).',
      )
    }
    return this.renew(traceId)
  }

  /**
   * Renew the platform token, sharing one in-flight attempt between callers.
   *
   * @param traceId - correlation id for the renewal.
   * @returns the fresh token.
   * @throws {StarBridgeError} `AUTH_FAILED` when the stored credentials no longer work.
   */
  private renew(traceId: string): Promise<string> {
    if (this.renewing !== null) return this.renewing
    const session = this.session
    if (session === null || session.password === undefined) {
      return Promise.reject(this.fail('No StarBridge platform session is active.', 'Sign in from DSH Settings → 星桥 StarBridge.'))
    }

    const run = (async (): Promise<string> => {
      try {
        const outcome = await this.options.login({
          baseUrl: this.lastBaseUrl,
          username: session.username,
          password: session.password as string,
        })
        await this.install(outcome, session.password as string)
        this.options.logger.info(`starbridge: renewed the platform token for ${outcome.username}${traceId.length > 0 ? ` (trace ${traceId})` : ''}`)
        return outcome.accessToken
      } catch (error) {
        // A stored credential that no longer works must not wedge every later
        // call: drop it and report AUTH_REQUIRED so the UI offers sign-in again.
        await this.clearPlatform().catch(() => undefined)
        throw error instanceof StarBridgeError
          ? error
          : this.fail('The StarBridge platform token could not be renewed.', 'Sign in again from DSH Settings → 星桥 StarBridge.')
      }
    })().finally(() => {
      this.renewing = null
    })

    this.renewing = run
    return run
  }

  /**
   * Sign in with a platform account and remember it.
   *
   * @param request - address and credentials.
   * @param persistPassword - seal the password for automatic renewal.
   * @returns the issued token.
   * @throws {StarBridgeError} `AUTH_FAILED` when the platform rejects the credentials.
   */
  async signInPlatform(request: PlatformLoginRequest, persistPassword: boolean): Promise<PlatformLoginOutcome> {
    this.lastBaseUrl = request.baseUrl
    let outcome: PlatformLoginOutcome
    try {
      outcome = await this.options.login(request)
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
    await this.install(outcome, persistPassword ? request.password : undefined)
    this.lastError = null
    return outcome
  }

  /**
   * Store a manually entered access key.
   *
   * The password-style secrecy rule applies here too: the value is written to
   * the credentials store by the caller and never logged by this layer.
   *
   * @param key - the access key (already validated as non-empty).
   */
  async useAccessKey(key: string): Promise<void> {
    await this.ensureLoaded()
    // Switching to a key must not leave a platform token behind: two live
    // credentials would make "who am I on this request" depend on load order.
    await this.clearPlatform().catch(() => undefined)
    this.manualAccessKey = key.trim()
    this.lastError = null
    this.lastAccessKeyPresent = this.manualAccessKey.length > 0
  }

  /** Whether an access key was recorded through {@link useAccessKey}. */
  get canRenew(): boolean {
    return this.session?.password !== undefined
  }

  /** Whether this instance believes an access key is available. */
  get accessKeyPresent(): boolean {
    return this.lastAccessKeyPresent
  }

  /**
   * Ask the credentials store whether an access key is present, and remember it.
   *
   * Used at startup, when only the store (or the environment) knows. A key typed
   * in during this process wins, because the user's most recent instruction is
   * the one that should be in force.
   *
   * @returns the effective key (empty string when none is configured).
   */
  async probeAccessKey(): Promise<string> {
    if (this.manualAccessKey.length > 0) return this.manualAccessKey
    const key = (await this.options.readAccessKey().catch(() => '')).trim()
    this.lastAccessKeyPresent = key.length > 0
    return key
  }

  /** Install a fresh session in memory and on disk. */
  private async install(outcome: PlatformLoginOutcome, password: string | undefined): Promise<void> {
    const expiresAt = outcome.expiresIn > 0 ? Date.now() + outcome.expiresIn * 1000 : 0
    const record: PlatformSessionRecord = {
      accessToken: outcome.accessToken,
      expiresAt,
      username: outcome.username,
      ...(password === undefined ? {} : { password }),
    }
    this.session = record
    this.loadedFromDisk = true
    await this.vault.save(record).catch((error: unknown) => {
      this.options.logger.warn(
        `starbridge: signed in, but the platform session could not be persisted (${String(error)}); `
        + 'it will not survive a DSH restart.',
      )
    })
  }

  /** Forget the platform session (memory and vault). */
  async clearPlatform(): Promise<boolean> {
    const had = this.session !== null
    this.session = null
    this.loadedFromDisk = true
    await this.vault.clear().catch(() => undefined)
    return had
  }

  /**
   * Forget every credential this layer owns.
   *
   * @returns which kinds were actually removed.
   */
  async clear(): Promise<ClearAccessOutcome> {
    const clearedPlatform = await this.clearPlatform()
    const clearedAccessKey = this.lastAccessKeyPresent || this.manualAccessKey.length > 0
    this.lastAccessKeyPresent = false
    this.manualAccessKey = ''
    this.lastError = null
    return { clearedPlatform, clearedAccessKey }
  }

  /** Record and return an authentication failure. */
  private fail(message: string, hint: string): StarBridgeError {
    this.lastError = message
    return new StarBridgeError('AUTH_REQUIRED', message, { hint })
  }
}

/**
 * Probe one StarBridge address for the machine face's health endpoint.
 *
 * Shared by the settings page's "test connectivity" button and the login flow,
 * so both report reachability the same way.
 *
 * @param baseUrl - gateway base URL (as stored).
 * @param timeoutMs - per-attempt budget.
 * @param signal - caller cancellation.
 * @returns reachability, latency, and the raw health body when it parsed.
 */
export async function probeGatewayFace(
  baseUrl: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ reachable: boolean; status?: number; latencyMs: number; error?: string; hint?: string; authReady?: boolean }> {
  const urls = gatewayUrls(baseUrl)
  if (urls.faceUrl.length === 0) {
    return {
      reachable: false,
      latencyMs: 0,
      error: `"${baseUrl}" is not an absolute http(s) URL.`,
      hint: 'Use an address like "https://starbridge.example.com/starbridge/gw".',
    }
  }

  const startedAt = Date.now()
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) return { reachable: false, latencyMs: 0, error: 'The probe was cancelled.' }
    signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(new Error('probe timed out')), timeoutMs)

  try {
    const response = await fetch(`${urls.faceUrl}/health`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    const latencyMs = Date.now() - startedAt
    if (!response.ok) {
      return {
        reachable: true,
        status: response.status,
        latencyMs,
        error: `The host answered HTTP ${response.status} on /health.`,
        hint: 'Confirm the address points at the StarBridge server (its router prefix included).',
      }
    }
    const body = await response.json().catch(() => null) as { authReady?: unknown } | null
    return {
      reachable: true,
      status: response.status,
      latencyMs,
      ...(body !== null && typeof body.authReady === 'boolean' ? { authReady: body.authReady } : {}),
    }
  } catch (error) {
    const latencyMs = Date.now() - startedAt
    const timedOut = controller.signal.aborted && signal?.aborted !== true
    return {
      reachable: false,
      latencyMs,
      error: timedOut
        ? `The StarBridge server did not answer within ${timeoutMs}ms.`
        : `The StarBridge server could not be reached: ${String(error)}`,
      hint: timedOut
        ? 'Raise gateway.timeoutMs, or check the corporate network path to the server.'
        : 'Check the address and that this machine can reach the StarBridge server.',
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Exchange username + password for a platform token.
 *
 * Lives here rather than in the service so the access layer can be handed a
 * plain function, which is also what makes it testable without a Cordis host.
 *
 * @param request - address and credentials.
 * @param timeoutMs - per-attempt budget.
 * @returns the issued token.
 * @throws {StarBridgeError} with a code the UI can branch on.
 */
export async function loginToPlatform(
  request: PlatformLoginRequest,
  timeoutMs: number,
): Promise<PlatformLoginOutcome> {
  const urls = gatewayUrls(request.baseUrl)
  if (urls.faceUrl.length === 0) {
    throw new StarBridgeError('INVALID_ARGUMENT', `"${request.baseUrl}" is not a usable StarBridge address.`, {
      hint: 'Use an address like "https://starbridge.example.com/starbridge/gw".',
    })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('login timed out')), timeoutMs)
  let response: Response
  try {
    response = await fetch(`${urls.faceUrl}/login`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-trace-id': newTraceId('login'),
      },
      body: JSON.stringify({
        username: request.username,
        password: request.password,
        client: 'dsh-starbridge-client',
      }),
      signal: controller.signal,
    })
  } catch (error) {
    throw new StarBridgeError(
      controller.signal.aborted ? 'GATEWAY_TIMEOUT' : 'GATEWAY_UNREACHABLE',
      controller.signal.aborted
        ? `Sign-in to ${urls.faceUrl} timed out after ${timeoutMs}ms.`
        : `Sign-in to ${urls.faceUrl} could not be reached: ${String(error)}`,
      {
        hint: 'Check the StarBridge address and that this machine can reach the server.',
        cause: error,
      },
    )
  } finally {
    clearTimeout(timer)
  }

  const text = await response.text().catch(() => '')
  let body: { code?: unknown; data?: unknown; msg?: unknown } | null = null
  try {
    body = text.length > 0 ? JSON.parse(text) as { code?: unknown; data?: unknown; msg?: unknown } : null
  } catch {
    body = null
  }

  if (!response.ok) {
    // The server answers with the framework envelope; only its message is ever
    // surfaced, and it deliberately never echoes the username back.
    const message = body !== null && typeof body.msg === 'string' && body.msg.length > 0
      ? body.msg
      : `Sign-in was rejected (HTTP ${response.status}).`
    throw new StarBridgeError(
      response.status === 401 ? 'AUTH_FAILED' : 'GATEWAY_HTTP',
      message,
      {
        status: response.status,
        hint: response.status === 401
          ? 'Check the StarBridge account name and password. The platform does not say which of the two is wrong.'
          : 'If this repeats, ask the StarBridge operator to check /starbridge/gw/login on the server.',
      },
    )
  }

  const data = body !== null && typeof body.data === 'object' && body.data !== null
    ? body.data as Record<string, unknown>
    : null
  const accessToken = data !== null && typeof data.accessToken === 'string' ? data.accessToken : ''
  if (accessToken.length === 0) {
    throw new StarBridgeError('GATEWAY_BAD_RESPONSE', 'Sign-in succeeded but the server returned no token.', {
      hint: 'The StarBridge server answered /starbridge/gw/login without an accessToken; check its version.',
    })
  }

  return {
    accessToken,
    expiresIn: data !== null && typeof data.expiresIn === 'number' && Number.isFinite(data.expiresIn) ? data.expiresIn : 0,
    username: data !== null && typeof data.username === 'string' && data.username.length > 0
      ? data.username
      : request.username,
    ...(data !== null && typeof data.nickName === 'string' && data.nickName.length > 0 ? { nickName: data.nickName } : {}),
  }
}
