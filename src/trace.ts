/**
 * Trace-id minting.
 *
 * Every StarBridge request carries a `traceId` so one employee report
 * ("it gave a wrong answer at 14:02") can be joined to the gateway's own logs
 * and to the DSH session that produced it. The id is time-ordered and
 * human-quotable on purpose: `sb-<epoch-ms>-<random>` sorts chronologically and
 * survives being pasted into a ticket.
 *
 * @module dsh-starbridge-client/trace
 */

/** Lowercase hex alphabet for the random suffix. */
const HEX = '0123456789abcdef'

/**
 * Mint a time-ordered trace id.
 *
 * Uses the Web Crypto global (`globalThis.crypto` exists in Node 22+ and every
 * supported browser), so no import and no Node-only API is involved.
 *
 * @param prefix - short subsystem tag placed after `sb`.
 * @returns a trace id of the form `sb-<prefix>-<epochMs>-<8 hex chars>`.
 */
export function newTraceId(prefix = 'req'): string {
  const bytes = new Uint8Array(4)
  globalThis.crypto.getRandomValues(bytes)
  let suffix = ''
  for (const byte of bytes) suffix += HEX[byte & 0x0f]! + HEX[(byte >> 4) & 0x0f]!
  return `sb-${prefix}-${Date.now().toString(36)}-${suffix}`
}

/**
 * Validate a caller-supplied correlation id.
 *
 * @param value - candidate id.
 * @returns true when the id is a plausible, log-safe token.
 */
export function isTraceId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{6,128}$/.test(value)
}
