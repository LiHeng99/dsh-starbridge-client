/**
 * Sign-in helper shared by the chat panel and the settings panel.
 *
 * OIDC needs a real top-level navigation, so the host hands the browser an
 * authorization URL and this module opens it. A popup is preferred (the user
 * keeps their DSH session and scroll position); a blocked popup falls back to a
 * normal tab, which is why the callback page says "close this tab and return to
 * DSH".
 *
 * @module dsh-starbridge-client/client/login
 */

import { starBridgeApi, StarBridgeClientError } from './api.ts'

/** Outcome of a sign-in attempt, for the caller to render. */
export type LoginOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string; readonly hint?: string }

/** Listener installed while a popup sign-in is in flight. */
let popupListener: ((event: MessageEvent) => void) | null = null

/**
 * Start the interactive sign-in flow.
 *
 * @returns the outcome: whether the URL was opened, with a reason when not.
 */
export async function startLogin(): Promise<LoginOutcome> {
  try {
    const { authorizeUrl } = await starBridgeApi.beginLogin()

    const popup = window.open(authorizeUrl, 'starbridge-login', 'width=520,height=680,noopener=no')
    if (popup === null || popup.closed) {
      // A blocked popup is not a failure: the user can complete the flow in a
      // tab, and the callback page tells them to come back here.
      window.open(authorizeUrl, '_blank', 'noopener,noreferrer')
      return { ok: true }
    }

    // The callback page cannot post into a cross-origin opener reliably, so the
    // popup is observed rather than messaged: poll until it closes.
    if (popupListener !== null) window.removeEventListener('message', popupListener)
    popupListener = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      const data: unknown = event.data
      if (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'starbridge-login-complete') {
        popup.close()
      }
    }
    window.addEventListener('message', popupListener)
    return { ok: true }
  } catch (error) {
    if (error instanceof StarBridgeClientError) {
      return {
        ok: false,
        message: error.message,
        ...(error.hint === undefined ? {} : { hint: error.hint }),
      }
    }
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Best-effort sign-in start used when a call failed for lack of a session.
 *
 * The caller has already shown the error, so this only opens the browser flow
 * and swallows its own failure.
 */
export function openLoginWindow(): void {
  void startLogin()
}

/**
 * Whether the sign-in popup is still open.
 *
 * @param popup - the window handle returned by `window.open`.
 * @returns true while the popup exists and has not been closed.
 */
export function isPopupOpen(popup: Window | null): boolean {
  return popup !== null && popup.closed === false
}
