import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from '@trustos/errors';

/**
 * Webhook signing.
 *
 * The receiver has one question: did this really come from us, and is it recent? Everything here
 * exists to let them answer it, and each decision is one that has been got wrong in a widely-used
 * product at some point.
 *
 * **The timestamp is inside the signed payload.** Signing only the body lets an attacker who
 * captured one delivery replay it forever — the signature stays valid because the body has not
 * changed. Signing `timestamp.body` means changing the timestamp breaks the signature, so a
 * receiver can reject anything older than their tolerance and know the timestamp is authentic.
 *
 * **Comparison is constant-time.** `===` on a signature leaks, through timing, how many leading
 * bytes were right. That is a practical attack given enough requests, and `timingSafeEqual` costs
 * nothing to use.
 *
 * **Several signatures per delivery.** During a rotation, the request is signed with both the old
 * and the new secret. Without that, rotation means either coordinating a deployment with every
 * receiver simultaneously or accepting a window of rejected deliveries — and in practice it means
 * nobody ever rotates.
 *
 * The format is deliberately close to what receivers already recognise from Stripe and GitHub:
 *
 *     X-TrustOS-Signature: t=1753900000,v1=5257a8...,v1=9f2b41...
 *     X-TrustOS-Event: identity.user.created
 *     X-TrustOS-Delivery: dlv_01HZ...
 *
 * A bespoke scheme would mean every integrator writes verification from scratch, and the ones
 * who get it wrong get it wrong in the direction of accepting forgeries.
 */

export const SIGNATURE_HEADER = 'x-trustos-signature';
export const EVENT_HEADER = 'x-trustos-event';
export const DELIVERY_HEADER = 'x-trustos-delivery';
export const TIMESTAMP_HEADER = 'x-trustos-timestamp';

/** The signature scheme version. Bumped only if the algorithm changes; `v1` is HMAC-SHA256. */
export const SIGNATURE_VERSION = 'v1';

/**
 * How stale a delivery may be, in seconds.
 *
 * Five minutes. Long enough for clock skew and a slow network, short enough that a captured
 * request is not a lasting credential. A receiver may choose to be stricter and cannot usefully
 * be much looser.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** Generates a secret. 32 bytes, hex — 256 bits of entropy, and safe in a header or an env var. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('hex')}`;
}

/**
 * The string that gets signed.
 *
 * `${timestamp}.${body}`. The separator matters: without it, a timestamp of `1753900000` with
 * body `1` and a timestamp of `175390000` with body `01` would produce the same signed string,
 * and two different deliveries sharing a signature is exactly the ambiguity a signature exists to
 * remove.
 */
export function signingPayload(timestamp: number, body: string): string {
  return `${timestamp}.${body}`;
}

export function computeSignature(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(signingPayload(timestamp, body)).digest('hex');
}

/**
 * Builds the header value.
 *
 * `secrets` is ordered with the active secret first. During a rotation it holds two, so a
 * receiver that has updated and one that has not both verify successfully.
 */
export function buildSignatureHeader(
  secrets: readonly string[],
  timestamp: number,
  body: string,
): string {
  if (secrets.length === 0) {
    throw ApiError.internal('A webhook cannot be signed with no secret.');
  }

  const signatures = secrets.map(
    (secret) => `${SIGNATURE_VERSION}=${computeSignature(secret, timestamp, body)}`,
  );

  return [`t=${timestamp}`, ...signatures].join(',');
}

export interface ParsedSignatureHeader {
  timestamp: number;
  signatures: string[];
}

/**
 * Parses a signature header.
 *
 * Returns null rather than throwing on anything malformed. A receiver's verification path is
 * reachable by anybody who knows the URL, and an exception thrown from parsing untrusted input is
 * a denial of service if it escapes — so every failure here is the same boring "does not verify".
 */
export function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  if (typeof header !== 'string' || header.length > 4096) return null;

  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key === 't') {
      // Base 10 explicitly. `parseInt` without a radix has surprised people for decades.
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === SIGNATURE_VERSION) {
      if (/^[0-9a-f]{64}$/.test(value)) signatures.push(value);
    }
    // An unknown key is ignored rather than rejected, so adding `v2=` later does not break a
    // receiver still reading `v1`.
  }

  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

export interface VerifyOptions {
  /** The raw body **exactly** as received. See `verifySignature`. */
  body: string;
  header: string;
  /** Every secret currently valid for the endpoint: active, plus a previous one mid-rotation. */
  secrets: readonly string[];
  toleranceSeconds?: number;
  now?: () => number;
}

export type VerificationResult =
  { valid: true; timestamp: number } | { valid: false; reason: VerificationFailure };

export type VerificationFailure =
  | 'malformed_header'
  | 'timestamp_too_old'
  | 'timestamp_in_future'
  | 'signature_mismatch'
  | 'no_secrets';

/**
 * Verifies a delivery. This is what a receiver runs, and what the framework's own tests run.
 *
 * **The body must be the raw bytes as received.** Not the object, and not a re-serialization of
 * it: `JSON.parse` followed by `JSON.stringify` can reorder keys, change number formatting and
 * alter unicode escapes, and any of those changes the hash. This is the single most common reason
 * a correct implementation reports every signature as invalid, so a receiving framework needs its
 * raw-body option turned on — see `docs/webhooks.md`.
 */
export function verifySignature(options: VerifyOptions): VerificationResult {
  if (options.secrets.length === 0) return { valid: false, reason: 'no_secrets' };

  const parsed = parseSignatureHeader(options.header);
  if (!parsed) return { valid: false, reason: 'malformed_header' };

  const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const age = now - parsed.timestamp;

  if (age > tolerance) return { valid: false, reason: 'timestamp_too_old' };

  /*
   * A timestamp from the future is also rejected, allowing for clock skew.
   *
   * Without this check, a forged far-future timestamp would never expire — the replay window
   * would be open until that date arrives. The allowance is the same tolerance, because the
   * cause is nearly always an unsynchronised clock rather than an attack.
   */
  if (age < -tolerance) return { valid: false, reason: 'timestamp_in_future' };

  const expected = options.secrets.map((secret) =>
    computeSignature(secret, parsed.timestamp, options.body),
  );

  /*
   * Every candidate is compared, with no early exit.
   *
   * Returning on the first match would make verification time depend on which secret matched,
   * which leaks whether the sender is on the old secret or the new one during a rotation. Minor,
   * but the cost of not leaking it is one boolean.
   */
  let matched = false;
  for (const candidate of expected) {
    for (const provided of parsed.signatures) {
      if (constantTimeEquals(candidate, provided)) matched = true;
    }
  }

  if (!matched) return { valid: false, reason: 'signature_mismatch' };
  return { valid: true, timestamp: parsed.timestamp };
}

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak the length — so the
 * lengths are compared first and the result folded in, rather than returned early.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');

  if (bufferA.length !== bufferB.length) {
    // Still does the work, so a wrong-length signature does not return measurably faster than a
    // right-length wrong one.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }

  return timingSafeEqual(bufferA, bufferB);
}

/** Human-readable failure reasons, for the delivery log and for the docs. */
export const VERIFICATION_FAILURE_REASONS: Record<VerificationFailure, string> = {
  malformed_header: 'The signature header is missing, truncated or not in the expected format.',
  timestamp_too_old:
    'The delivery is older than the tolerance window. This is usually a replayed request, or a ' +
    'clock that is behind.',
  timestamp_in_future:
    'The timestamp is further ahead than clock skew explains. Check the sending clock.',
  signature_mismatch:
    'The signature does not match. The usual cause is verifying against a re-serialized body ' +
    'rather than the raw bytes received.',
  no_secrets: 'No signing secret is configured for this endpoint.',
};
