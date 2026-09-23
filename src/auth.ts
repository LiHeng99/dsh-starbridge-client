/**
 * OIDC Authorization Code + PKCE and access-token lifecycle for StarBridge.
 *
 * Two rules shape this module:
 *
 * 1. **No secret is baked in.** The client id, issuer, and optional confidential
 *    client secret all arrive through the Config Schema (or their environment
 *    overrides), and none of them is ever written to a log line.
 * 2. **The token lives in memory; the refresh token lives encrypted on disk.**
 *    `getAccessToken()` never returns a stale token — it refreshes ahead of
 *    expiry — and it THROWS `AUTH_REQUIRED` rather than returning an empty
 *    string, so a tool call without a session fails with a message a user can
 *    act on instead of an opaque 401 from the gateway.
 *
 * @module dsh-starbridge-client/auth
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { StarBridgeError } from './errors.ts'
import type { StarBridgeAuthState, StarBridgeAuthStatus } from './shared/protocol.ts'
import { isTraceId, newTraceId } from './trace.ts'

/** The subset of an OIDC discovery document this plugin consumes. */
export interface OidcDiscovery {
  /** Authorization endpoint the browser is sent to. */
  readonly authorization_endpoint: string
  /** Token endpoint the host exchanges/refreshes against. */
  readonly token_endpoint: string
  /** End-session endpoint, when the provider supports RP-initiated logout. */
  readonly end_session_endpoint?: string
  /** Userinfo endpoint, used only to report the signed-in subject. */
  readonly userinfo_endpoint?: string
  /** Issuer the provider claims, checked against the configured value. */
  readonly issuer: string
}

/** Tokens held for one signed-in employee. */
export interface TokenSet {
  /** Bearer token presented to the gateway. */
  readonly accessToken: string
  /** Refresh token, when the provider issued one. */
  readonly refreshToken?: string
  /** Epoch millis at which `accessToken` stops being valid. */
  readonly expiresAt: number
  /** OIDC subject, when known. */
  readonly subject?: string
}

/** Decrypted tokens as persisted between sessions. */
export interface PersistedTokens {
  /** Refresh token issued by the provider. */
  readonly refreshToken: string
  /** Last known subject, for the signed-in display name. */
  readonly subject?: string
}

/** Read/write port for refresh-token persistence. */
export interface TokenPersistence {
  /** Load previously stored tokens, or `null` when there are none. */
  load(): Promise<PersistedTokens | null>
  /** Store tokens, replacing any previous record. */
  save(tokens: PersistedTokens): Promise<void>
  /** Drop the stored record (logout, or a rejected refresh token). */
  clear(): Promise<void>
}

/** The authorization-code flow state the host remembers between the two legs. */
export interface LoginAttempt {
  /** Opaque CSRF state echoed back by the provider. */
  readonly state: string
  /** PKCE code verifier whose S256 hash was sent as the challenge. */
  readonly codeVerifier: string
  /** Epoch millis after which the attempt is refused. */
  readonly expiresAt: number
}

/** Minimal logger surface, so this module never depends on Cordis. */
export interface AuthLogger {
  /** Informational line. */
  info(message: string): void
  /** Diagnostic line; never carries a credential. */
  warn(message: string): void
}

/** Default lifetime of one authorization-code attempt. */
const LOGIN_ATTEMPT_TTL_MS = 10 * 60_000

/** Discovery documents are cached this long before being refetched. */
const DISCOVERY_TTL_MS = 30 * 60_000

/** Response body of an OIDC token endpoint. */
interface TokenEndpointResponse {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  id_token?: unknown
}

/** Cryptographically-random base64url string. */
function randomUrlSafe(bytes: number): string {
  return randomBytes(bytes).toString('base64url')
}

/** base64url-encode a buffer without padding. */
function toBase64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Derive the S256 PKCE challenge for a verifier.
 * @param verifier - the code verifier.
 * @returns the base64url SHA-256 digest.
 */
export function pkceChallenge(verifier: string): string {
  return toBase64Url(createHash('sha256').update(verifier).digest())
}

/**
 * Decode the `sub` claim of a JWT without verifying it.
 *
 * The token came straight from the provider's TLS-protected token endpoint, so
 * this is used only to LABEL the session in the settings panel. Nothing
 * security-relevant is decided from it, and a malformed token simply yields no
 * subject instead of failing the login.
 *
 * @param token - the id_token.
 * @returns the subject claim, or undefined.
 */
function subjectFromIdToken(token: string): string | undefined {
  const parts = token.split('.')
  if (parts.length < 2 || parts[1] === undefined) return undefined
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (typeof payload !== 'object' || payload === null) return undefined
    const sub = (payload as { sub?: unknown }).sub
    if (typeof sub === 'string' && sub.length > 0) return sub
    const preferred = (payload as { preferred_username?: unknown }).preferred_username
    return typeof preferred === 'string' && preferred.length > 0 ? preferred : undefined
  } catch {
    return undefined
  }
}

/**
 * Perform one HTTP request with a hard timeout.
 *
 * @param url - absolute request URL.
 * @param init - fetch options; a signal is added by this function.
 * @param timeoutMs - budget in milliseconds.
 * @returns the response.
 * @throws {StarBridgeError} on timeout or transport failure.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  what: string,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`${what} timed out after ${timeoutMs}ms`)), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (cause) {
    const timedOut = controller.signal.aborted
    throw new StarBridgeError(
      timedOut ? 'GATEWAY_TIMEOUT' : 'GATEWAY_UNREACHABLE',
      timedOut ? `${what} timed out after ${timeoutMs}ms.` : `${what} could not be reached: ${String(cause)}`,
      {
        hint: timedOut
          ? 'Raise gateway.timeoutMs if the identity provider is slow, or check the corporate network path to the issuer.'
          : 'Check network access to the identity provider, then retry. If the issuer moved, update oidc.issuerUrl.',
        cause,
      },
    )
  } finally {
    clearTimeout(timer)
  }
}

/** The in-memory half of the token vault, used when no file is configured. */
export class MemoryTokenPersistence implements TokenPersistence {
  private record: PersistedTokens | null = null

  /** @returns the held record. */
  async load(): Promise<PersistedTokens | null> {
    return this.record
  }

  /** @param tokens - record to hold. */
  async save(tokens: PersistedTokens): Promise<void> {
    this.record = tokens
  }

  /** Drop the held record. */
  async clear(): Promise<void> {
    this.record = null
  }
}

/**
 * OIDC client and access-token owner.
 *
 * One instance lives on the plugin fiber. It is deliberately not a Cordis
 * service: the host registers `ctx.starBridge`, and this class is an
 * implementation detail of it, which keeps the service surface one thing.
 */
export class AuthManager {
  private readonly issuerUrl: string
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly scopes: readonly string[]
  private readonly prompt: string
  private readonly refreshSkewMs: number
  private readonly timeoutMs: number
  private readonly department: string
  private readonly persistence: TokenPersistence
  private readonly logger: AuthLogger

  /** Current access token and its expiry; the ONLY place a token is held. */
  private token: TokenSet | null = null
  /** Refresh token that survived the last successful login or refresh. */
  private refreshToken: string | null = null
  /** Last subject reported by the provider. */
  private subject: string | null = null
  /** One login attempt at a time; keyed by the opaque `state` value. */
  private attempt: LoginAttempt | null = null
  /** Last failure, surfaced to the settings panel. */
  private lastError: string | null = null
  /** In-flight refresh, so concurrent callers share one token request. */
  private refreshing: Promise<string> | null = null
  /** Discovery cache. */
  private discovery: { document: OidcDiscovery; fetchedAt: number } | null = null

  /**
   * @param options - resolved configuration plus the persistence port.
   */
  constructor(options: {
    issuerUrl: string
    clientId: string
    clientSecret: string
    scopes: readonly string[]
    prompt: string
    refreshSkewMs: number
    timeoutMs: number
    /** Department reported in {@link AuthManager.getStatus}; empty means unset. */
    department: string
    persistence: TokenPersistence
    logger: AuthLogger
  }) {
    this.issuerUrl = options.issuerUrl
    this.clientId = options.clientId
    this.clientSecret = options.clientSecret
    this.scopes = options.scopes
    this.prompt = options.prompt
    this.refreshSkewMs = options.refreshSkewMs
    this.timeoutMs = options.timeoutMs
    this.department = options.department
    this.persistence = options.persistence
    this.logger = options.logger
  }

  /**
   * Whether this deployment configured OIDC at all.
   * @returns true when issuer and client id are both present.
   */
  get configured(): boolean {
    return this.issuerUrl.length > 0 && this.clientId.length > 0
  }

  /** The issuer the browser should be sent to (empty when unconfigured). */
  get issuer(): string {
    return this.issuerUrl
  }

  /**
   * Fetch (and cache) the provider's discovery document.
   *
   * @param force - bypass the cache, e.g. after a rejected refresh token.
   * @returns the normalized discovery document.
   * @throws {StarBridgeError} `AUTH_NOT_CONFIGURED` when OIDC is unconfigured,
   * or `AUTH_FAILED` when the document is missing the endpoints we require.
   */
  async discover(force = false): Promise<OidcDiscovery> {
    if (!this.configured) {
      throw new StarBridgeError(
        'AUTH_NOT_CONFIGURED',
        'Sign-in is not configured for this DSH profile.',
        {
          hint: 'Set oidc.issuerUrl and oidc.clientId in the StarBridge plugin config '
            + '(or STARBRIDGE_OIDC_ISSUER_URL / STARBRIDGE_OIDC_CLIENT_ID), then reload the profile.',
        },
      )
    }
    if (!force && this.discovery !== null && Date.now() - this.discovery.fetchedAt < DISCOVERY_TTL_MS) {
      return this.discovery.document
    }

    const url = `${this.issuerUrl}/.well-known/openid-configuration`
    const response = await fetchWithTimeout(
      url,
      { method: 'GET', headers: { accept: 'application/json' } },
      this.timeoutMs,
      'OIDC discovery',
    )
    if (!response.ok) {
      throw new StarBridgeError(
        'AUTH_FAILED',
        `OIDC discovery failed with HTTP ${response.status} at ${url}.`,
        {
          hint: 'Verify oidc.issuerUrl points at the realm root (not the authorization endpoint) and that '
            + 'the DSH host can reach the identity provider.',
          status: response.status,
        },
      )
    }

    let raw: unknown
    try {
      raw = await response.json()
    } catch (cause) {
      throw new StarBridgeError('AUTH_FAILED', `OIDC discovery at ${url} did not return JSON.`, {
        hint: 'The issuer may be behind a captive portal or a proxy that returned HTML.',
        cause,
      })
    }
    if (typeof raw !== 'object' || raw === null) {
      throw new StarBridgeError('AUTH_FAILED', `OIDC discovery at ${url} returned a non-object document.`)
    }

    const doc = raw as Record<string, unknown>
    const authorization = doc.authorization_endpoint
    const tokenEndpoint = doc.token_endpoint
    if (typeof authorization !== 'string' || typeof tokenEndpoint !== 'string') {
      throw new StarBridgeError(
        'AUTH_FAILED',
        `OIDC discovery at ${url} is missing authorization_endpoint or token_endpoint.`,
        { hint: 'The issuer must support OIDC Authorization Code + PKCE; check its discovery document.' },
      )
    }

    const document: OidcDiscovery = {
      authorization_endpoint: authorization,
      token_endpoint: tokenEndpoint,
      issuer: typeof doc.issuer === 'string' ? doc.issuer : this.issuerUrl,
      ...(typeof doc.end_session_endpoint === 'string' ? { end_session_endpoint: doc.end_session_endpoint } : {}),
      ...(typeof doc.userinfo_endpoint === 'string' ? { userinfo_endpoint: doc.userinfo_endpoint } : {}),
    }

    if (document.issuer.replace(/\/+$/, '') !== this.issuerUrl.replace(/\/+$/, '')) {
      this.logger.warn(
        `starbridge: OIDC issuer mismatch — configured "${this.issuerUrl}", provider reports "${document.issuer}". `
        + 'Tokens will still be requested from the discovered endpoints.',
      )
    }

    this.discovery = { document, fetchedAt: Date.now() }
    return document
  }

  /**
   * Begin an authorization-code + PKCE login.
   *
   * @param redirectUri - the loopback callback this deployment registered.
   * @returns the URL to send the browser to.
   * @throws {StarBridgeError} when OIDC is unconfigured or discovery fails.
   */
  async buildAuthorizeUrl(redirectUri: string): Promise<string> {
    const document = await this.discover()
    const codeVerifier = randomUrlSafe(48)
    const state = randomUrlSafe(24)
    this.attempt = { state, codeVerifier, expiresAt: Date.now() + LOGIN_ATTEMPT_TTL_MS }
    this.lastError = null

    const url = new URL(document.authorization_endpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('scope', this.scopes.join(' '))
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', pkceChallenge(codeVerifier))
    url.searchParams.set('code_challenge_method', 'S256')
    if (this.prompt.length > 0) url.searchParams.set('prompt', this.prompt)
    return url.toString()
  }

  /**
   * Finish a login: verify `state`, exchange the code, install the tokens.
   *
   * @param code - authorization code from the callback.
   * @param state - state echoed by the provider.
   * @param redirectUri - the same redirect URI used to start the flow.
   * @param traceId - correlation id for the exchange.
   * @returns the authenticated status.
   * @throws {StarBridgeError} `AUTH_FAILED` on state mismatch or a rejected exchange.
   */
  async completeLogin(code: string, state: string, redirectUri: string, traceId = newTraceId('auth')): Promise<StarBridgeAuthStatus> {
    const attempt = this.attempt
    this.attempt = null

    if (attempt === null) {
      throw this.failAuth('No sign-in is in progress for this DSH profile.', 'Start again from the StarBridge settings panel ("Sign in").')
    }
    if (attempt.expiresAt < Date.now()) {
      throw this.failAuth('The sign-in attempt expired.', 'Start again from the StarBridge settings panel ("Sign in").')
    }
    if (attempt.state !== state) {
      throw this.failAuth(
        'The sign-in callback state did not match the request.',
        'This usually means the callback URL was replayed or intercepted. Start the sign-in again.',
      )
    }

    const document = await this.discover()
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: this.clientId,
      code_verifier: attempt.codeVerifier,
    })

    const tokens = await this.postToken(document.token_endpoint, body, traceId, 'Authorization code exchange')
    this.installTokens(tokens)
    this.logger.info(`starbridge: signed in${this.subject === null ? '' : ` as ${this.subject}`}`)
    return this.getStatus()
  }

  /**
   * Return a usable access token, refreshing ahead of expiry.
   *
   * @param traceId - correlation id for a refresh attempt.
   * @returns a bearer token that is valid for at least `refreshSkewMs`.
   * @throws {StarBridgeError} `AUTH_REQUIRED` when nobody is signed in, or
   * `AUTH_FAILED` when the refresh token was rejected.
   */
  async getAccessToken(traceId = newTraceId('auth')): Promise<string> {
    const current = this.token
    if (current !== null && current.expiresAt - this.refreshSkewMs > Date.now()) return current.accessToken

    if (current !== null) return this.refresh(traceId)

    // No access token in memory. Try the encrypted persistence record before
    // declaring the caller anonymous — this is the "restart the profile and you
    // are still signed in" path.
    await this.restore(traceId)
    const restored = this.token
    if (restored !== null && restored.expiresAt - this.refreshSkewMs > Date.now()) return restored.accessToken
    if (restored !== null) return this.refresh(traceId)

    throw new StarBridgeError('AUTH_REQUIRED', 'No StarBridge session is active.', {
      hint: 'Open DSH Settings → 星桥 StarBridge and click "Sign in"; or call the starbridge_feedback/'
        + 'starbridge_chat tool again once the user has signed in.',
    })
  }

  /**
   * Load the persisted refresh token once and mint an access token from it.
   *
   * @param traceId - correlation id for the refresh attempt.
   */
  private async restore(traceId: string): Promise<void> {
    if (this.refreshToken !== null) return
    let persisted: PersistedTokens | null = null
    try {
      persisted = await this.persistence.load()
    } catch (cause) {
      this.logger.warn(`starbridge: could not read the stored session (${String(cause)}); continuing signed out.`)
      return
    }
    if (persisted === null) return
    this.refreshToken = persisted.refreshToken
    this.subject = persisted.subject ?? null
    await this.refresh(traceId).catch((error: unknown) => {
      // A stale/corrupt record must not wedge every later call: drop it and
      // fall back to the anonymous path, which returns a clear AUTH_REQUIRED.
      this.logger.warn(`starbridge: stored session could not be refreshed (${String(error)}); clearing it.`)
      this.refreshToken = null
      this.subject = null
      void this.persistence.clear().catch(() => undefined)
    })
  }

  /**
   * Exchange the refresh token for a new access token.
   *
   * Concurrent callers share one in-flight request so a burst of tool calls
   * cannot stampede the identity provider.
   *
   * @param traceId - correlation id for the token request.
   * @returns the new access token.
   * @throws {StarBridgeError} `AUTH_REQUIRED` when there is no refresh token.
   */
  private refresh(traceId: string): Promise<string> {
    if (this.refreshing !== null) return this.refreshing

    const refreshToken = this.refreshToken
    if (refreshToken === null) {
      return Promise.reject(new StarBridgeError('AUTH_REQUIRED', 'No StarBridge session is active.', {
        hint: 'Open DSH Settings → 星桥 StarBridge and click "Sign in".',
      }))
    }

    const run = (async (): Promise<string> => {
      const document = await this.discover()
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.clientId,
      })
      try {
        const tokens = await this.postToken(document.token_endpoint, body, traceId, 'Token refresh')
        this.installTokens(tokens)
        return this.token?.accessToken ?? ''
      } catch (error) {
        // The refresh token is gone (expired, revoked, or the account closed).
        // Drop it so the next call reports AUTH_REQUIRED and the UI offers
        // sign-in again instead of retrying a dead credential forever.
        this.token = null
        this.refreshToken = null
        this.subject = null
        await this.persistence.clear().catch(() => undefined)
        throw error
      }
    })().finally(() => {
      this.refreshing = null
    })

    this.refreshing = run
    return run
  }

  /**
   * POST one grant to the token endpoint and normalize the response.
   *
   * @param endpoint - discovered token endpoint.
   * @param body - form-encoded grant parameters.
   * @param traceId - correlation id.
   * @param what - label used in failure messages.
   * @returns the installed token set.
   * @throws {StarBridgeError} `AUTH_FAILED` on a non-2xx response or a malformed body.
   */
  private async postToken(
    endpoint: string,
    body: URLSearchParams,
    traceId: string,
    what: string,
  ): Promise<TokenSet> {
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'x-trace-id': isTraceId(traceId) ? traceId : newTraceId('auth'),
    }
    if (this.clientSecret.length > 0) {
      // Confidential clients authenticate the token request itself; public
      // PKCE clients rely on the code verifier alone.
      headers.authorization = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`
    }

    const response = await fetchWithTimeout(
      endpoint,
      { method: 'POST', headers, body: body.toString() },
      this.timeoutMs,
      what,
    )

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw this.failAuth(
        `${what} was rejected by the identity provider (HTTP ${response.status}).`,
        detail.length > 0
          ? `Provider said: ${detail.slice(0, 300)}`
          : 'Check that the client id, redirect URI, and PKCE setting match the client registration.',
      )
    }

    let payload: TokenEndpointResponse
    try {
      payload = (await response.json()) as TokenEndpointResponse
    } catch (cause) {
      throw new StarBridgeError('AUTH_FAILED', `${what} returned a body that is not JSON.`, { cause })
    }

    const accessToken = payload.access_token
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw this.failAuth(
        `${what} returned no access_token.`,
        'Verify the client is allowed the requested scopes and that the provider issues access tokens (not id_token only).',
      )
    }
    const expiresIn = typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : 3600

    return {
      accessToken,
      ...(typeof payload.refresh_token === 'string' && payload.refresh_token.length > 0
        ? { refreshToken: payload.refresh_token }
        : {}),
      expiresAt: Date.now() + expiresIn * 1000,
      ...(typeof payload.id_token === 'string'
        ? (() => {
            const subject = subjectFromIdToken(payload.id_token as string)
            return subject === undefined ? {} : { subject }
          })()
        : {}),
    }
  }

  /**
   * Install a fresh token set in memory and persist the refresh token.
   *
   * @param tokens - tokens returned by the provider.
   */
  private installTokens(tokens: TokenSet): void {
    this.token = tokens
    if (tokens.refreshToken !== undefined) this.refreshToken = tokens.refreshToken
    if (tokens.subject !== undefined) this.subject = tokens.subject
    this.lastError = null

    const refreshToken = this.refreshToken
    if (refreshToken !== null) {
      void this.persistence
        .save({ refreshToken, ...(this.subject === null ? {} : { subject: this.subject }) })
        .catch((error: unknown) => {
          this.logger.warn(
            `starbridge: signed in, but the session could not be persisted (${String(error)}); `
            + 'it will not survive a profile restart.',
          )
        })
    }
  }

  /** Record and return an authentication failure. */
  private failAuth(message: string, hint: string): StarBridgeError {
    this.lastError = message
    return new StarBridgeError('AUTH_FAILED', message, { hint })
  }

  /** Forget the session, locally and at the provider when it supports it. */
  async logout(): Promise<void> {
    this.token = null
    this.refreshToken = null
    this.subject = null
    this.attempt = null
    this.refreshing = null
    this.lastError = null
    await this.persistence.clear().catch(() => undefined)
    this.logger.info('starbridge: signed out')
  }

  /**
   * Non-secret authentication projection for the settings panel.
   * @returns the current status.
   */
  getStatus(): StarBridgeAuthStatus {
    const base = {
      department: this.department.length > 0 ? this.department : null,
      ...(this.lastError === null ? {} : { lastError: this.lastError }),
    }
    if (this.token !== null && this.token.expiresAt - this.refreshSkewMs > Date.now()) {
      return {
        ...base,
        state: 'authenticated',
        ...(this.subject === null ? {} : { subject: this.subject }),
        expiresAt: this.token.expiresAt,
      }
    }
    if (this.token !== null || this.refreshToken !== null) {
      return {
        ...base,
        state: 'expired',
        ...(this.subject === null ? {} : { subject: this.subject }),
        ...(this.token === null ? {} : { expiresAt: this.token.expiresAt }),
      }
    }
    const state: StarBridgeAuthState = this.attempt === null ? 'anonymous' : 'authenticating'
    return { ...base, state }
  }

  /** Release the discovery cache; called from the plugin's effect teardown. */
  dispose(): void {
    this.discovery = null
    this.attempt = null
  }
}

/**
 * AES-256-GCM sealed JSON file under a `0600` key file.
 *
 * Two records need exactly this treatment — the OIDC refresh token and the
 * StarBridge platform token — so the format lives in one place instead of being
 * written twice and drifting apart. Layout: `[12-byte iv][16-byte auth tag][ciphertext]`,
 * with the key generated on first use and never leaving the DSH home.
 */
export class SealedJsonFile {
  private readonly filePath: string
  private readonly keyPath: string
  private readonly logger: AuthLogger
  private key: Buffer | null = null

  /**
   * @param filePath - path of the sealed payload.
   * @param keyPath - path of the `0600` key file.
   * @param logger - diagnostic sink.
   */
  constructor(filePath: string, keyPath: string, logger: AuthLogger) {
    this.filePath = filePath
    this.keyPath = keyPath
    this.logger = logger
  }

  /**
   * Read the vault key, creating it on first use.
   *
   * @returns the 32-byte key.
   * @throws {StarBridgeError} when the key file exists with an unusable shape.
   */
  private async loadKey(): Promise<Buffer> {
    if (this.key !== null) return this.key
    try {
      const existing = await readFile(this.keyPath)
      if (existing.length !== 32) {
        throw new StarBridgeError(
          'AUTH_FAILED',
          `The StarBridge vault key at ${this.keyPath} is ${existing.length} bytes; 32 are required.`,
          { hint: 'Delete the file to sign in again (the stored session is dropped, not the gateway access).' },
        )
      }
      this.key = existing
      return existing
    } catch (error) {
      if (error instanceof StarBridgeError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const fresh = randomBytes(32)
    await mkdir(dirname(this.keyPath), { recursive: true })
    await writeFile(this.keyPath, fresh, { mode: 0o600 })
    if (process.platform !== 'win32') await chmod(this.keyPath, 0o600).catch(() => undefined)
    this.key = fresh
    return fresh
  }

  /**
   * Decrypt the stored record.
   *
   * @returns the parsed record, or null when nothing usable is stored.
   */
  async load<T>(): Promise<T | null> {
    let sealed: Buffer
    try {
      sealed = await readFile(this.filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const key = await this.loadKey()
    // Layout: [12-byte iv][16-byte auth tag][ciphertext].
    if (sealed.length < 29) return null
    const iv = sealed.subarray(0, 12)
    const tag = sealed.subarray(12, 28)
    const ciphertext = sealed.subarray(28)
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
      const parsed: unknown = JSON.parse(plaintext)
      if (typeof parsed !== 'object' || parsed === null) return null
      return parsed as T
    } catch (cause) {
      this.logger.warn(`starbridge: the sealed record at ${this.filePath} could not be decrypted (${String(cause)}); treating it as absent.`)
      await this.clear().catch(() => undefined)
      return null
    }
  }

  /**
   * Encrypt and store a record atomically.
   * @param record - JSON-serializable record to persist.
   */
  async save(record: unknown): Promise<void> {
    const key = await this.loadKey()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const plaintext = Buffer.from(JSON.stringify(record), 'utf8')
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const sealed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext])

    await mkdir(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temporary, sealed, { mode: 0o600 })
    await rename(temporary, this.filePath)
    if (process.platform !== 'win32') await chmod(this.filePath, 0o600).catch(() => undefined)
  }

  /** Remove the stored record. */
  async clear(): Promise<void> {
    await unlink(this.filePath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
}

/**
 * Encrypted refresh-token vault on disk.
 *
 * The refresh token is the one credential that must outlive the process for
 * "restart the profile, still signed in" to work. It is sealed with
 * AES-256-GCM under a key file that is created `0600` and never leaves the DSH
 * home, so a synced or backed-up profile directory does not leak a usable
 * token on its own.
 */
export class EncryptedTokenPersistence implements TokenPersistence {
  private readonly vault: SealedJsonFile
  private readonly tokenPath: string
  private readonly logger: AuthLogger

  /**
   * @param directory - DSH home directory holding both files.
   * @param logger - diagnostic sink.
   */
  constructor(directory: string, logger: AuthLogger) {
    this.tokenPath = join(directory, 'starbridge-session.enc')
    this.vault = new SealedJsonFile(this.tokenPath, join(directory, 'starbridge-session.key'), logger)
    this.logger = logger
  }

  /**
   * Decrypt the stored session.
   * @returns the tokens, or null when nothing is stored.
   */
  async load(): Promise<PersistedTokens | null> {
    const parsed = await this.vault.load<{ refreshToken?: unknown; subject?: unknown }>()
    if (parsed === null) return null
    if (typeof parsed.refreshToken !== 'string' || parsed.refreshToken.length === 0) return null
    return {
      refreshToken: parsed.refreshToken,
      ...(typeof parsed.subject === 'string' ? { subject: parsed.subject } : {}),
    }
  }

  /**
   * Encrypt and store the session atomically.
   * @param tokens - refresh token and subject to persist.
   */
  async save(tokens: PersistedTokens): Promise<void> {
    await this.vault.save(tokens)
  }

  /** Remove the stored session. */
  async clear(): Promise<void> {
    await this.vault.clear()
  }
}
