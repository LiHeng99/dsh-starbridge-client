/**
 * The `/starbridge/api` route surface owned by this plugin on the DSH web
 * server.
 *
 * This is the "host does the dirty work" boundary: the browser never sees the
 * gateway, never holds an access token, and never retries. It asks the host for
 * status, streams a chat through the host, and posts feedback to the host — and
 * every failure comes back as a typed JSON error envelope whose `hint` the
 * settings panel can render verbatim.
 *
 * The chat route streams NDJSON (one JSON frame per line) rather than raw SSE:
 * NDJSON survives proxies and needs no `EventSource` (which cannot POST), and
 * the plugin that owns the wire format is this one on both ends.
 *
 * @module @company/dsh-starbridge-client/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { StarBridgeError } from './errors.ts'
import { newTraceId } from './trace.ts'
import type { StarBridgeService } from './augment.ts'
import type {
  StarBridgeChatFrame,
  StarBridgeChatMessage,
  StarBridgeErrorBody,
  StarBridgeFeedbackRouteRequest,
  StarBridgeFeedbackVerdict,
} from './shared/protocol.ts'
import { STARBRIDGE_ROUTE_PREFIX } from './shared/protocol.ts'

/**
 * The minimal contract this plugin needs from the host web server.
 *
 * Declared structurally instead of imported so the plugin depends on exactly
 * one host service and no host package: `@deepseek-ai/dsh-host-webserver`
 * satisfies it, and `scripts/verify.mjs` satisfies it with a six-line double.
 */
export interface HostRouteServer {
  /**
   * Register one named HTTP route.
   * @param route - route kind, path, and owning handler.
   * @returns a disposer removing the registration.
   */
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    /** HTTP methods the route answers; omitted means every method. */
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  }): () => void
}

/** Logger surface these routes need; satisfied by `ctx.logger`. */
export interface RouteLogger {
  /** Informational line. */
  info(message: string): void
  /** Diagnostic line. */
  warn(message: string): void
}

/** Largest accepted request body; a chat turn is text, never a file upload. */
const MAX_BODY_BYTES = 256 * 1024

/**
 * Register every StarBridge route on the host web server.
 *
 * @param server - the host web server service.
 * @param service - the host-side StarBridge service.
 * @param logger - diagnostic sink.
 * @returns a disposer removing all registrations (plugin teardown).
 */
export function registerStarBridgeRoutes(
  server: HostRouteServer,
  service: StarBridgeService,
  logger: RouteLogger,
): () => void {
  const disposers = [
    server.register({
      kind: 'exact',
      path: `${STARBRIDGE_ROUTE_PREFIX}/status`,
      handler: (req, res) => handleStatus(req, res, service),
    }),
    server.register({
      kind: 'exact',
      path: `${STARBRIDGE_ROUTE_PREFIX}/connectivity`,
      handler: (req, res) => handleConnectivity(req, res, service),
    }),
    server.register({
      kind: 'exact',
      path: `${STARBRIDGE_ROUTE_PREFIX}/chat`,
      handler: (req, res) => handleChat(req, res, service, logger),
    }),
    server.register({
      kind: 'exact',
      path: `${STARBRIDGE_ROUTE_PREFIX}/feedback`,
      handler: (req, res) => handleFeedback(req, res, service, logger),
    }),
    server.register({
      kind: 'exact',
      path: `${STARBRIDGE_ROUTE_PREFIX}/login`,
      handler: (req, res) => handleLogin(req, res, service),
    }),
    server.register({
      kind: 'exact',
      path: `${STARBRIDGE_ROUTE_PREFIX}/login/complete`,
      handler: (req, res) => handleLoginComplete(req, res, service),
    }),
    server.register({
      kind: 'exact',
      path: `${STARBRIDGE_ROUTE_PREFIX}/logout`,
      handler: (req, res) => handleLogout(req, res, service),
    }),
    // ── 接入配置（用户填写的星桥地址与登录方式）────────────────────────
    server.register({
      kind: 'exact',
      path: `${STARBRIDGE_ROUTE_PREFIX}/gateway/settings`,
      handler: (req, res) => handleGatewaySettings(req, res, service, logger),
    }),
    server.register({
      kind: 'exact',
      path: `${STARBRIDGE_ROUTE_PREFIX}/gateway/access-key`,
      handler: (req, res) => handleAccessKey(req, res, service, logger),
    }),
    server.register({
      kind: 'exact',
      path: `${STARBRIDGE_ROUTE_PREFIX}/gateway/login`,
      handler: (req, res) => handlePlatformLogin(req, res, service, logger),
    }),
    server.register({
      kind: 'exact',
      path: `${STARBRIDGE_ROUTE_PREFIX}/gateway/model-route`,
      handler: (req, res) => handleModelRoute(req, res, service, logger),
    }),
    server.register({
      kind: 'exact',
      path: `${STARBRIDGE_ROUTE_PREFIX}/gateway/forget`,
      handler: (req, res) => handleForgetAccess(req, res, service, logger),
    }),
  ]

  return () => {
    // Reverse order so a partial failure cannot leave a route registered twice
    // if the host ever re-runs registration against the same table.
    for (const dispose of [...disposers].reverse()) {
      try {
        dispose()
      } catch (error) {
        logger.warn(`starbridge: could not remove an HTTP route (${String(error)})`)
      }
    }
  }
}

/**
 * Write one JSON response.
 *
 * @param res - the server response.
 * @param status - HTTP status code.
 * @param body - JSON-serializable body.
 */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * Write a typed error envelope.
 *
 * @param res - the server response.
 * @param error - the failure to report.
 * @param fallbackStatus - status used when the failure carries none.
 */
function writeError(res: ServerResponse, error: unknown, fallbackStatus = 500): void {
  if (error instanceof StarBridgeError) {
    const status = error.code === 'AUTH_REQUIRED'
      ? 401
      : error.code === 'AUTH_NOT_CONFIGURED'
        ? 503
        : error.code === 'INVALID_ARGUMENT'
          ? 400
          : error.status ?? fallbackStatus
    const body: StarBridgeErrorBody = {
      code: error.code,
      message: error.message,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
    }
    writeJson(res, status >= 400 && status < 600 ? status : fallbackStatus, body)
    return
  }
  const body: StarBridgeErrorBody = {
    code: 'UNEXPECTED',
    message: error instanceof Error ? error.message : String(error),
  }
  writeJson(res, fallbackStatus, body)
}

/**
 * Read and JSON-parse a request body with a hard size cap.
 *
 * @param req - the incoming request.
 * @returns the parsed body (an empty object for an empty body).
 * @throws {StarBridgeError} `INVALID_ARGUMENT` when the body is too large or not JSON.
 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      throw new StarBridgeError('INVALID_ARGUMENT', `The request body exceeds ${MAX_BODY_BYTES} bytes.`, {
        hint: 'Send only the conversation text; attachments belong in the chat surface, not this route.',
      })
    }
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new StarBridgeError('INVALID_ARGUMENT', 'The request body must be a JSON object.', {
        hint: 'Send `content-type: application/json` with an object body.',
      })
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof StarBridgeError) throw error
    throw new StarBridgeError('INVALID_ARGUMENT', 'The request body is not valid JSON.', { cause: error })
  }
}

/**
 * Derive the OIDC redirect URI for this host.
 *
 * The identity provider matches this string exactly, so it is built from the
 * actual request authority rather than configured twice; an explicit
 * `STARBRIDGE_REDIRECT_URI` wins for deployments behind a fixed external name.
 *
 * @param req - the incoming login request.
 * @returns the absolute callback URL.
 */
export function resolveRedirectUri(req: IncomingMessage): string {
  const explicit = process.env.STARBRIDGE_REDIRECT_URI
  if (explicit !== undefined && explicit.length > 0) return explicit

  const forwardedHost = firstHeader(req.headers['x-forwarded-host'])
  const host = forwardedHost ?? req.headers.host ?? '127.0.0.1'
  const forwardedProto = firstHeader(req.headers['x-forwarded-proto'])
  const encrypted = typeof (req.socket as { encrypted?: boolean }).encrypted === 'boolean'
    ? (req.socket as { encrypted?: boolean }).encrypted === true
    : false
  const proto = forwardedProto ?? (encrypted ? 'https' : 'http')
  return `${proto}://${host}${STARBRIDGE_ROUTE_PREFIX}/login/complete`
}

/**
 * First value of a possibly-repeated header.
 * @param value - raw header value.
 * @returns the first string, or undefined.
 */
function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

/**
 * Read and validate the `messages` field of a chat request.
 *
 * @param body - parsed request body.
 * @returns the normalized conversation.
 * @throws {StarBridgeError} `INVALID_ARGUMENT` on an empty or malformed list.
 */
function readMessages(body: Record<string, unknown>): StarBridgeChatMessage[] {
  const raw = body.messages
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new StarBridgeError('INVALID_ARGUMENT', 'The chat request needs a non-empty `messages` array.', {
      hint: 'Send `{ messages: [{ role: "user", content: "…" }] }`.',
    })
  }
  return raw.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new StarBridgeError('INVALID_ARGUMENT', 'Every message must be an object with role and content.', {
        hint: 'Send `{ role: "user" | "assistant" | "system", content: "…" }`.',
      })
    }
    const record = entry as Record<string, unknown>
    const role = record.role
    const content = record.content
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      throw new StarBridgeError('INVALID_ARGUMENT', `Unsupported message role "${String(role)}".`, {
        hint: 'Use one of "user", "assistant", or "system".',
      })
    }
    if (typeof content !== 'string') {
      throw new StarBridgeError('INVALID_ARGUMENT', 'Every message needs a string `content`.')
    }
    return { role, content }
  })
}

/** `GET /starbridge/api/status`. */
function handleStatus(_req: IncomingMessage, res: ServerResponse, service: StarBridgeService): void {
  writeJson(res, 200, service.status())
}

/** `POST /starbridge/api/connectivity`. */
async function handleConnectivity(
  req: IncomingMessage,
  res: ServerResponse,
  service: StarBridgeService,
): Promise<void> {
  try {
    const body = await readJsonBody(req)
    const override = typeof body.gatewayUrl === 'string' ? body.gatewayUrl : undefined
    writeJson(res, 200, await service.testConnectivity(override))
  } catch (error) {
    writeError(res, error)
  }
}

/**
 * `POST /starbridge/api/chat` — stream one exchange as NDJSON frames.
 *
 * Frames are flushed as they arrive, so the panel renders a reply while the
 * gateway is still producing it. A failure after the first frame is delivered
 * as an `error` frame rather than an HTTP status, because the status line is
 * already on the wire.
 */
async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  service: StarBridgeService,
  logger: RouteLogger,
): Promise<void> {
  const traceId = newTraceId('route')
  let body: Record<string, unknown>
  try {
    body = await readJsonBody(req)
  } catch (error) {
    writeError(res, error)
    return
  }

  let messages: StarBridgeChatMessage[]
  try {
    messages = readMessages(body)
  } catch (error) {
    writeError(res, error)
    return
  }

  const scenario = typeof body.scenario === 'string' && body.scenario.length > 0 ? body.scenario : undefined

  // The browser closing the tab must abort the upstream request, or the
  // gateway keeps generating into a socket nobody reads.
  const controller = new AbortController()
  const onClose = (): void => controller.abort(new Error('client disconnected'))
  res.on('close', onClose)

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    // `no-transform` keeps the compression layer from buffering the stream, and
    // `no-store` keeps a reply out of any intermediary cache.
    'cache-control': 'no-store, no-transform',
    'x-starbridge-trace': traceId,
  })

  const send = (frame: StarBridgeChatFrame): void => {
    if (res.writableEnded) return
    res.write(`${JSON.stringify(frame)}\n`)
  }

  try {
    let last = ''
    for await (const delta of service.chatStream({ messages, ...(scenario === undefined ? {} : { scenario }), signal: controller.signal })) {
      if (delta.text.length > 0) {
        last += delta.text
        send({ type: 'delta', text: delta.text })
      }
      if (delta.done) {
        send({
          type: 'done',
          traceId,
          ...(delta.conversationId === undefined ? {} : { conversationId: delta.conversationId }),
        })
      }
    }
    logger.info(`starbridge: chat route streamed ${last.length} characters (trace ${traceId})`)
  } catch (error) {
    if (!controller.signal.aborted) {
      logger.warn(`starbridge: chat route failed (trace ${traceId}): ${error instanceof Error ? error.message : String(error)}`)
    }
    if (error instanceof StarBridgeError && error.code === 'CALLER_ABORTED') {
      // The client went away; nothing to report.
    } else if (error instanceof StarBridgeError) {
      send({ type: 'error', code: error.code, message: error.message, ...(error.hint === undefined ? {} : { hint: error.hint }) })
    } else {
      send({ type: 'error', code: 'UNEXPECTED', message: error instanceof Error ? error.message : String(error) })
    }
  } finally {
    res.off('close', onClose)
    if (!res.writableEnded) res.end()
  }
}

/** `POST /starbridge/api/feedback`. */
async function handleFeedback(
  req: IncomingMessage,
  res: ServerResponse,
  service: StarBridgeService,
  logger: RouteLogger,
): Promise<void> {
  try {
    const body = await readJsonBody(req) as StarBridgeFeedbackRouteRequest & Record<string, unknown>
    const messageId = typeof body.messageId === 'string' ? body.messageId : ''
    const verdict = body.verdict
    if (verdict !== 'up' && verdict !== 'down') {
      throw new StarBridgeError('INVALID_ARGUMENT', '`verdict` must be "up" or "down".', {
        hint: 'Send `{ messageId, verdict: "up" | "down", note?, expectation? }`.',
      })
    }
    const result = await service.recordFeedback({
      messageId,
      verdict: verdict as StarBridgeFeedbackVerdict,
      ...(typeof body.note === 'string' && body.note.length > 0 ? { note: body.note } : {}),
      ...(typeof body.expectation === 'string' && body.expectation.length > 0
        ? { expectation: body.expectation }
        : {}),
      ...(typeof body.conversationId === 'string' ? { conversationId: body.conversationId } : {}),
      ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
    })
    writeJson(res, 200, result)
  } catch (error) {
    logger.warn(`starbridge: feedback route failed: ${error instanceof Error ? error.message : String(error)}`)
    writeError(res, error)
  }
}

/** `POST /starbridge/api/login` — return the authorization URL to open. */
async function handleLogin(req: IncomingMessage, res: ServerResponse, service: StarBridgeService): Promise<void> {
  try {
    const redirectUri = resolveRedirectUri(req)
    const authorizeUrl = await service.beginLogin(redirectUri)
    writeJson(res, 200, { authorizeUrl, redirectUri })
  } catch (error) {
    writeError(res, error)
  }
}

/**
 * `GET|POST /starbridge/api/login/complete` — the OIDC redirect target.
 *
 * Answers with a small self-closing HTML page rather than JSON: the browser
 * lands here as a top-level navigation, and the user should be told to go back
 * to DSH instead of being shown a JSON document.
 */
async function handleLoginComplete(
  req: IncomingMessage,
  res: ServerResponse,
  service: StarBridgeService,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  let code = url.searchParams.get('code')
  let state = url.searchParams.get('state')

  if (req.method === 'POST') {
    try {
      const body = await readJsonBody(req)
      if (typeof body.code === 'string') code = body.code
      if (typeof body.state === 'string') state = body.state
    } catch {
      // Fall through to the query-string values.
    }
  }

  const providerError = url.searchParams.get('error')
  if (providerError !== null) {
    writeLoginPage(res, 400, 'Sign-in was refused', url.searchParams.get('error_description') ?? providerError)
    return
  }
  if (code === null || code.length === 0 || state === null || state.length === 0) {
    writeLoginPage(res, 400, 'Sign-in could not be completed', 'The callback arrived without a code and state.')
    return
  }

  try {
    const status = await service.completeLogin(code, state, resolveRedirectUri(req))
    writeLoginPage(res, 200, 'Signed in to StarBridge', `Session active${status.subject === undefined ? '' : ` as ${status.subject}`}.`)
  } catch (error) {
    if (error instanceof StarBridgeError) {
      writeLoginPage(res, 401, 'Sign-in failed', `${error.message}${error.hint === undefined ? '' : `\n${error.hint}`}`)
    } else {
      writeLoginPage(res, 500, 'Sign-in failed', error instanceof Error ? error.message : String(error))
    }
  }
}

/** `POST /starbridge/api/logout`. */
async function handleLogout(_req: IncomingMessage, res: ServerResponse, service: StarBridgeService): Promise<void> {
  try {
    await service.logout()
    writeJson(res, 200, { ok: true, auth: service.authStatus() })
  } catch (error) {
    writeError(res, error)
  }
}

/**
 * `POST /starbridge/api/gateway/settings` — save the address and identity the
 * user filled in.
 *
 * The address is normalized on the host, so the browser never has to know that
 * this plugin needs three different URLs (server root, machine face, model face)
 * out of the one string a person actually has.
 */
async function handleGatewaySettings(
  req: IncomingMessage,
  res: ServerResponse,
  service: StarBridgeService,
  logger: RouteLogger,
): Promise<void> {
  try {
    const body = await readJsonBody(req)
    const settings = await service.updateGatewaySettings({
      ...(typeof body.baseUrl === 'string' ? { baseUrl: body.baseUrl } : {}),
      ...(typeof body.userId === 'string' ? { userId: body.userId } : {}),
      ...(typeof body.department === 'string' ? { department: body.department } : {}),
      ...(isAuthMode(body.authMode) ? { authMode: body.authMode } : {}),
      ...(typeof body.modelProvider === 'string' ? { modelProvider: body.modelProvider } : {}),
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
      ...(typeof body.routeModelsThroughGateway === 'boolean'
        ? { routeModelsThroughGateway: body.routeModelsThroughGateway }
        : {}),
    })
    writeJson(res, 200, { ok: true, settings, status: service.status() })
  } catch (error) {
    logger.warn(`starbridge: the access configuration was not saved: ${error instanceof Error ? error.message : String(error)}`)
    writeError(res, error)
  }
}

/**
 * `POST /starbridge/api/gateway/access-key` — connect with a key the user pasted.
 *
 * Answers with the step checklist rather than a bare `ok`, because the three
 * things that can go wrong (wrong address, unreachable server, missing key) each
 * need a different fix and the user should see which one happened.
 */
async function handleAccessKey(
  req: IncomingMessage,
  res: ServerResponse,
  service: StarBridgeService,
  logger: RouteLogger,
): Promise<void> {
  try {
    const body = await readJsonBody(req)
    const accessKey = typeof body.accessKey === 'string' ? body.accessKey : ''
    const outcome = await service.connectWithAccessKey({
      accessKey,
      ...(typeof body.baseUrl === 'string' ? { baseUrl: body.baseUrl } : {}),
      ...(typeof body.userId === 'string' ? { userId: body.userId } : {}),
      ...(typeof body.department === 'string' ? { department: body.department } : {}),
      ...(typeof body.routeModels === 'boolean' ? { routeModels: body.routeModels } : {}),
    })
    logger.info(`starbridge: access-key connect finished ok=${outcome.ok} (${outcome.steps.map((s) => `${s.name}:${s.ok ? 'ok' : 'fail'}`).join(', ')})`)
    writeJson(res, 200, outcome)
  } catch (error) {
    writeError(res, error)
  }
}

/** `POST /starbridge/api/gateway/login` — platform account sign-in. */
async function handlePlatformLogin(
  req: IncomingMessage,
  res: ServerResponse,
  service: StarBridgeService,
  logger: RouteLogger,
): Promise<void> {
  try {
    const body = await readJsonBody(req)
    const username = typeof body.username === 'string' ? body.username : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const outcome = await service.loginWithPlatform({
      username,
      password,
      ...(typeof body.baseUrl === 'string' ? { baseUrl: body.baseUrl } : {}),
      ...(typeof body.remember === 'boolean' ? { remember: body.remember } : {}),
      ...(typeof body.routeModels === 'boolean' ? { routeModels: body.routeModels } : {}),
    })
    // The username is logged; the password never is, and neither is the token.
    logger.info(`starbridge: platform sign-in finished ok=${outcome.ok} for ${username}`)
    writeJson(res, 200, outcome)
  } catch (error) {
    writeError(res, error)
  }
}

/** `POST /starbridge/api/gateway/model-route` — turn model routing on or off. */
async function handleModelRoute(
  req: IncomingMessage,
  res: ServerResponse,
  service: StarBridgeService,
  logger: RouteLogger,
): Promise<void> {
  try {
    const body = await readJsonBody(req)
    if (typeof body.enabled !== 'boolean') {
      throw new StarBridgeError('INVALID_ARGUMENT', '`enabled` must be a boolean.', {
        hint: 'Send `{ enabled: true }` to route DSH model calls through StarBridge.',
      })
    }
    const outcome = await service.setModelRouting(body.enabled)
    logger.info(`starbridge: model routing ${body.enabled ? 'enabled' : 'disabled'} (ok=${outcome.ok})`)
    writeJson(res, 200, outcome)
  } catch (error) {
    writeError(res, error)
  }
}

/** `POST /starbridge/api/gateway/forget` — drop the stored gateway credential. */
async function handleForgetAccess(
  _req: IncomingMessage,
  res: ServerResponse,
  service: StarBridgeService,
  logger: RouteLogger,
): Promise<void> {
  try {
    const access = await service.forgetAccess()
    logger.info('starbridge: the stored gateway credential was forgotten from the settings page')
    writeJson(res, 200, { ok: true, access, status: service.status() })
  } catch (error) {
    writeError(res, error)
  }
}

/** Narrow an untrusted body value to a credential mode. */
function isAuthMode(value: unknown): value is 'unconfigured' | 'access-key' | 'account' | 'sso' {
  return value === 'unconfigured' || value === 'access-key' || value === 'account' || value === 'sso'
}

/**
 * Render the minimal callback page.
 *
 * @param res - the server response.
 * @param status - HTTP status code.
 * @param title - headline shown to the user.
 * @param detail - supporting line.
 */
function writeLoginPage(res: ServerResponse, status: number, title: string, detail: string): void {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:14px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0f1115;color:#e6e8ee}
main{max-width:32rem;padding:2rem;border:1px solid #262b36;border-radius:12px;background:#151922}
h1{font-size:1.05rem;margin:0 0 .5rem}p{margin:0;color:#9aa3b2;white-space:pre-wrap}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>
<p style="margin-top:1rem">You can close this tab and return to DSH.</p></main></body></html>`
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
  })
  res.end(html)
}

/**
 * Escape text for interpolation into the callback page.
 * @param value - raw text.
 * @returns HTML-escaped text.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
