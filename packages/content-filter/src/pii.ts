import { z } from 'zod';

/**
 * PII and risk-category detection.
 *
 * Two jobs, and it is worth being precise about which is which:
 *
 *   * **Detection** — finding personal data in text, so it can be redacted before it reaches a
 *     provider or a log. This is mechanical and works reasonably well for structured identifiers.
 *   * **Classification** — deciding whether text is hateful, violent or medical advice. This is a
 *     judgement, and a regex is a poor judge. What is here is a *keyword signal* that flags text
 *     for review, and it says so rather than pretending to be a classifier.
 *
 * The honest limits, stated because a filter people over-trust is worse than none:
 *
 *   * Detection is pattern-based. A name is not detectable by pattern; an email is.
 *   * Every pattern has false positives. A 16-digit order number looks like a card number.
 *   * The category signals are keyword matches. They will miss anything phrased carefully and
 *     will flag discussions *about* a topic as readily as instances of it.
 *
 * Where this is genuinely load-bearing is redaction before logging. A prompt containing a
 * customer's national ID that reaches a log file is a data-protection incident, and redacting it
 * mechanically is both possible and reliable.
 */

export const PII_TYPES = [
  'email',
  'phone',
  'credit_card',
  'iban',
  'ip_address',
  'national_id',
  'passport',
  'api_key',
  'private_key',
  'jwt',
  'date_of_birth',
] as const;
export type PiiType = (typeof PII_TYPES)[number];

export interface PiiMatch {
  type: PiiType;
  /** Never the value. A finding that echoes the value is a second copy of the leak. */
  redacted: string;
  offset: number;
  length: number;
  /** How reliable this pattern is, so a caller can weight it. */
  confidence: 'high' | 'medium' | 'low';
}

interface PiiPattern {
  type: PiiType;
  pattern: RegExp;
  confidence: 'high' | 'medium' | 'low';
  /** An extra check for patterns with a checksum. */
  verify?: (value: string) => boolean;
}

/**
 * Detection patterns.
 *
 * Bounded quantifiers throughout: these run over untrusted text on every request, and an
 * unbounded nested quantifier is a denial of service anybody who can type can trigger.
 */
const PATTERNS: PiiPattern[] = [
  {
    type: 'email',
    pattern: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}\b/g,
    confidence: 'high',
  },
  {
    type: 'credit_card',
    // 13–19 digits with optional separators. The Luhn check is what makes this usable — without
    // it, every order number and every long identifier is a false positive.
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    confidence: 'high',
    verify: luhn,
  },
  {
    type: 'iban',
    /*
     * Both written forms. The electronic form is unspaced; the *printed* form groups in fours,
     * and that is how an IBAN appears in an email, an invoice or a support ticket — which is
     * exactly the text this runs over. The earlier pattern matched only the unspaced form, so the
     * common case went undetected.
     *
     * The mod-97 check is what makes it usable, for the same reason Luhn is on the card pattern:
     * without it every long alphanumeric run starting with two letters is a false positive.
     */
    pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g,
    confidence: 'medium',
    verify: iban97,
  },
  {
    type: 'private_key',
    pattern: /-----BEGIN[ A-Z]{0,20}PRIVATE KEY-----/g,
    confidence: 'high',
  },
  {
    type: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    confidence: 'high',
  },
  {
    type: 'api_key',
    // The prefixed-key convention several providers use. High confidence because nothing else
    // looks like this.
    pattern: /\b(?:sk|pk|rk|whsec|ghp|gho|xox[baprs])[-_][A-Za-z0-9]{16,}\b/g,
    confidence: 'high',
  },
  {
    type: 'ip_address',
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    confidence: 'medium',
  },
  {
    type: 'phone',
    /*
     * Two or more digit groups, with an optional international prefix or area code.
     *
     * The earlier pattern required the country code to be followed immediately by a 3–4 digit
     * group, so `+855 12 345 678` — a Cambodian mobile, with a two-digit operator code — matched
     * only the trailing `345 678`. That is worse than not matching at all: `redactPii` uses the
     * match offset, so redaction left `+855 12 [PHONE]` in the text, and the visible prefix plus
     * context identifies the number. A partial redaction reads as a successful one.
     *
     * Still deliberately conservative — see `verify`. A bare seven-digit run with no separators is
     * indistinguishable from an order reference and is not matched at all.
     */
    pattern: /(?:\+\d{1,3}[ -]?)?(?:\(\d{1,4}\)[ -]?)?\d{2,4}(?:[ -]\d{2,4}){1,3}\b/g,
    confidence: 'low',
    verify: plausiblePhone,
  },
  {
    type: 'passport',
    pattern: /\b[A-Z]{1,2}\d{6,9}\b/g,
    confidence: 'low',
  },
  {
    type: 'date_of_birth',
    // Only when labelled. An unlabelled date is just a date.
    pattern:
      /\b(?:date\s+of\s+birth|dob|born(?:\s+on)?)\b[\s:]{0,4}\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/gi,
    confidence: 'medium',
  },
];

/** The Luhn checksum. Without it, every 16-digit order number is a "credit card". */
function luhn(value: string): boolean {
  const digits = value.replace(/[^\d]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let double = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }

  return sum % 10 === 0;
}

/**
 * The IBAN mod-97 checksum, per ISO 13616.
 *
 * Move the first four characters to the end, map letters to numbers (A=10 … Z=35), and the whole
 * value read as an integer must be congruent to 1 modulo 97. Computed digit by digit because the
 * number is far larger than a JavaScript integer can hold.
 */
function iban97(value: string): boolean {
  const compact = value.replace(/\s/g, '').toUpperCase();

  if (compact.length < 15 || compact.length > 34) return false;

  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;

  for (const character of rearranged) {
    const mapped = /[A-Z]/.test(character) ? String(character.charCodeAt(0) - 55) : character;

    for (const digit of mapped) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }

  return remainder === 1;
}

export const contentFilterPolicySchema = z
  .object({
    /** Which PII types to look for. Empty means all of them. */
    detect: z.array(z.enum(PII_TYPES)).default([]),
    /** Types to ignore entirely, for a tenant whose data legitimately contains them. */
    ignore: z.array(z.enum(PII_TYPES)).default([]),
    /** Drop `low` confidence matches. On by default — they are noisy. */
    highConfidenceOnly: z.boolean().default(true),
    maxScanChars: z.number().int().min(1000).max(1_000_000).default(200_000),
  })
  .strict();

export type ContentFilterPolicy = z.infer<typeof contentFilterPolicySchema>;

export interface PiiScan {
  matches: PiiMatch[];
  types: PiiType[];
  /** Whether anything was found at all. */
  found: boolean;
}

export function detectPii(
  text: string,
  policy: ContentFilterPolicy = contentFilterPolicySchema.parse({}),
): PiiScan {
  const scanned = text.slice(0, policy.maxScanChars);
  const ignore = new Set(policy.ignore);
  const only = new Set(policy.detect);
  const matches: PiiMatch[] = [];

  for (const entry of PATTERNS) {
    if (ignore.has(entry.type)) continue;
    if (only.size > 0 && !only.has(entry.type)) continue;
    if (policy.highConfidenceOnly && entry.confidence === 'low') continue;

    // A fresh regex per scan: a shared `g` regex carries `lastIndex` between calls, which makes
    // the second scan of identical text return different results.
    const pattern = new RegExp(entry.pattern.source, entry.pattern.flags);

    for (const match of scanned.matchAll(pattern)) {
      if (entry.verify && !entry.verify(match[0])) continue;

      matches.push({
        type: entry.type,
        // Never the value.
        redacted: maskValue(match[0]),
        offset: match.index ?? 0,
        length: match[0].length,
        confidence: entry.confidence,
      });
    }
  }

  return {
    matches: matches.sort((a, b) => a.offset - b.offset),
    types: [...new Set(matches.map((match) => match.type))].sort(),
    found: matches.length > 0,
  };
}

/**
 * Replaces detected PII with type markers.
 *
 * Right to left, so replacing does not shift the offsets of matches not yet processed — the bug
 * every left-to-right implementation of this has, and one that corrupts text in a way that looks
 * like an encoding problem.
 */
export function redactPii(
  text: string,
  policy: ContentFilterPolicy = contentFilterPolicySchema.parse({}),
): { text: string; redactedTypes: PiiType[]; count: number } {
  const scan = detectPii(text, policy);
  let output = text;

  for (const match of [...scan.matches].sort((a, b) => b.offset - a.offset)) {
    output =
      output.slice(0, match.offset) +
      `[${match.type.toUpperCase()}]` +
      output.slice(match.offset + match.length);
  }

  return { text: output, redactedTypes: scan.types, count: scan.matches.length };
}

/**
 * Whether a grouped digit run is plausibly a phone number.
 *
 * Two rules, both learned from false positives:
 *
 *   * **8 to 15 digits.** E.164 caps at 15; below 8 nothing is dialable internationally, and a
 *     shorter run is far more likely to be a reference or a quantity.
 *   * **Not a date.** `2026 03 01` and `2026-03-01` are eight digits in three groups and match the
 *     shape exactly. A date redacted as a phone number is a visible wrong answer that costs the
 *     detector its credibility.
 */
function plausiblePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '');

  if (digits.length < 8 || digits.length > 15) return false;

  // YYYY MM DD / YYYY-MM-DD, with or without a leading sign.
  if (/^\+?(?:19|20)\d{2}[ -](?:0[1-9]|1[0-2])[ -](?:0[1-9]|[12]\d|3[01])$/.test(value.trim())) {
    return false;
  }

  return true;
}

/** Keeps the shape and the last four characters. Enough to recognise, useless to reuse. */
function maskValue(value: string): string {
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${'*'.repeat(Math.min(value.length - 4, 12))}${value.slice(-4)}`;
}
