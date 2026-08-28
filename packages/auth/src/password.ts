import bcrypt from 'bcryptjs';

/**
 * Password hashing.
 *
 * bcrypt rather than argon2 for one practical reason: it is pure JavaScript,
 * so a deployment never fails because a native module could not be built for
 * the target platform. The cost factor is configuration (`PASSWORD_HASH_ROUNDS`)
 * so it can be raised as hardware improves without a code change.
 */

/**
 * A real bcrypt hash of a value nobody knows, used to spend the same time
 * verifying a password for a non-existent user as for a real one.
 *
 * Without this, "user not found" returns in microseconds while a wrong
 * password takes ~100ms, and the difference enumerates the user table.
 */
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

export async function hashPassword(plaintext: string, rounds: number): Promise<string> {
  return bcrypt.hash(plaintext, rounds);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

/**
 * Burns the same CPU time as a real verification and always fails.
 * Call it on the "no such user" branch of login.
 */
export async function verifyPasswordAgainstDummy(plaintext: string): Promise<false> {
  await bcrypt.compare(plaintext, DUMMY_HASH);
  return false;
}

/**
 * True when a stored hash was produced with a weaker cost than the current
 * setting. Re-hash transparently on the next successful login.
 */
export function needsRehash(hash: string, desiredRounds: number): boolean {
  const match = /^\$2[aby]?\$(\d{2})\$/.exec(hash);
  if (!match) return true;
  return Number(match[1]) < desiredRounds;
}
