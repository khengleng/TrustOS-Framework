/**
 * Shared types — TrustOS Telegram Mini App.
 *
 * The shapes the API returns and the admin consumes. One definition, imported by both, so a
 * renamed field is a compile error rather than an empty column.
 *
 * Runtime-free by design: no imports, no side effects, nothing that could pull a server-only
 * module into a browser bundle. The admin application imports this package directly, so anything
 * reachable from here reaches the client.
 */

/** ISO-8601 timestamp as it crosses the API boundary. */
export type IsoDateTime = string;

/** Fields every tenant-owned entity exposes. */
export interface TenantOwnedSummary {
  id: string;
  organizationId: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Somebody who opened the mini app. `platformUserId` is the id the platform gave them and it is */
/** opaque — it is not an email, it is not stable across platforms, and it must not be used as a */
/** display name. */
export interface MiniAppUser {
  id: string;
  platform: 'TELEGRAM' | 'WHATSAPP' | 'MESSENGER';
  platformUserId: string;
  userId: string | null;
  displayName: string;
  languageCode: string;
  status: 'ACTIVE' | 'BLOCKED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A verified sign-in. Short-lived by design: a mini app session that outlives the chat it was */
/** opened from is a session nobody can revoke from the app. */
export interface MiniAppSession {
  id: string;
  miniAppUserId: string;
  startedAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  launchParam: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A named entry point. The `target` is resolved against a whitelist rather than redirected to — */
/** an open redirect inside a messaging client is a phishing primitive with the platform’s */
/** branding on it. */
export interface DeepLink {
  id: string;
  code: string;
  label: string;
  target: string;
  isActive: boolean;
  openCount: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** One item in the mini app menu. Filtered by permission before it is sent. */
export interface MenuEntry {
  id: string;
  label: string;
  href: string;
  icon: string | null;
  position: number;
  requiredPermission: string | null;
  isActive: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** What a user has muted. Security notifications ignore this — see @trustos/template-sdk. */
export interface MiniAppNotificationSetting {
  id: string;
  miniAppUserId: string;
  notificationKey: string;
  muted: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
