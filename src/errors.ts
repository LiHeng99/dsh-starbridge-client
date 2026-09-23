/**
 * StarBridge error taxonomy and secret redaction.
 *
 * Every failure that can reach a user or an operator is a
 * {@link StarBridgeError}: a stable machine code, a message that says what
 * happened, and a `hint` that says what to do next. The tools render the hint
 * into the model-visible text, and the HTTP routes render it into the JSON error
 * body the settings panel shows — so "errors are loud" is one mechanism, not
 * three copies of a message.
 *
 * @module dsh-starbridge-client/errors
 */

/** Stable machine-readable failure codes. */
export type StarBridgeErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_FAILED'
  | 'AUTH_NOT_CONFIGURED'
  | 'CONFIG_INVALID'
  | 'GATEWAY_NOT_CONFIGURED'
  | 'GATEWAY_UNREACHABLE'
  | 'GATEWAY_TIMEOUT'
  | 'GATEWAY_REJECTED'
  | 'GATEWAY_HTTP'
  | 'GATEWAY_STREAM_ERROR'
  | 'GATEWAY_BAD_RESPONSE'
  | 'CALLER_ABORTED'
  | 'INVALID_ARGUMENT'
  | 'FEEDBACK_WRITE_FAILED'

/** A StarBridge failure with an actionable follow-up. */
export class StarBridgeError extends Error {
  /** Stable machine-readable code. */
  readonly code: StarBridgeErrorCode

  /** What the operator or user should do about it. */
  readonly hint: string | undefined

  /** Upstream HTTP status, when the failure came from a response. */
  readonly status: number | undefined

  /**
   * @param code - stable machine-readable code.
   * @param message - what happened.
   * @param options - optional actionable hint and upstream status.
   */
  constructor(
    code: StarBridgeErrorCode,
    message: string,
    options: { hint?: string; status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'StarBridgeError'
    this.code = code
    this.hint = options.hint
    this.status = options.status
  }
}

/**
 * Render a StarBridge failure as model-visible tool text.
 *
 * The DSH tool pipeline turns a thrown error into `Error: <message>` and ends
 * the turn, so a failure the model could route around (not signed in, gateway
 * down) is instead RETURNED as a value. This function is the one place that
 * decides that shape.
 *
 * @param error - the failure to describe.
 * @returns a single-line, actionable description.
 */
export function describeError(error: unknown): string {
  if (error instanceof StarBridgeError) {
    const hint = error.hint === undefined ? '' : ` Hint: ${error.hint}`
    return `[${error.code}] ${error.message}${hint}`
  }
  if (error instanceof Error) return `[UNEXPECTED] ${error.message}`
  return `[UNEXPECTED] ${String(error)}`
}

/** Query-parameter names whose values are secrets and must never be echoed. */
const SECRET_QUERY_KEYS = new Set(['code', 'access_token', 'refresh_token', 'id_token', 'token', 'client_secret'])

/**
 * Reduce a URL to something safe to log: secrets in the query string are
 * replaced, everything else is preserved for diagnosis.
 *
 * @param url - the URL to sanitize.
 * @returns the sanitized URL string.
 */
export function redactUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return '<unparseable-url>'
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (SECRET_QUERY_KEYS.has(key.toLowerCase())) parsed.searchParams.set(key, '***')
  }
  return parsed.toString()
}

/**
 * Reduce a header map to something safe to log.
 *
 * @param headers - the header map to sanitize.
 * @returns a copy with credential-bearing values replaced.
 */
export function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key] = /^(authorization|proxy-authorization|x-api-key|api-key|cookie)$/i.test(key) ? '***' : value
  }
  return out
}
