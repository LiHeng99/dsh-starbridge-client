/**
 * The minimal slice of the DSH browser slot service this plugin uses.
 *
 * The shell seeds `@deepseek-ai/dsh-client-ui-slots` as a platform module, but
 * that package publishes no type declarations (its README documents a richer
 * `SlotMap`-typed API that only exists in the harness source tree). Declaring
 * the two members this plugin actually calls keeps the plugin honest about its
 * dependency and independent of the shell's build, exactly as the host half does
 * for the web server.
 *
 * @module @company/dsh-starbridge-client/client/types
 */

import type { Context } from '@deepseek-ai/cordis'

/** Registration options accepted by every slot kind this plugin occupies. */
export interface SlotRegistrationOptions {
  /** Target slot key. */
  name: string
  /**
   * Cell key. Required by `keyed` and `list` slots (`main`,
   * `settings.section`, `conversation.chat.assistant-actions` are all keyed or
   * list kinds).
   */
  id?: string
  /** Ascending position among the slot's entries. */
  order?: number
  /**
   * Display text where the owner projects one (settings navigation rows). A
   * thunk is re-read on every projection, so localized text follows the active
   * locale without re-registering.
   */
  label?: string | (() => string)
  /**
   * Business props factory. The shell merges the returned object into the
   * component's props; a slot whose entry needs nothing declares `() => ({})`.
   */
  inject?: () => Record<string, unknown>
}

/** The browser slot registry service (`ctx.slots`). */
export interface SlotRegistry {
  /**
   * Register one component into a declared slot.
   * @param options - slot key, cell key, order, and props factory.
   * @param component - the React component to mount.
   * @returns a disposer removing the entry; also tied to the caller's fiber.
   */
  register(options: SlotRegistrationOptions, component: unknown): () => void

  /**
   * Install an effect for each declaration lifetime of a slot.
   * @param key - declared slot key to wait for.
   * @param callback - runs once the declaration exists.
   * @returns a disposer for the wait and the active effect.
   */
  inject(key: string, callback: () => (() => void) | (() => void)[]): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Browser slot registry, provided by the DSH web shell. */
    slots: SlotRegistry
  }
}
