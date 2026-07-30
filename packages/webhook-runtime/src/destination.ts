import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ApiError } from '@trustos/errors';

/**
 * Where a webhook is allowed to go.
 *
 * A webhook URL is attacker-controlled input that the server then makes a request to. That is
 * server-side request forgery by construction, and the only thing between "a feature" and "an
 * internal-network scanner with a signed payload" is this file.
 *
 * The attack is concrete: register an endpoint pointing at `http://169.254.169.254/latest/meta-data/`
 * — the cloud instance metadata service — and the response body lands in the delivery log, where
 * it can be read through the admin API. On an unpatched IMDSv1 host that response contains
 * credentials.
 *
 * So the destination is checked against private ranges. Three details make the check real rather
 * than decorative:
 *
 *   1. **DNS is resolved first.** Checking the hostname string is useless: `evil.com` can have an
 *      A record pointing at `10.0.0.1`, and the string check passes while the request goes
 *      straight to the internal network.
 *   2. **Every resolved address is checked**, not just the first. A hostname with two A records —
 *      one public, one private — would otherwise pass whenever the resolver happened to order the
 *      public one first.
 *   3. **Redirects are not followed.** A receiver that returns `302 → http://10.0.0.1` would
 *      bypass every check above, because the check happened before the request. See
 *      `deliverWebhook`, which sets `redirect: 'manual'`.
 *
 * What remains, and cannot be closed here: DNS rebinding. The address can change between this
 * check and the connection. Closing it properly means pinning the resolved address into the
 * socket, which Node's fetch does not expose. The mitigation is that the response body is
 * truncated and the endpoint is disabled after repeated failures, so the channel is narrow — and
 * a deployment in a sensitive network should put an egress proxy in front of this. Said plainly
 * because a security control whose limits are undocumented is one people over-trust.
 */

/**
 * Address ranges a webhook must never reach.
 *
 * Everything here is either loopback, link-local, private, or reserved. The comment on each is the
 * reason somebody would target it.
 */
const BLOCKED_V4 = [
  { cidr: '0.0.0.0/8', why: 'this host' },
  { cidr: '10.0.0.0/8', why: 'private network' },
  { cidr: '100.64.0.0/10', why: 'carrier-grade NAT' },
  { cidr: '127.0.0.0/8', why: 'loopback — the application itself' },
  { cidr: '169.254.0.0/16', why: 'link-local, including cloud instance metadata' },
  { cidr: '172.16.0.0/12', why: 'private network' },
  { cidr: '192.0.0.0/24', why: 'IETF protocol assignments' },
  { cidr: '192.168.0.0/16', why: 'private network' },
  { cidr: '198.18.0.0/15', why: 'benchmarking' },
  { cidr: '224.0.0.0/4', why: 'multicast' },
  { cidr: '240.0.0.0/4', why: 'reserved' },
] as const;

export interface DestinationPolicy {
  /**
   * Allows private addresses.
   *
   * For development and for tests. Turning this on in production makes every endpoint a way to
   * probe the internal network, which is why it is named for what it does rather than something
   * softer like `strict: false`.
   */
  allowPrivateAddresses?: boolean;
  /** Extra hostnames permitted regardless. For a deliberate internal integration. */
  allowedHosts?: string[];
  /** Skips DNS. For tests, and for a deployment behind an egress proxy that does its own checks. */
  skipDnsResolution?: boolean;
  resolve?: (hostname: string) => Promise<string[]>;
}

export interface DestinationCheck {
  allowed: boolean;
  reason: string | null;
  resolvedAddresses: string[];
}

/**
 * Checks a URL, resolving DNS.
 *
 * Returns a result rather than throwing, so a caller can record the reason in the delivery log —
 * an integrator whose endpoint is refused deserves to know it resolved to a private address
 * rather than seeing a generic failure.
 */
export async function checkDestination(
  url: string,
  policy: DestinationPolicy = {},
): Promise<DestinationCheck> {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'The URL could not be parsed.', resolvedAddresses: [] };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    // `file:`, `ftp:`, `gopher:` — every one of these has been an SSRF primitive somewhere.
    return {
      allowed: false,
      reason: `The scheme "${parsed.protocol}" is not allowed. Use https.`,
      resolvedAddresses: [],
    };
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  if (policy.allowedHosts?.includes(parsed.hostname)) {
    return { allowed: true, reason: null, resolvedAddresses: [] };
  }

  if (policy.allowPrivateAddresses) {
    return { allowed: true, reason: null, resolvedAddresses: [] };
  }

  // A literal address needs no resolution, and must still be checked — otherwise
  // `https://10.0.0.1/` walks straight through.
  if (isIP(hostname)) {
    const blocked = blockedReason(hostname);
    return {
      allowed: blocked === null,
      reason: blocked,
      resolvedAddresses: [hostname],
    };
  }

  if (policy.skipDnsResolution) {
    return { allowed: true, reason: null, resolvedAddresses: [] };
  }

  let addresses: string[];

  try {
    const resolver = policy.resolve ?? defaultResolve;
    addresses = await resolver(hostname);
  } catch (error) {
    return {
      allowed: false,
      reason: `The hostname could not be resolved: ${
        error instanceof Error ? error.message : 'unknown'
      }`,
      resolvedAddresses: [],
    };
  }

  if (addresses.length === 0) {
    return {
      allowed: false,
      reason: 'The hostname resolved to no addresses.',
      resolvedAddresses: [],
    };
  }

  /*
   * Every address, not just the first.
   *
   * A hostname with one public and one private A record would otherwise pass whenever the
   * resolver ordered the public one first — which is roughly half the time, making the bug
   * intermittent and therefore much harder to find than a consistent one.
   */
  for (const address of addresses) {
    const blocked = blockedReason(address);
    if (blocked !== null) {
      return {
        allowed: false,
        reason: `${hostname} resolves to ${address}: ${blocked}`,
        resolvedAddresses: addresses,
      };
    }
  }

  return { allowed: true, reason: null, resolvedAddresses: addresses };
}

/** Throws instead of returning. For a caller that has nowhere useful to put the reason. */
export async function assertSafeDestination(
  url: string,
  policy: DestinationPolicy = {},
): Promise<void> {
  const check = await checkDestination(url, policy);

  if (!check.allowed) {
    throw ApiError.validation(
      [{ path: 'url', message: check.reason ?? 'This destination is not allowed.' }],
      'This webhook destination is not allowed.',
    );
  }
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
}

/** The reason an address is blocked, or null if it is fine. */
export function blockedReason(address: string): string | null {
  const version = isIP(address);

  if (version === 4) {
    for (const range of BLOCKED_V4) {
      if (inCidr(address, range.cidr)) return range.why;
    }
    return null;
  }

  if (version === 6) return blockedV6Reason(address);
  return 'not a valid IP address';
}

function blockedV6Reason(address: string): string | null {
  const normalized = address.toLowerCase();

  if (normalized === '::1' || normalized === '::') return 'loopback — the application itself';

  /*
   * An IPv4-mapped address is checked as IPv4.
   *
   * `::ffff:10.0.0.1` is a route to 10.0.0.1, and a v6 check that did not unwrap it would let
   * every blocked v4 range through by prefixing it. This is a real bypass, not a theoretical one.
   *
   * It has to handle both spellings. `new URL('https://[::ffff:10.0.0.1]/')` reports its hostname
   * as `[::ffff:a00:1]` — the WHATWG parser normalizes the dotted quad into hex groups. A check
   * that only matched the dotted form would pass every such URL, which is precisely the shape of
   * bug that gets written, tested against the readable spelling, and shipped.
   */
  const mapped = mappedIpv4(normalized);
  if (mapped) return blockedReason(mapped);

  // fc00::/7 — unique local. fe80::/10 — link-local. ff00::/8 — multicast.
  if (/^f[cd]/.test(normalized)) return 'unique local address';
  if (/^fe[89ab]/.test(normalized)) return 'link-local address';
  if (/^ff/.test(normalized)) return 'multicast';

  return null;
}

/**
 * The IPv4 address inside an IPv4-mapped IPv6 address, in dotted form, or null.
 *
 * Expands the address to its eight groups first, because `::ffff:a00:1` and `::ffff:10.0.0.1` are
 * the same address written two ways and both reach the internal network equally well.
 */
export function mappedIpv4(address: string): string | null {
  const groups = expandIpv6(address);
  if (!groups) return null;

  // ::ffff:0:0/96 — the first five groups zero, the sixth 0xffff.
  const isMapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (!isMapped) return null;

  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;

  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/** An IPv6 address as eight 16-bit groups, or null when it is not one. */
function expandIpv6(address: string): number[] | null {
  if (isIP(address) !== 6) return null;

  // A trailing dotted quad, as in `::ffff:10.0.0.1`, is converted to two hex groups first so the
  // rest of the expansion only ever deals with one notation.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  let text = address;

  if (dotted?.[1] && dotted[2]) {
    const octets = dotted[2].split('.').map((part) => Number.parseInt(part, 10));
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;

    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    text = `${dotted[1]}${high.toString(16)}:${low.toString(16)}`;
  }

  const [head, tail, ...extra] = text.split('::');
  if (extra.length > 0) return null;

  const parse = (part: string) =>
    part === '' ? [] : part.split(':').map((group) => Number.parseInt(group, 16));

  const left = parse(head ?? '');
  const right = tail === undefined ? [] : parse(tail);
  const missing = 8 - left.length - right.length;

  if (tail === undefined) return left.length === 8 ? left : null;
  if (missing < 0) return null;

  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

/** Whether an IPv4 address falls in a CIDR block. */
export function inCidr(address: string, cidr: string): boolean {
  const [range, bitsText] = cidr.split('/');
  if (!range || !bitsText) return false;

  const bits = Number.parseInt(bitsText, 10);
  const addressBits = toUint32(address);
  const rangeBits = toUint32(range);

  if (addressBits === null || rangeBits === null) return false;
  if (bits === 0) return true;

  // `>>> 0` keeps the result unsigned. Without it a /1 mask is negative and every comparison is
  // wrong in a way that happens to work for the ranges people usually test with.
  const mask = (~0 << (32 - bits)) >>> 0;
  return (addressBits & mask) >>> 0 === (rangeBits & mask) >>> 0;
}

function toUint32(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    const octet = Number.parseInt(part, 10);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    result = (result << 8) | octet;
  }

  return result >>> 0;
}
