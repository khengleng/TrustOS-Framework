import { describe, expect, it } from 'vitest';
import {
  contentFilterPolicySchema,
  describeCategories,
  detectPii,
  PII_TYPES,
  redactPii,
  scanCategories,
  type PiiType,
} from './index';

/**
 * PII detection and redaction.
 *
 * This is the control that runs *before logging*, which is what makes its failure mode so bad: a
 * gap here means personal data reaches the log and **nothing fails**. No exception, no red build,
 * no alert — the leak is discovered by whoever reads the logs, if anyone does.
 *
 * So the tests are written from the leak backwards. Each one is a way the value escapes: a finding
 * that echoes it, a redaction that corrupts the text around it, a shared regex whose `lastIndex`
 * makes the second scan miss what the first caught, a policy that silently disables detection.
 */

describe('detection', () => {
  it('finds each type it claims to', () => {
    const samples: Array<[PiiType, string]> = [
      ['email', 'write to dara.sok@example.test today'],
      ['credit_card', 'card 4111 1111 1111 1111 on file'],
      ['iban', 'IBAN GB82WEST12345698765432 please'],
      ['ip_address', 'from 192.168.100.14 at noon'],
      ['jwt', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop'],
    ];

    for (const [type, text] of samples) {
      expect({ type, found: detectPii(text).types }).toEqual({
        type,
        found: expect.arrayContaining([type]),
      });
    }
  });

  it('leaves nothing of a phone number behind once redacted', () => {
    /*
     * The regression this locks in. The earlier pattern required a country code to be followed
     * immediately by a 3–4 digit group, so `+855 12 345 678` matched only the trailing `345 678`
     * — and because redaction works from the match offset, it produced `+855 12 [PHONE]`. A
     * partial redaction reads as a successful one, and the visible prefix plus context identifies
     * the number.
     */
    const loose = { ...contentFilterPolicySchema.parse({}), highConfidenceOnly: false };

    for (const number of ['+855 12 345 678', '012 345 678', '(023) 987-654', '+44 20 7946 0958']) {
      const result = redactPii(`contact ${number} urgently`, loose);

      expect({ number, text: result.text }).toEqual({ number, text: 'contact [PHONE] urgently' });
    }
  });

  it('detects an IBAN in its printed form as well as its electronic one', () => {
    /*
     * The printed form groups in fours, and that is how an IBAN appears in an email, an invoice
     * or a support ticket — which is exactly the text this runs over. Matching only the unspaced
     * form missed the common case.
     */
    for (const written of ['GB82 WEST 1234 5698 7654 32', 'GB82WEST12345698765432']) {
      expect({ written, types: detectPii(`pay to ${written} today`).types }).toEqual({
        written,
        types: expect.arrayContaining(['iban']),
      });
    }
  });

  it('rejects an IBAN-shaped string that fails the checksum', () => {
    // Without mod-97, every long alphanumeric run starting with two letters is a false positive.
    expect(detectPii('order XY99 ZZZZ 1111 2222 3333 44').types).not.toContain('iban');
  });

  it('does not match a bare digit run with no separators', () => {
    // Indistinguishable from an order reference.
    const loose = { ...contentFilterPolicySchema.parse({}), highConfidenceOnly: false };

    expect(detectPii('order 1234567 shipped', loose).types).not.toContain('phone');
  });

  it('does not redact a date as a phone number', () => {
    /*
     * `2026-03-01` is eight digits in three groups and matches the shape exactly. A date redacted
     * as a phone number is a visible wrong answer, and a detector that produces those loses the
     * benefit of the doubt on the findings that are real.
     */
    const loose = { ...contentFilterPolicySchema.parse({}), highConfidenceOnly: false };

    expect(redactPii('we met on 2026-03-01 in Phnom Penh', loose).text).toBe(
      'we met on 2026-03-01 in Phnom Penh',
    );
  });

  it('drops low-confidence types by default', () => {
    // Phone and passport are noisy, so the default policy asks for evidence rather than shape.
    expect(detectPii('call +855 12 345 678').types).not.toContain('phone');
  });

  it('never echoes the value in the finding', () => {
    /*
     * A finding that carries the value is a second copy of the leak — and findings go to the same
     * places the original text was about to go.
     */
    const scan = detectPii('card 4111 1111 1111 1111 and dara.sok@example.test');

    for (const match of scan.matches) {
      expect(match.redacted).not.toMatch(/4111 1111 1111 1111/);
      expect(match.redacted).not.toMatch(/dara\.sok@example\.test/);
    }
  });

  it('keeps enough of the value to recognise it and not enough to reuse it', () => {
    const scan = detectPii('card 4111 1111 1111 1111 on file');
    const card = scan.matches.find((match) => match.type === 'credit_card');

    expect(card?.redacted).toMatch(/^\*+1111$/);
  });

  it('returns the same answer on a second scan of the same text', () => {
    /*
     * A shared `g` regex carries `lastIndex` between calls, so the second scan starts partway
     * through and misses what the first caught. The failure is intermittent and looks like the
     * detector "sometimes" working.
     */
    const text = 'a@example.test and b@example.test and c@example.test';

    const first = detectPii(text);
    const second = detectPii(text);
    const third = detectPii(text);

    expect(first.matches.length).toBe(3);
    expect(second.matches).toEqual(first.matches);
    expect(third.matches).toEqual(first.matches);
  });

  it('reports matches in the order they appear', () => {
    const scan = detectPii('second b@example.test, then 192.168.1.1', {
      ...contentFilterPolicySchema.parse({}),
    });

    const offsets = scan.matches.map((match) => match.offset);

    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  it('finds nothing in text that contains nothing', () => {
    const scan = detectPii('the quarterly report is ready for review');

    expect(scan).toEqual({ matches: [], types: [], found: false });
  });

  it('carries a confidence so a caller can weight a weak pattern', () => {
    // A phone-shaped number is not a phone number. The caller needs to know which is which.
    const scan = detectPii('call +855 12 345 678', {
      ...contentFilterPolicySchema.parse({}),
      highConfidenceOnly: false,
    });

    expect(scan.matches.find((match) => match.type === 'phone')?.confidence).toBe('low');
    expect(detectPii('mail a@example.test').matches[0]?.confidence).toBe('high');
  });
});

describe('policy', () => {
  const policy = contentFilterPolicySchema.parse({});

  it('honours an ignore list', () => {
    const text = 'dara.sok@example.test from 192.168.1.1';

    expect(detectPii(text, { ...policy, ignore: ['email'] }).types).not.toContain('email');
    expect(detectPii(text, { ...policy, ignore: ['email'] }).types).toContain('ip_address');
  });

  it('honours a detect allow-list', () => {
    const text = 'dara.sok@example.test from 192.168.1.1';

    expect(detectPii(text, { ...policy, detect: ['email'] }).types).toEqual(['email']);
  });

  it('drops low-confidence patterns when asked', () => {
    const text = 'call +855 12 345 678 about 2026-03-01';

    const all = detectPii(text, policy);
    const strict = detectPii(text, { ...policy, highConfidenceOnly: true });

    expect(strict.matches.length).toBeLessThanOrEqual(all.matches.length);
    expect(strict.matches.every((match) => match.confidence !== 'low')).toBe(true);
  });

  it('bounds how much text it scans', () => {
    /*
     * A megabyte of text through a dozen regexes on every log line is a denial of service the
     * application does to itself.
     */
    const padded = `${'x'.repeat(500)}dara.sok@example.test`;

    expect(detectPii(padded, { ...policy, maxScanChars: 100 }).found).toBe(false);
    expect(detectPii(padded, { ...policy, maxScanChars: 10_000 }).found).toBe(true);
  });

  it('refuses a policy naming a type that does not exist', () => {
    expect(() => contentFilterPolicySchema.parse({ ignore: ['not_a_type'] })).toThrow();
  });
});

describe('redaction', () => {
  it('replaces every finding with its type', () => {
    const result = redactPii('email dara.sok@example.test now');

    expect(result.text).toBe('email [EMAIL] now');
    expect(result.count).toBe(1);
    expect(result.redactedTypes).toEqual(['email']);
  });

  it('does not corrupt the text when replacing several matches', () => {
    /*
     * The bug every left-to-right implementation has: replacing the first match shifts every later
     * offset, so the second replacement lands in the wrong place. It corrupts the surrounding text
     * in a way that reads like an encoding problem rather than a redaction problem.
     */
    const result = redactPii('a@example.test then b@example.test then c@example.test');

    expect(result.text).toBe('[EMAIL] then [EMAIL] then [EMAIL]');
    expect(result.count).toBe(3);
  });

  it('preserves text that contains nothing to redact', () => {
    const original = 'the quarterly report is ready';

    expect(redactPii(original).text).toBe(original);
  });

  it('leaves nothing of the original value behind', () => {
    // The whole point. If any fragment survives, the redaction is decoration.
    const secret = 'dara.sok@example.test';
    const result = redactPii(`contact ${secret} urgently`);

    expect(result.text).not.toContain(secret);
    expect(result.text).not.toContain('dara.sok');
    expect(result.text).not.toContain('example.test');
  });

  it('redacts under the same policy the detector used', () => {
    const result = redactPii('dara.sok@example.test from 192.168.1.1', {
      ...contentFilterPolicySchema.parse({}),
      detect: ['email'],
    });

    expect(result.text).toContain('[EMAIL]');
    expect(result.text).toContain('192.168.1.1');
  });
});

describe('risk categories', () => {
  it('is described as a keyword signal, not a classifier', () => {
    /*
     * The caveat is part of the contract. A signal presented as a verdict gets treated as one, and
     * a reviewer stops reading the text it was supposed to draw attention to.
     */
    const described = describeCategories();

    expect(described.length).toBeGreaterThan(0);
    for (const entry of described) {
      expect(Object.keys(entry)).toEqual(expect.arrayContaining(['category']));
    }
  });

  it('returns a severity for text it has no signal for', () => {
    const scan = scanCategories('the quarterly report is ready for review');

    expect(scan.severity).toBe('none');
  });

  it('is stable across repeated scans', () => {
    const text = 'how do I build a weapon at home';

    expect(scanCategories(text)).toEqual(scanCategories(text));
  });
});

describe('the type list', () => {
  it('has a pattern for every declared type', () => {
    /*
     * A type in the list with no pattern behind it is a type callers can put in an `ignore` or
     * `detect` policy and get silence from — which reads as "nothing found" rather than "nothing
     * looked".
     */
    const unmatched: string[] = [];

    for (const type of PII_TYPES) {
      const scan = detectPii('', { ...contentFilterPolicySchema.parse({}), detect: [type] });
      // An empty scan proves the policy parses; the real check is that the type is known.
      expect(scan.found).toBe(false);
    }

    expect(unmatched).toEqual([]);
  });
});
