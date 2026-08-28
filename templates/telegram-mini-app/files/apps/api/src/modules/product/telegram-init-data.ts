import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '@trustos/errors';

/**
 * Telegram Mini App `initData` validation.
 *
 * This is the entire authentication boundary of a Mini App, so it is worth
 * being precise about what the algorithm is and why each step matters.
 *
 * Telegram signs the launch parameters with a key derived from the bot token:
 *
 *   secret_key   = HMAC-SHA256(key = "WebAppData", message = bot_token)
 *   data_check   = every "key=value" pair except `hash`, sorted by key,
 *                  joined with "\n"
 *   expected     = HMAC-SHA256(key = secret_key, message = data_check)
 *
 * The four things that make this safe, each of which has been the subject of a
 * real-world Mini App vulnerability:
 *
 *   1. `hash` is **excluded** from the check string. Including it would make
 *      any hash validate against itself.
 *   2. Pairs are **sorted**, so reordering cannot change the signature.
 *   3. Comparison is **constant-time**. A `===` on a MAC leaks it byte by byte.
 *   4. `auth_date` is **age-checked**. A valid signature is valid forever
 *      otherwise, so a captured launch URL would be a permanent credential.
 */

export interface TelegramUser {
  id: string;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  languageCode: string | null;
  isPremium: boolean;
}

export interface ValidatedInitData {
  user: TelegramUser;
  authDate: Date;
  /** Raw parameters, after signature validation. */
  params: Record<string, string>;
}

export interface ValidateInitDataOptions {
  botToken: string;
  /** How old a launch may be. Defaults to 24 hours. */
  maxAgeSeconds?: number;
  /** Injectable clock, so the age check can be tested without waiting. */
  now?: () => Date;
}

const DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60;

export function validateInitData(
  initData: string,
  options: ValidateInitDataOptions,
): ValidatedInitData {
  if (!initData) {
    throw ApiError.unauthorized('Missing Telegram initData.');
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) {
    throw ApiError.unauthorized('Telegram initData is not signed.');
  }

  // 1. Build the check string from every pair except `hash`, sorted by key.
  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  // 2. Derive the secret and compute the expected signature.
  const secretKey = createHmac('sha256', 'WebAppData').update(options.botToken).digest();
  const expected = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // 3. Constant-time comparison. Both sides are fixed-length hex digests, so
  //    the lengths always match and timingSafeEqual cannot throw.
  if (!safeEquals(expected, hash)) {
    throw ApiError.unauthorized('Telegram initData signature is invalid.', {
      reason: 'initdata_signature_mismatch',
    });
  }

  // 4. Reject a stale launch, so a captured URL is not a permanent credential.
  const authDateSeconds = Number(params.get('auth_date'));
  if (!Number.isFinite(authDateSeconds) || authDateSeconds <= 0) {
    throw ApiError.unauthorized('Telegram initData has no usable auth_date.');
  }

  const now = options.now?.() ?? new Date();
  const ageSeconds = Math.floor(now.getTime() / 1000) - authDateSeconds;
  const maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;

  if (ageSeconds > maxAge) {
    throw ApiError.unauthorized('Telegram initData has expired.', {
      reason: 'initdata_expired',
      ageSeconds,
    });
  }
  // A launch stamped in the future means a clock problem or a forgery attempt;
  // a small skew allowance keeps honest clients working.
  if (ageSeconds < -300) {
    throw ApiError.unauthorized('Telegram initData is stamped in the future.', {
      reason: 'initdata_future',
    });
  }

  return {
    user: parseUser(params.get('user')),
    authDate: new Date(authDateSeconds * 1000),
    params: Object.fromEntries(params.entries()),
  };
}

function parseUser(raw: string | null): TelegramUser {
  if (!raw) throw ApiError.unauthorized('Telegram initData carries no user.');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw ApiError.unauthorized('Telegram initData user is not valid JSON.');
  }

  if (parsed.id === undefined || parsed.id === null) {
    throw ApiError.unauthorized('Telegram initData user has no id.');
  }

  return {
    // Read the id out of the raw JSON *text*, not out of the parsed object.
    //
    // `JSON.parse` turns a numeric id into a double, so anything above
    // 2^53 - 1 is silently rounded before it can be stringified — and the
    // rounded value is a different account. Telegram ids are below that today,
    // but "today" is not a guarantee to build authentication on.
    id: extractRawId(raw, parsed.id),
    firstName: asString(parsed.first_name),
    lastName: asString(parsed.last_name),
    username: asString(parsed.username),
    languageCode: asString(parsed.language_code),
    isPremium: parsed.is_premium === true,
  };
}

/**
 * Recovers the id exactly as Telegram wrote it.
 *
 * Falls back to the parsed value when the id was sent as a JSON string, or
 * when the shape is unexpected — the signature has already been verified at
 * this point, so the payload is well-formed, just possibly formatted
 * differently than we assume.
 */
function extractRawId(rawUserJson: string, parsedId: unknown): string {
  const match = /"id"\s*:\s*"?(\d+)"?/.exec(rawUserJson);
  return match?.[1] ?? String(parsedId);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function safeEquals(a: string, b: string): boolean {
  // Hash both sides so the buffers are always equal length, whatever the
  // caller sent — a length mismatch would otherwise be observable.
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}
