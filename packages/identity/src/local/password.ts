import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { ApiError } from '@trustos/errors';
import type { PasswordPolicy } from '@trustos/security-policy';

/**
 * `scrypt` with options, promisified by hand.
 *
 * `promisify` picks the three-argument overload and loses the options parameter,
 * which is where every cost setting lives — so the wrapper is explicit.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

/**
 * Password hashing for the local identity provider.
 *
 * **Why scrypt and not Argon2id.** Argon2id is the first recommendation, and it
 * is available through the port below — a deployment that wants it implements
 * `PasswordHasher` and passes it in. The framework's *default* is scrypt from
 * `node:crypto`, for reasons that are about the authentication path specifically:
 *
 *   * It is memory-hard, which is the property that matters. OWASP lists scrypt
 *     as an acceptable alternative to Argon2id, with parameters, and the
 *     parameters below are those.
 *   * It needs no native module and no WebAssembly blob. Phase 1 chose bcryptjs
 *     for the same reason — a deployment must not fail because node-gyp could not
 *     build for the target platform — and the login path is the worst place to
 *     introduce a build-time dependency.
 *   * It is in the standard library, so there is no third-party code in the path
 *     that turns a password into a hash.
 *
 * That is a real trade and it is stated rather than buried: Argon2id resists
 * GPU-based cracking somewhat better at equal cost. The port exists so a
 * deployment can make the other choice without touching anything else.
 *
 * **Why not bcrypt any more.** bcrypt truncates at 72 bytes and is not
 * memory-hard. Phase 1's use of it remains supported for existing hashes — see
 * `identifyHash` — and a stored bcrypt hash is upgraded transparently on the next
 * successful login.
 */

/**
 * scrypt parameters.
 *
 * N = 2^17, r = 8, p = 1 is the OWASP recommendation for scrypt, and costs
 * roughly 128 MiB and ~100 ms per hash on current hardware. `maxmem` has to be
 * raised explicitly: Node's default is 32 MiB and scrypt throws rather than
 * silently using weaker parameters, which is the right failure but a surprising
 * one.
 */
export const SCRYPT_PARAMETERS = {
  N: 2 ** 17,
  r: 8,
  p: 1,
  keyLength: 64,
  saltLength: 16,
  maxmem: 256 * 1024 * 1024,
} as const;

/**
 * Cheaper parameters for tests.
 *
 * Hashing dominates the runtime of an authentication suite. These are still real
 * scrypt, just cheap, and they are never the default — `createPasswordHasher`
 * takes them explicitly, so a production deployment cannot end up with them by
 * forgetting to set something.
 */
export const SCRYPT_TEST_PARAMETERS = {
  N: 2 ** 12,
  r: 8,
  p: 1,
  keyLength: 64,
  saltLength: 16,
  maxmem: 64 * 1024 * 1024,
} as const;

export type ScryptParameters = typeof SCRYPT_PARAMETERS;

/**
 * The hashing port.
 *
 * `identify` exists so a deployment can migrate: the verifier needs to know
 * which algorithm produced a stored hash before it can check it, and asking the
 * hash rather than a column keeps the migration invisible to callers.
 */
export interface PasswordHasher {
  readonly id: string;
  hash(plaintext: string): Promise<string>;
  verify(plaintext: string, storedHash: string): Promise<boolean>;
  /** True when a stored hash should be replaced on the next successful login. */
  needsRehash(storedHash: string): boolean;
  /**
   * Burns comparable time and always fails.
   *
   * Called on the "no such user" branch, so a missing account and a wrong
   * password take the same time. Without it, the difference enumerates the user
   * table at the rate the network allows.
   */
  verifyAgainstDummy(plaintext: string): Promise<false>;
}

/** Which algorithm produced a stored hash. */
export function identifyHash(storedHash: string): 'scrypt' | 'bcrypt' | 'unknown' {
  if (storedHash.startsWith('$scrypt$')) return 'scrypt';
  if (/^\$2[aby]?\$\d{2}\$/.test(storedHash)) return 'bcrypt';
  return 'unknown';
}

/**
 * scrypt hasher.
 *
 * Encoded as `$scrypt$N=..,r=..,p=..$<salt>$<hash>`, so the parameters travel
 * with the hash. Raising the cost later then does not invalidate existing
 * passwords — `needsRehash` notices the difference and the next login upgrades
 * it. A scheme that stored only the digest would need a migration for every
 * parameter change.
 */
export class ScryptPasswordHasher implements PasswordHasher {
  readonly id = 'scrypt';

  constructor(private readonly parameters: ScryptParameters = SCRYPT_PARAMETERS) {}

  async hash(plaintext: string): Promise<string> {
    const salt = randomBytes(this.parameters.saltLength);
    const derived = await this.derive(plaintext, salt);

    const { N, r, p } = this.parameters;
    return `$scrypt$N=${N},r=${r},p=${p}$${salt.toString('base64')}$${derived.toString('base64')}`;
  }

  async verify(plaintext: string, storedHash: string): Promise<boolean> {
    const parsed = parseScryptHash(storedHash);
    if (!parsed) return false;

    const derived = await this.derive(plaintext, parsed.salt, parsed);

    // Constant-time. A byte-by-byte comparison that returns early leaks how much
    // of a candidate matched, which is enough to recover a hash byte at a time.
    if (derived.length !== parsed.hash.length) return false;
    return timingSafeEqual(derived, parsed.hash);
  }

  needsRehash(storedHash: string): boolean {
    const algorithm = identifyHash(storedHash);

    // Anything not produced by this hasher needs replacing — including a bcrypt
    // hash from an earlier phase, which is how the migration happens.
    if (algorithm !== 'scrypt') return true;

    const parsed = parseScryptHash(storedHash);
    if (!parsed) return true;

    return (
      parsed.N < this.parameters.N || parsed.r < this.parameters.r || parsed.p < this.parameters.p
    );
  }

  async verifyAgainstDummy(plaintext: string): Promise<false> {
    // A real derivation against a real salt, so the work is genuinely equivalent
    // rather than approximately so.
    await this.derive(plaintext, DUMMY_SALT);
    return false;
  }

  private async derive(
    plaintext: string,
    salt: Buffer,
    parameters: { N: number; r: number; p: number } = this.parameters,
  ): Promise<Buffer> {
    return scryptAsync(plaintext.normalize('NFKC'), salt, this.parameters.keyLength, {
      N: parameters.N,
      r: parameters.r,
      p: parameters.p,
      maxmem: this.parameters.maxmem,
    });
  }
}

const DUMMY_SALT = Buffer.from('trustos-dummy-salt-not-a-secret!', 'utf8').subarray(0, 16);

interface ParsedScryptHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseScryptHash(value: string): ParsedScryptHash | null {
  const match = /^\$scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(
    value,
  );
  if (!match) return null;

  const [, n, r, p, salt, hash] = match;
  return {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    salt: Buffer.from(salt as string, 'base64'),
    hash: Buffer.from(hash as string, 'base64'),
  };
}

// ---------------------------------------------------------------------------

/**
 * Checks a candidate password against a breach corpus.
 *
 * An interface, and the framework ships no implementation that makes a network
 * call. Two reasons: a login path that depends on a third party is a login path
 * that fails when the third party does, and the k-anonymity model of the
 * commonly used service still tells that service which prefix was queried and
 * when.
 *
 * A deployment that wants it implements this against its own corpus or against a
 * service it accepts, and the policy field `checkCompromised` turns it on.
 */
export interface CompromisedPasswordChecker {
  readonly id: string;
  /** True when the password appears in the corpus. */
  isCompromised(plaintext: string): Promise<boolean>;
}

/**
 * The default: refuses a short list of passwords that appear in every corpus.
 *
 * Not a substitute for a real breach check, and it does not pretend to be. It
 * exists so that `checkCompromised: true` does something out of the box rather
 * than silently nothing, which is the failure mode of a policy flag with no
 * implementation behind it.
 */
export class WellKnownPasswordChecker implements CompromisedPasswordChecker {
  readonly id = 'well-known';

  private static readonly LIST = new Set([
    'password',
    'password1',
    'password123',
    'password1234',
    'passw0rd123',
    'qwerty123456',
    'administrator',
    'welcome123456',
    'letmein12345',
    'trustos123456',
    'changeme1234',
    'iloveyou1234',
    'football1234',
    'monkey123456',
    'dragon123456',
    'abc123456789',
    '123456789012',
    'qwertyuiop12',
  ]);

  async isCompromised(plaintext: string): Promise<boolean> {
    return WellKnownPasswordChecker.LIST.has(plaintext.toLowerCase());
  }
}

/**
 * Applies the password policy.
 *
 * Length first and weighted heaviest: length is the dominant factor in
 * resistance to offline cracking, and composition rules pushed harder produce
 * predictable substitutions. Note what is absent — forced periodic rotation. NIST
 * withdrew the recommendation because rotation produces `Summer2024!` followed by
 * `Autumn2024!`, and the policy type has no field for it.
 */
export interface PasswordValidationResult {
  ok: boolean;
  problems: string[];
}

export function validatePassword(
  plaintext: string,
  policy: PasswordPolicy,
): PasswordValidationResult {
  const problems: string[] = [];

  if (plaintext.length < policy.minLength) {
    problems.push(`Must be at least ${policy.minLength} characters.`);
  }
  if (plaintext.length > policy.maxLength) {
    problems.push(`Must be at most ${policy.maxLength} characters.`);
  }
  if (policy.requireMixedCase && !(/[a-z]/.test(plaintext) && /[A-Z]/.test(plaintext))) {
    problems.push('Must contain both uppercase and lowercase letters.');
  }
  if (policy.requireDigit && !/\d/.test(plaintext)) {
    problems.push('Must contain at least one digit.');
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Validates a password against the policy and the breach corpus, or throws.
 *
 * The error carries every problem at once. A form that reveals one rule per
 * submission is a form people fight, and the rules are not secret.
 */
export async function assertPasswordAcceptable(
  plaintext: string,
  policy: PasswordPolicy,
  checker: CompromisedPasswordChecker | null,
): Promise<void> {
  const result = validatePassword(plaintext, policy);

  if (policy.checkCompromised && checker && (await checker.isCompromised(plaintext))) {
    // Said plainly. "Choose a different password" without a reason gets the same
    // password with a `1` on the end.
    result.problems.push(
      'This password appears in a known breach corpus. Choose one that does not.',
    );
  }

  if (result.problems.length === 0) return;

  throw ApiError.validation(
    result.problems.map((message) => ({ path: 'password', message })),
    'The password does not meet the policy.',
  );
}

/** Builds the default hasher. Test parameters must be requested explicitly. */
export function createPasswordHasher(options: { forTests?: boolean } = {}): PasswordHasher {
  return new ScryptPasswordHasher(
    options.forTests ? (SCRYPT_TEST_PARAMETERS as unknown as ScryptParameters) : SCRYPT_PARAMETERS,
  );
}
