import { describe, expect, it } from 'vitest';
import {
  assertSafeDestination,
  blockedReason,
  checkDestination,
  inCidr,
  mappedIpv4,
} from './destination';

/** A resolver that returns whatever the test says, so no real DNS is involved. */
const resolving = (addresses: string[]) => ({ resolve: async () => addresses });

describe('literal addresses', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'anywhere in 127/8'],
    ['10.0.0.1', 'private'],
    ['10.255.255.254', 'the far end of 10/8'],
    ['172.16.0.1', 'private'],
    ['172.31.255.254', 'the far end of 172.16/12'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'cloud instance metadata — the classic target'],
    ['0.0.0.0', 'this host'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['224.0.0.1', 'multicast'],
    ['240.0.0.1', 'reserved'],
  ])('refuses https://%s (%s)', async (address) => {
    const check = await checkDestination(`https://${address}/hook`);

    expect(check.allowed).toBe(false);
  });

  it.each(['1.1.1.1', '8.8.8.8', '203.0.113.10', '172.32.0.1', '192.169.0.1', '11.0.0.1'])(
    'allows the public address %s',
    async (address) => {
      const check = await checkDestination(`https://${address}/hook`);

      expect(check.allowed).toBe(true);
    },
  );

  it('names the metadata service specifically, so the log explains itself', async () => {
    const check = await checkDestination('https://169.254.169.254/latest/meta-data/');

    expect(check.reason).toMatch(/metadata/i);
  });
});

describe('IPv6', () => {
  it.each([
    ['::1', 'loopback'],
    ['fe80::1', 'link-local'],
    ['fd00::1', 'unique local'],
    ['fc00::1', 'unique local'],
    ['ff02::1', 'multicast'],
  ])('refuses [%s] (%s)', async (address) => {
    expect(await checkDestination(`https://[${address}]/hook`)).toMatchObject({ allowed: false });
  });

  it('refuses an IPv4-mapped private address, which would otherwise be a clean bypass', async () => {
    // `::ffff:10.0.0.1` is a route to 10.0.0.1. A v6 check that did not unwrap it would let every
    // blocked v4 range through simply by prefixing it.
    expect(await checkDestination('https://[::ffff:10.0.0.1]/hook')).toMatchObject({
      allowed: false,
    });
    expect(blockedReason('::ffff:169.254.169.254')).toMatch(/metadata/i);
  });

  it('refuses the hex spelling of a mapped address, which is what a URL parser produces', () => {
    // `new URL('https://[::ffff:10.0.0.1]/').hostname` is `[::ffff:a00:1]`. A check that only
    // matched the readable dotted form would pass every such URL — the bug gets written, tested
    // against the readable spelling, and shipped.
    expect(new URL('https://[::ffff:10.0.0.1]/').hostname).toBe('[::ffff:a00:1]');
    expect(blockedReason('::ffff:a00:1')).toMatch(/private/i);
    expect(blockedReason('::ffff:a9fe:a9fe')).toMatch(/metadata/i);
  });

  it.each([
    ['::ffff:1.1.1.1', 'a mapped public address'],
    ['::ffff:101:101', 'the same, in hex'],
  ])('allows %s (%s)', (address) => {
    expect(blockedReason(address)).toBeNull();
  });

  it('expands both spellings to the same verdict', () => {
    expect(mappedIpv4('::ffff:a00:1')).toBe('10.0.0.1');
    expect(mappedIpv4('::ffff:10.0.0.1')).toBe('10.0.0.1');
    // Not a mapped address, so not unwrapped — `2001:db8::1` must not be read as IPv4.
    expect(mappedIpv4('2001:db8::1')).toBeNull();
    expect(mappedIpv4('10.0.0.1')).toBeNull();
  });

  it('allows a public IPv6 address', async () => {
    expect(await checkDestination('https://[2001:4860:4860::8888]/hook')).toMatchObject({
      allowed: true,
    });
  });
});

describe('DNS resolution', () => {
  it('refuses a public-looking hostname that resolves privately', async () => {
    // Checking the hostname string alone is useless: evil.com can hold an A record for 10.0.0.1.
    const check = await checkDestination('https://webhooks.example.com/hook', {
      ...resolving(['10.0.0.5']),
    });

    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/10\.0\.0\.5/);
  });

  it('refuses when any resolved address is private, not just the first', async () => {
    // With only the first checked, this would pass about half the time depending on resolver
    // ordering — intermittent, and therefore far harder to find than a consistent bug.
    const check = await checkDestination('https://split.example.com/hook', {
      ...resolving(['93.184.216.34', '169.254.169.254']),
    });

    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/169\.254\.169\.254/);
  });

  it('allows a hostname whose addresses are all public', async () => {
    const check = await checkDestination('https://webhooks.example.com/hook', {
      ...resolving(['93.184.216.34', '93.184.216.35']),
    });

    expect(check.allowed).toBe(true);
    expect(check.resolvedAddresses).toHaveLength(2);
  });

  it('refuses a hostname that does not resolve', async () => {
    const check = await checkDestination('https://nope.example.com/hook', {
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
    });

    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/ENOTFOUND/);
  });

  it('refuses a hostname that resolves to nothing', async () => {
    expect(
      await checkDestination('https://empty.example.com/hook', { ...resolving([]) }),
    ).toMatchObject({ allowed: false });
  });
});

describe('schemes', () => {
  it.each(['file:///etc/passwd', 'ftp://internal/', 'gopher://internal/', 'data:text/plain,hi'])(
    'refuses %s',
    async (url) => {
      // Every one of these has been an SSRF primitive somewhere.
      expect(await checkDestination(url)).toMatchObject({ allowed: false });
    },
  );

  it('refuses an unparseable URL', async () => {
    expect(await checkDestination('not a url')).toMatchObject({ allowed: false });
  });
});

describe('policy', () => {
  it('allows private addresses when explicitly told to, for development', async () => {
    const check = await checkDestination('https://10.0.0.1/hook', {
      allowPrivateAddresses: true,
    });

    expect(check.allowed).toBe(true);
  });

  it('allows a named host regardless, for a deliberate internal integration', async () => {
    const check = await checkDestination('https://internal-billing/hook', {
      allowedHosts: ['internal-billing'],
    });

    expect(check.allowed).toBe(true);
  });

  it('does not allow a host merely because another is allowed', async () => {
    const check = await checkDestination('https://10.0.0.1/hook', {
      allowedHosts: ['internal-billing'],
    });

    expect(check.allowed).toBe(false);
  });
});

describe('assertSafeDestination', () => {
  it('throws with the reason, so the caller does not have to invent one', async () => {
    await expect(assertSafeDestination('https://169.254.169.254/')).rejects.toThrow(/not allowed/i);
  });

  it('is silent for a safe destination', async () => {
    await expect(
      assertSafeDestination('https://webhooks.example.com/hook', { ...resolving(['1.1.1.1']) }),
    ).resolves.toBeUndefined();
  });
});

describe('inCidr', () => {
  it.each([
    ['10.0.0.1', '10.0.0.0/8', true],
    ['10.255.255.255', '10.0.0.0/8', true],
    ['11.0.0.0', '10.0.0.0/8', false],
    ['192.168.0.1', '192.168.0.0/16', true],
    ['192.169.0.1', '192.168.0.0/16', false],
    ['172.16.0.0', '172.16.0.0/12', true],
    ['172.31.255.255', '172.16.0.0/12', true],
    ['172.32.0.0', '172.16.0.0/12', false],
    ['1.2.3.4', '0.0.0.0/0', true],
  ])('%s in %s is %s', (address, cidr, expected) => {
    expect(inCidr(address, cidr)).toBe(expected);
  });

  it('handles a /1 mask, where a signed shift would silently produce the wrong answer', () => {
    expect(inCidr('127.0.0.1', '0.0.0.0/1')).toBe(true);
    expect(inCidr('128.0.0.1', '0.0.0.0/1')).toBe(false);
  });

  it.each(['256.0.0.1', '1.2.3', '1.2.3.4.5', 'not-an-ip'])(
    'rejects the malformed input %j',
    (address) => {
      expect(inCidr(address, '10.0.0.0/8')).toBe(false);
    },
  );
});
