/**
 * Logging for the host half, with credential redaction.
 *
 * StarBridge handles three secrets — a gateway API key, an access token, and a
 * refresh token — and a failure message is exactly where one of them is most
 * likely to be interpolated by accident (an error string built from a request
 * URL, a provider's rejection body). Every host module therefore logs through
 * this sink, which scrubs credential-shaped text before it reaches whatever
 * exporter the harness has mounted.
 *
 * @module @company/dsh-starbridge-client/log
 */

/** The variadic, printf-style logger method shape Cordis uses. */
export type LoggerMethodLike = (format: unknown, ...parameters: unknown[]) => void

/** A logger with the four severity methods this plugin uses. */
export interface LoggerLike {
  /** Informational line. */
  info: LoggerMethodLike
  /** Diagnostic line. */
  warn: LoggerMethodLike
  /** Failure line. */
  error: LoggerMethodLike
  /** Verbose diagnostic line. */
  debug: LoggerMethodLike
}

/** Text patterns that must never reach an exporter. */
const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // `Authorization: Bearer <token>` and bare bearer tokens.
  [/\b(bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, '$1 ***'],
  // JSON-ish `"access_token": "…"` / `access_token=…`.
  [/(["']?(?:access_token|refresh_token|id_token|client_secret|code_verifier|api[_-]?key)["']?\s*[:=]\s*["']?)[^"'\s,}&]+/gi, '$1***'],
  // JWTs anywhere they appear (header.payload.signature).
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, '***JWT***'],
]

/**
 * Redact credential-shaped substrings from one log argument.
 *
 * Non-string arguments are passed through untouched so structured logging keeps
 * working; only text that could carry a secret is rewritten.
 *
 * @param value - the log argument.
 * @returns the argument, with secrets replaced.
 */
export function redactLogArgument(value: unknown): unknown {
  if (typeof value === 'string') {
    let out = value
    for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
    return out
  }
  if (value instanceof Error) {
    // Keep the error identity and stack; only its message text is scrubbed.
    let message = value.message
    for (const [pattern, replacement] of SECRET_PATTERNS) message = message.replace(pattern, replacement)
    return message === value.message ? value : message
  }
  return value
}

/**
 * Wrap a logger so every message is scrubbed before export.
 *
 * Severity methods are forwarded explicitly rather than spread, so the
 * arity/format behaviour of the underlying printf-style logger is preserved.
 */
export class RedactingSink implements LoggerLike {
  private readonly inner: LoggerLike

  /** @param inner - the logger to scrub for. */
  constructor(inner: LoggerLike) {
    this.inner = inner
  }

  /** @param format - printf format. @param parameters - format arguments. */
  info(format: unknown, ...parameters: unknown[]): void {
    this.inner.info(format, ...parameters.map(redactLogArgument))
  }

  /** @param format - printf format. @param parameters - format arguments. */
  warn(format: unknown, ...parameters: unknown[]): void {
    this.inner.warn(format, ...parameters.map(redactLogArgument))
  }

  /** @param format - printf format. @param parameters - format arguments. */
  error(format: unknown, ...parameters: unknown[]): void {
    this.inner.error(format, ...parameters.map(redactLogArgument))
  }

  /** @param format - printf format. @param parameters - format arguments. */
  debug(format: unknown, ...parameters: unknown[]): void {
    this.inner.debug(format, ...parameters.map(redactLogArgument))
  }
}
