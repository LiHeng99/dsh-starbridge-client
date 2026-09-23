/**
 * Feedback recording for StarBridge.
 *
 * Feedback has two destinations and they have different trust levels:
 *
 * - **The local record is the contract.** A like/dislike/correction always lands
 *   in this store, and notifying it goes out on the configured session event, so
 *   other plugins (and the session transcript) can see it even when the gateway
 *   is down.
 * - **Gateway forwarding is best-effort.** A failed forward is reported as
 *   `forwarded: 'failed'` with the reason, never as a thrown error, because
 *   losing a user's correction is the outcome we refuse to have.
 *
 * @module @company/dsh-starbridge-client/feedback-store
 */

import { StarBridgeError } from './errors.ts'
import type { StarBridgeFeedbackRecord, StarBridgeFeedbackResult } from './shared/protocol.ts'

/** Minimal logger surface, so this module never depends on Cordis. */
export interface FeedbackLogger {
  /** Informational line. */
  info(message: string): void
  /** Diagnostic line; never carries a credential. */
  warn(message: string): void
}

/** How a record reached durable storage. */
export type FeedbackStorageKind = 'session-event' | 'memory'

/** Sink that mirrors one record into the DSH session (or a stub in tests). */
export interface FeedbackSessionSink {
  /**
   * Publish one feedback record.
   * @param eventName - the configured event name.
   * @param record - the record to publish.
   * @returns how the record was stored.
   */
  publish(eventName: string, record: StarBridgeFeedbackRecord): FeedbackStorageKind
}

/**
 * Bounded in-memory history of feedback records.
 *
 * The cap keeps a long-lived profile from growing without bound while still
 * giving the settings panel something concrete to show; the durable copy lives
 * in the session log via the sink.
 */
export class FeedbackStore {
  private readonly limit: number
  private readonly eventName: string
  private readonly sink: FeedbackSessionSink
  private readonly logger: FeedbackLogger
  private readonly records: StarBridgeFeedbackRecord[] = []

  /**
   * @param options - configured event name, memory cap, sink, and logger.
   */
  constructor(options: {
    eventName: string
    limit: number
    sink: FeedbackSessionSink
    logger: FeedbackLogger
  }) {
    this.eventName = options.eventName
    this.limit = options.limit
    this.sink = options.sink
    this.logger = options.logger
  }

  /**
   * Record one piece of feedback locally and notify the session.
   *
   * @param record - the feedback to record.
   * @returns the local write outcome (forwarding is the caller's next step).
   * @throws {StarBridgeError} `INVALID_ARGUMENT` when the record cannot be stored.
   * @throws {StarBridgeError} `FEEDBACK_WRITE_FAILED` when the sink refuses it.
   */
  record(record: StarBridgeFeedbackRecord): StarBridgeFeedbackResult {
    if (record.messageId.trim().length === 0) {
      throw new StarBridgeError('INVALID_ARGUMENT', 'starbridge_feedback needs a non-empty messageId.', {
        hint: 'Pass the durable assistant message id (the client supplies it from the assistant-actions slot).',
      })
    }

    let storage: FeedbackStorageKind
    try {
      storage = this.sink.publish(this.eventName, record)
    } catch (cause) {
      throw new StarBridgeError(
        'FEEDBACK_WRITE_FAILED',
        `StarBridge could not append feedback to the session (${String(cause)}).`,
        {
          hint: 'The session event stream refused the record. Retry once; if it keeps failing, report the trace '
            + 'id to the StarBridge maintainers.',
          cause,
        },
      )
    }

    this.records.push(record)
    if (this.records.length > this.limit) this.records.splice(0, this.records.length - this.limit)
    this.logger.info(
      `starbridge: recorded ${record.verdict} feedback for message ${record.messageId} (${storage})`,
    )

    return { recorded: true, storage, forwarded: 'skipped' }
  }

  /**
   * Mark a previously recorded entry as forwarded (or as failed to forward).
   *
   * The stored entry is immutable, so callers get a copy describing the
   * forwarding outcome instead of a mutated record.
   *
   * @param result - the local result to amend.
   * @param outcome - forwarding outcome.
   * @param traceId - correlation id of the attempt.
   * @param detail - failure text, when forwarding failed.
   * @returns the amended result.
   */
  static withForwarding(
    result: StarBridgeFeedbackResult,
    outcome: 'accepted' | 'failed',
    traceId: string | undefined,
    detail?: string,
  ): StarBridgeFeedbackResult {
    return {
      ...result,
      forwarded: outcome,
      ...(traceId === undefined ? {} : { traceId }),
      ...(detail === undefined ? {} : { detail }),
    }
  }

  /**
   * Most recent records, newest first.
   * @param limit - maximum rows to return.
   * @returns the requested window of history.
   */
  recent(limit = 20): StarBridgeFeedbackRecord[] {
    const from = Math.max(0, this.records.length - limit)
    return [...this.records.slice(from)].reverse()
  }

  /** Count of records currently retained. */
  get size(): number {
    return this.records.length
  }

  /** Drop retained history (plugin teardown). */
  clear(): void {
    this.records.length = 0
  }
}
