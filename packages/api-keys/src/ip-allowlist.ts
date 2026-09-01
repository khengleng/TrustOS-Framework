import { ApiError } from '@trustsystem/errors';

/**
 * IP allowlists for API keys.
 *
 * An optional second factor for a machine credential: a key that only works from a
 * known egress address is a key whose theft is much less useful. It is not a
 * substitute for keeping the key secret — an attacker inside the same network still
 * passes — and it is defence in depth rather than a boundary.
 *
 * IPv4 and IPv6, single addresses and CIDR ranges. Matching is done on parsed bytes
 * rather than on strings, because `192.168.1.1` and `192.168.001.001` are the same
 * address and a string comparison says otherwise, and because `::ffff:10.0.0.1` is
 * the IPv4-mapped form of an address a v4 rule should match.
 */

export interface ParsedCidr {
  bytes: Uint8Array;
  prefixLength: number;
  family: 4 | 6;
}

/**
 * Whether an address is permitted.
 *
 * An empty allowlist permits everything, which is the default: requiring one on
 * every key would mean every key needs a network diagram before it can be created.
 *
 * A *missing* address against a non-empty allowlist is denied. That is the important
 * case: if the deployment cannot determine the client address — no `TRUST_PROXY`, a
 * malformed header, a transport with no address — then it cannot enforce the rule,
 * and a rule that cannot be enforced must fail closed rather than pass.
 */
export function addressAllowed(address: string | null, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  if (!address) return false;

  const parsed = parseAddress(address);
  if (!parsed) return false;

  return allowlist.some((entry) => {
    const rule = parseCidr(entry);
    return rule !== null && matches(parsed, rule);
  });
}

/** Validates an allowlist at creation time, so a typo is not a silent lockout. */
export function assertValidAllowlist(entries: string[]): string[] {
  const problems: Array<{ path: string; message: string }> = [];
  const normalized = new Set<string>();

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    if (parseCidr(trimmed) === null) {
      problems.push({
        path: 'ipAllowlist',
        message: `"${entry}" is not a valid IP address or CIDR range.`,
      });
      continue;
    }
    normalized.add(trimmed);
  }

  if (problems.length > 0) {
    throw ApiError.validation(problems, 'The IP allowlist is not valid.');
  }

  return [...normalized].sort();
}

/**
 * Parses an address or CIDR range.
 *
 * A bare address becomes a /32 or /128, so one code path handles both.
 */
export function parseCidr(entry: string): ParsedCidr | null {
  const [address, prefix] = entry.split('/');
  if (!address) return null;

  const parsed = parseAddress(address);
  if (!parsed) return null;

  const maxPrefix = parsed.family === 4 ? 32 : 128;

  if (prefix === undefined) {
    return { bytes: parsed.bytes, prefixLength: maxPrefix, family: parsed.family };
  }

  if (!/^\d{1,3}$/.test(prefix)) return null;
  const prefixLength = Number(prefix);
  if (prefixLength > maxPrefix) return null;

  return { bytes: parsed.bytes, prefixLength, family: parsed.family };
}

interface ParsedAddress {
  bytes: Uint8Array;
  family: 4 | 6;
}

/** Parses an IPv4 or IPv6 address into bytes. */
export function parseAddress(value: string): ParsedAddress | null {
  const address = value.trim();

  // An IPv4-mapped IPv6 address is the same address. A deployment behind a
  // dual-stack proxy sees `::ffff:203.0.113.9`, and a v4 rule has to match it.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped?.[1]) return parseIpv4(mapped[1]);

  if (address.includes(':')) return parseIpv6(address);
  return parseIpv4(address);
}

function parseIpv4(value: string): ParsedAddress | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;

  const bytes = new Uint8Array(4);
  for (const [index, part] of parts.entries()) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    bytes[index] = octet;
  }

  return { bytes, family: 4 };
}

function parseIpv6(value: string): ParsedAddress | null {
  const address = value.replace(/^\[|\]$/g, '');
  const doubleColon = address.indexOf('::');

  if (doubleColon !== address.lastIndexOf('::')) return null;

  const [head, tail] =
    doubleColon === -1
      ? [address, '']
      : [address.slice(0, doubleColon), address.slice(doubleColon + 2)];

  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];

  if (doubleColon === -1 && headGroups.length !== 8) return null;
  if (headGroups.length + tailGroups.length > 8) return null;

  const groups: number[] = [];
  for (const group of headGroups) {
    const parsed = parseGroup(group);
    if (parsed === null) return null;
    groups.push(parsed);
  }

  const fill = 8 - headGroups.length - tailGroups.length;
  for (let index = 0; index < fill; index += 1) groups.push(0);

  for (const group of tailGroups) {
    const parsed = parseGroup(group);
    if (parsed === null) return null;
    groups.push(parsed);
  }

  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = (group >> 8) & 0xff;
    bytes[index * 2 + 1] = group & 0xff;
  });

  return { bytes, family: 6 };
}

function parseGroup(group: string): number | null {
  if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
  return Number.parseInt(group, 16);
}

/** Compares an address against a rule, bit by bit up to the prefix length. */
function matches(address: ParsedAddress, rule: ParsedCidr): boolean {
  // A v4 address never matches a v6 rule, and the reverse. The mapped form is
  // normalised to v4 during parsing, so this is not an accidental mismatch.
  if (address.family !== rule.family) return false;

  const fullBytes = Math.floor(rule.prefixLength / 8);
  const remainingBits = rule.prefixLength % 8;

  for (let index = 0; index < fullBytes; index += 1) {
    if (address.bytes[index] !== rule.bytes[index]) return false;
  }

  if (remainingBits === 0) return true;

  const mask = 0xff << (8 - remainingBits);
  return ((address.bytes[fullBytes] ?? 0) & mask) === ((rule.bytes[fullBytes] ?? 0) & mask);
}
