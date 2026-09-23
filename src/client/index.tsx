/**
 * StarBridge — browser half.
 *
 * The shell loads this bundle because the package declares `dsh.client`, and
 * this `apply` is where the plugin claims its UI seats:
 *
 * | Slot | Cell | What it renders |
 * |---|---|---|
 * | `main` | `starbridge` | the StarBridge conversation panel (central panel, dispatched by sidebar entry id) |
 * | `settings.section` | `starbridge` | the "星桥 StarBridge" settings page |
 * | `conversation.chat.assistant-actions` | `starbridge-feedback` | feedback / correction actions under a finalized assistant message |
 *
 * Registration happens inside `ctx.slots.inject`, so this plugin waits for the
 * shell to declare those slots and loses its seats cleanly if it ever collapses
 * them — the shell's contract for a client plugin, and one less assumption about
 * boot order.
 *
 * Nothing here talks to the company gateway. Every call goes to this plugin's own
 * host routes (`/starbridge/api/*`), which is what keeps the access token out of
 * the browser entirely.
 *
 * @module @company/dsh-starbridge-client/client
 */

import type { Context } from '@deepseek-ai/cordis'

import { ChatPanel } from './ChatPanel.tsx'
import { FeedbackBar } from './FeedbackBar.tsx'
import { SettingsPanel } from './SettingsPanel.tsx'
import type { SlotRegistrationOptions } from './types.ts'

/**
 * Register one component into a slot.
 *
 * The shell composes four "shares" of props (runtime, child-render, store, and
 * business) whose types live in the harness source tree and are not published to
 * npm. The components above declare only the props they actually read (a
 * `messageId`, a `sessionId`, a `close`), so this helper erases that one
 * boundary in a single documented place instead of scattering casts through the
 * plugin, and it keeps each registration readable at the call site.
 *
 * @param ctx - the plugin's context.
 * @param options - slot key, cell key, order, and props factory.
 * @param component - the React component to mount.
 * @returns the registration disposer (also owned by the calling fiber).
 */
function registerSlot(
  ctx: Context,
  options: SlotRegistrationOptions,
  component: (props: never) => unknown,
): () => void {
  return ctx.slots.register(options, component as unknown as (props: never) => unknown)
}

/**
 * Browser-half plugin body.
 *
 * @param ctx - the client context provided by the shell.
 */
export function apply(ctx: Context): void {
  ctx.inject(['slots'], (scoped) => {
    // The StarBridge panel is a central panel, reached from the sidebar. Using
    // our own key leaves the reserved `conversation` cell to DSH's Conversation.
    scoped.slots.inject('main', () => registerSlot(
      scoped,
      { name: 'main', id: 'starbridge', order: 20 },
      ChatPanel as unknown as (props: never) => unknown,
    ))

    scoped.slots.inject('settings.section', () => registerSlot(
      scoped,
      { name: 'settings.section', id: 'starbridge', order: 60, label: () => '星桥 StarBridge' },
      SettingsPanel as unknown as (props: never) => unknown,
    ))

    // The chat panel renders its own feedback bar for StarBridge answers with a
    // live conversation id; this seat covers every OTHER finalized assistant
    // message, so a user can push a correction into the StarBridge review queue
    // without leaving the DSH Conversation.
    scoped.slots.inject('conversation.chat.assistant-actions', () => registerSlot(
      scoped,
      { name: 'conversation.chat.assistant-actions', id: 'starbridge-feedback', order: 30 },
      FeedbackBar as unknown as (props: never) => unknown,
    ))

    ctx.logger.info('starbridge: client half loaded (main, settings.section, assistant-actions)')
  })
}
