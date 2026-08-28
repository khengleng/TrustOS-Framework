import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOLERANCE_SECONDS,
  buildSignatureHeader,
  computeSignature,
  constantTimeEquals,
  generateWebhookSecret,
  parseSignatureHeader,
  signingPayload,
  verifySignature,
} from './signature';

const SECRET = 'whsec_' + 'a'.repeat(64);
const OTHER_SECRET = 'whsec_' + 'b'.repeat(64);
const BODY = '{"id":"evt_1","name":"identity.user.created"}';
const TIMESTAMP = 1_753_900_000;
const NOW = () => TIMESTAMP * 1000;

describe('generateWebhookSecret', () => {
  it('produces 256 bits of entropy with a recognisable prefix', () => {
    const secret = generateWebhookSecret();

    expect(secret).toMatch(/^whsec_[0-9a-f]{64}$/);
  });

  it('never repeats', () => {
    const secrets = new Set(Array.from({ length: 500 }, () => generateWebhookSecret()));

    expect(secrets.size).toBe(500);
  });
});

describe('the signed payload', () => {
  it('separates the timestamp from the body', () => {
    // Without the separator, (t=1753900000, body="1") and (t=175390000, body="01") would produce
    // the same signed string — two different deliveries sharing one signature.
    expect(signingPayload(1_753_900_000, '1')).not.toBe(signingPayload(175_390_000, '01'));
  });

  it('changes the signature when the timestamp changes', () => {
    // This is what makes the timestamp authentic, and therefore what makes replay rejection
    // meaningful rather than advisory.
    expect(computeSignature(SECRET, TIMESTAMP, BODY)).not.toBe(
      computeSignature(SECRET, TIMESTAMP + 1, BODY),
    );
  });

  it('changes the signature when a single byte of the body changes', () => {
    expect(computeSignature(SECRET, TIMESTAMP, BODY)).not.toBe(
      computeSignature(SECRET, TIMESTAMP, `${BODY} `),
    );
  });
});

describe('the header', () => {
  it('carries the timestamp and one signature per secret', () => {
    const header = buildSignatureHeader([SECRET, OTHER_SECRET], TIMESTAMP, BODY);

    expect(header).toMatch(/^t=1753900000,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/);
  });

  it('refuses to sign with no secret', () => {
    expect(() => buildSignatureHeader([], TIMESTAMP, BODY)).toThrow();
  });

  it('round-trips through the parser', () => {
    const header = buildSignatureHeader([SECRET, OTHER_SECRET], TIMESTAMP, BODY);
    const parsed = parseSignatureHeader(header);

    expect(parsed?.timestamp).toBe(TIMESTAMP);
    expect(parsed?.signatures).toHaveLength(2);
  });

  it('ignores an unknown scheme version, so adding v2 later does not break a v1 receiver', () => {
    const parsed = parseSignatureHeader(`t=${TIMESTAMP},v1=${'a'.repeat(64)},v2=whatever`);

    expect(parsed?.signatures).toEqual(['a'.repeat(64)]);
  });

  it.each([
    ['', 'empty'],
    ['nonsense', 'no key-value pairs'],
    [`v1=${'a'.repeat(64)}`, 'no timestamp'],
    [`t=${TIMESTAMP}`, 'no signature'],
    [`t=notanumber,v1=${'a'.repeat(64)}`, 'a non-numeric timestamp'],
    [`t=${TIMESTAMP},v1=tooshort`, 'a malformed signature'],
    [`t=${TIMESTAMP},v1=${'A'.repeat(64)}`, 'uppercase hex, which the sender never produces'],
  ])('returns null for %j (%s)', (header) => {
    expect(parseSignatureHeader(header)).toBeNull();
  });

  it('returns null rather than throwing on an enormous header', () => {
    // The parser runs on untrusted input reachable by anybody who knows the URL. Every failure
    // is the same boring "does not verify".
    expect(parseSignatureHeader('t=1,'.repeat(100_000))).toBeNull();
  });
});

describe('verification', () => {
  const verify = (overrides: Partial<Parameters<typeof verifySignature>[0]> = {}) =>
    verifySignature({
      body: BODY,
      header: buildSignatureHeader([SECRET], TIMESTAMP, BODY),
      secrets: [SECRET],
      now: NOW,
      ...overrides,
    });

  it('accepts a genuine delivery', () => {
    expect(verify()).toEqual({ valid: true, timestamp: TIMESTAMP });
  });

  it('rejects a body that changed by one byte', () => {
    expect(verify({ body: `${BODY} ` })).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects a signature made with a different secret', () => {
    expect(verify({ secrets: [OTHER_SECRET] })).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects a forged signature', () => {
    expect(verify({ header: `t=${TIMESTAMP},v1=${'f'.repeat(64)}` })).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects when no secret is configured', () => {
    expect(verify({ secrets: [] })).toEqual({ valid: false, reason: 'no_secrets' });
  });

  describe('replay protection', () => {
    it('rejects a delivery older than the tolerance', () => {
      // The captured-and-replayed case. The signature is genuine; the timestamp is what fails.
      const result = verify({ now: () => (TIMESTAMP + DEFAULT_TOLERANCE_SECONDS + 1) * 1000 });

      expect(result).toEqual({ valid: false, reason: 'timestamp_too_old' });
    });

    it('accepts one just inside the tolerance', () => {
      expect(verify({ now: () => (TIMESTAMP + DEFAULT_TOLERANCE_SECONDS) * 1000 }).valid).toBe(
        true,
      );
    });

    it('rejects a timestamp from the future beyond clock skew', () => {
      // Without this, a forged far-future timestamp would never expire — the replay window would
      // stay open until that date arrives.
      const result = verify({ now: () => (TIMESTAMP - DEFAULT_TOLERANCE_SECONDS - 1) * 1000 });

      expect(result).toEqual({ valid: false, reason: 'timestamp_in_future' });
    });

    it('tolerates modest clock skew in both directions', () => {
      expect(verify({ now: () => (TIMESTAMP + 30) * 1000 }).valid).toBe(true);
      expect(verify({ now: () => (TIMESTAMP - 30) * 1000 }).valid).toBe(true);
    });

    it('cannot be replayed by editing the timestamp, because it is signed', () => {
      const captured = buildSignatureHeader([SECRET], TIMESTAMP, BODY);
      const signature = captured.split('v1=')[1];
      const freshened = `t=${TIMESTAMP + 100_000},v1=${signature}`;

      const result = verifySignature({
        body: BODY,
        header: freshened,
        secrets: [SECRET],
        now: () => (TIMESTAMP + 100_000) * 1000,
      });

      expect(result).toEqual({ valid: false, reason: 'signature_mismatch' });
    });

    it('honours a stricter tolerance', () => {
      const result = verify({ toleranceSeconds: 10, now: () => (TIMESTAMP + 11) * 1000 });

      expect(result).toEqual({ valid: false, reason: 'timestamp_too_old' });
    });
  });

  describe('rotation', () => {
    it('accepts a delivery signed with the old secret while both are live', () => {
      const header = buildSignatureHeader([SECRET, OTHER_SECRET], TIMESTAMP, BODY);

      // A receiver that has updated verifies against the new one; one that has not verifies
      // against the old. Both succeed, which is the entire point of the overlap.
      expect(verifySignature({ body: BODY, header, secrets: [SECRET], now: NOW }).valid).toBe(true);
      expect(verifySignature({ body: BODY, header, secrets: [OTHER_SECRET], now: NOW }).valid).toBe(
        true,
      );
    });

    it('accepts either secret when the receiver holds both', () => {
      const header = buildSignatureHeader([OTHER_SECRET], TIMESTAMP, BODY);

      expect(
        verifySignature({ body: BODY, header, secrets: [SECRET, OTHER_SECRET], now: NOW }).valid,
      ).toBe(true);
    });

    it('rejects a revoked secret once it is no longer in the list', () => {
      const header = buildSignatureHeader([OTHER_SECRET], TIMESTAMP, BODY);

      expect(verifySignature({ body: BODY, header, secrets: [SECRET], now: NOW }).valid).toBe(
        false,
      );
    });
  });

  describe('the raw-body requirement', () => {
    it('fails when the body was re-serialized, which is the usual integration bug', () => {
      const raw = '{"b":2,"a":1}';
      const header = buildSignatureHeader([SECRET], TIMESTAMP, raw);

      // JSON.parse → JSON.stringify preserves insertion order here, so the failure is forced by
      // a whitespace difference — which is exactly what a pretty-printing middleware introduces.
      const reserialized = JSON.stringify(JSON.parse(raw), null, 2);

      expect(verifySignature({ body: reserialized, header, secrets: [SECRET], now: NOW })).toEqual({
        valid: false,
        reason: 'signature_mismatch',
      });
    });

    it('succeeds on the exact bytes', () => {
      const raw = '{"b":2,"a":1}';
      const header = buildSignatureHeader([SECRET], TIMESTAMP, raw);

      expect(verifySignature({ body: raw, header, secrets: [SECRET], now: NOW }).valid).toBe(true);
    });
  });
});

describe('constantTimeEquals', () => {
  it('is true for identical strings', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
  });

  it('is false for different strings of the same length', () => {
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
  });

  it('is false for different lengths without throwing', () => {
    // `timingSafeEqual` throws on a length mismatch, which would itself leak the length.
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
  });

  it('does not leak the matching prefix length through timing', () => {
    const target = 'f'.repeat(64);
    const almost = `${'f'.repeat(63)}0`;
    const nothing = '0'.repeat(64);

    const time = (candidate: string) => {
      const started = process.hrtime.bigint();
      for (let i = 0; i < 2000; i += 1) constantTimeEquals(target, candidate);
      return Number(process.hrtime.bigint() - started);
    };

    // Warm up, so JIT compilation does not dominate the first measurement.
    time(almost);

    /*
     * Measured as interleaved pairs, compared by median.
     *
     * Timing one candidate and then the other means any scheduling spike lands on
     * whichever measurement happened to be running, and shows up as a ratio the
     * implementation did nothing to cause — this test failed that way at 5.02 on a
     * loaded machine while the comparison was perfectly constant-time. Interleaving
     * puts a spike in both series, and the median then discards it.
     */
    const rounds = 15;
    const almostTimes: number[] = [];
    const nothingTimes: number[] = [];

    for (let round = 0; round < rounds; round += 1) {
      almostTimes.push(time(almost));
      nothingTimes.push(time(nothing));
    }

    const median = (values: number[]) => {
      const sorted = [...values].sort((left, right) => left - right);
      return sorted[Math.floor(sorted.length / 2)] as number;
    };

    const almostTime = median(almostTimes);
    const nothingTime = median(nothingTimes);
    const ratio = Math.max(almostTime, nothingTime) / Math.min(almostTime, nothingTime);

    // A generous bound: this is a smoke test that the implementation is not doing a
    // short-circuiting comparison, not a rigorous side-channel measurement — those cannot be
    // done reliably on a shared CI runner.
    expect(ratio).toBeLessThan(3);
  });
});
