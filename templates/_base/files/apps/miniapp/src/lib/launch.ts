/**
 * Mini app launch and verification.
 *
 * A messaging client opens the mini app with a signed payload describing who opened it. Every
 * platform does this differently — Telegram signs `initData` with an HMAC derived from the bot
 * token, Meta signs a request with an app secret — and every platform's payload is
 * **attacker-controlled until it has been verified**.
 *
 * Two rules follow, and they are the reason this file exists rather than each screen reading the
 * payload for itself.
 *
 * **Verification happens on the server, never here.** The secret that verifies a signature is the
 * one that can also forge it; a browser bundle containing it has published it. What the browser
 * does is *forward* the raw payload to the API and receive a session back. If you find yourself
 * wanting to check a signature in this file, the answer is that the check belongs behind
 * `POST /api/miniapp/sessions`.
 *
 * **The payload is never trusted for identity.** The display name in `initData` is whatever the
 * user set, the id is opaque, and neither means anything until the server has verified the
 * signature and issued a session. Rendering a name from the unverified payload is how a mini app
 * greets somebody by an attacker-chosen name.
 *
 * The platform is a *parameter*, not a branch: the same shape serves Telegram, WhatsApp and
 * Messenger, and the difference between them is one server-side verifier.
 */

export type MiniAppPlatform = 'TELEGRAM' | 'WHATSAPP' | 'MESSENGER';

export const PLATFORM: MiniAppPlatform =
  (process.env.NEXT_PUBLIC_MINIAPP_PLATFORM as MiniAppPlatform | undefined) ?? 'TELEGRAM';

/** A verified session, as the API returns it. Nothing here is client-supplied. */
export interface MiniAppSession {
  sessionId: string;
  miniAppUserId: string;
  displayName: string;
  languageCode: string;
  /** Where the launch link pointed. Resolved against a whitelist server-side — see below. */
  launchTarget: string | null;
  expiresAt: string;
}

/**
 * The raw payload the messaging client handed us.
 *
 * Read from the platform's injected global when there is one, and from the URL fragment
 * otherwise. Returns null when the app was opened outside a messaging client, which is a normal
 * thing to happen — a developer with the URL in a browser tab — and should render a "open this
 * from the app" screen rather than an error.
 */
export function readLaunchPayload(): string | null {
  if (typeof window === 'undefined') return null;

  const injected = (window as unknown as { Telegram?: { WebApp?: { initData?: string } } }).Telegram
    ?.WebApp?.initData;

  if (injected) return injected;

  const fragment = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;

  const params = new URLSearchParams(fragment);
  return params.get('payload') ?? params.get('signed_request') ?? null;
}

/**
 * The deep-link code the app was opened with.
 *
 * A *code*, not a URL. The server resolves it against the DeepLink table and returns a target
 * path — so a link can be retired, counted and audited, and so a crafted link cannot send a user
 * anywhere the product did not publish. Accepting a URL here instead would be an open redirect
 * inside a messaging client, which is a phishing primitive wearing the platform's branding.
 */
export function readLaunchCode(): string | null {
  if (typeof window === 'undefined') return null;

  const code = new URLSearchParams(window.location.search).get('start');

  // Codes are slugs. Anything else is discarded rather than sent on, because a value that
  // cannot be a code is a value somebody constructed.
  return code && /^[a-z0-9][a-z0-9-]{0,63}$/.test(code) ? code : null;
}

/**
 * Exchanges the launch payload for a session.
 *
 * The whole handshake is this one call. Whatever the platform, the browser's job is to forward
 * the payload and hold the session it gets back.
 */
export async function startSession(apiBaseUrl: string): Promise<MiniAppSession | null> {
  const payload = readLaunchPayload();
  if (!payload) return null;

  const response = await fetch(`${apiBaseUrl}/miniapp/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ platform: PLATFORM, payload, launchCode: readLaunchCode() }),
  });

  // A rejected payload is the expected answer for an expired or forged launch, not an
  // exception. The caller renders "open this from the app again".
  if (!response.ok) return null;

  return (await response.json()) as MiniAppSession;
}
