import { createHash, createVerify, timingSafeEqual, verify as verifyEd25519 } from 'node:crypto';
import { ApiError } from '@trustos/errors';

/**
 * Integrity and signatures for anything installable.
 *
 * This file is the supply chain. Everything a plugin or a module can do to a host application, it
 * does because something here said the artefact was genuine — so the failure modes are worth
 * stating plainly.
 *
 * **A hash proves the bytes did not change. A signature proves who produced them.** They answer
 * different questions and a system with only the first is trivially attacked: an attacker who can
 * modify the artefact can modify the hash beside it. Integrity without authenticity is a checksum
 * against disk corruption, not a defence.
 *
 * **Verification is offline.** No key server, no OCSP, no network at install time. The trusted
 * keys are configuration a deployment controls, because the alternative is that whoever controls
 * the network at install time controls what gets installed.
 *
 * **A missing signature is a failure, never a skip.** The single most common way signing gets
 * defeated is a code path that treats "no signature present" as "nothing to check". Here, an
 * unsigned artefact fails; installing one requires an explicit, recorded override.
 *
 * The framework ships no keys and no signatures of its own. It ships the verification, and a
 * deployment supplies the trust.
 */

export type SignatureAlgorithm = 'RSA-SHA256' | 'ECDSA-SHA256' | 'Ed25519';

export interface TrustedKey {
  /** Stable identifier, carried in the signature so the right key is chosen without guessing. */
  keyId: string;
  /** Who this key belongs to, for the audit record and the error message. */
  owner: string;
  algorithm: SignatureAlgorithm;
  /** PEM-encoded public key. Never a private key — nothing here signs. */
  publicKeyPem: string;
  /** ISO date. An expired key verifies nothing; rotation is a real operation. */
  expiresAt?: string;
  /** Revoked keys fail closed, whatever their expiry says. */
  revoked?: boolean;
}

export interface ArtifactSignature {
  keyId: string;
  algorithm: SignatureAlgorithm;
  /** Base64 signature over the canonical digest. */
  signature: string;
  /** SHA-256 of the artefact content, hex. Checked before the signature is even considered. */
  digest: string;
  signedAt?: string;
}

/** SHA-256 of a buffer or string, hex-encoded. */
export function digestOf(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * A stable digest over a set of files.
 *
 * Sorted by path, and each entry contributes both its path and its content hash. Hashing the
 * concatenated contents alone would give the same digest to two different file layouts — rename a
 * file and the archive verifies unchanged, which is exactly how a malicious `postinstall` gets
 * swapped in for a README.
 */
export function digestOfFiles(
  files: ReadonlyArray<{ path: string; content: Buffer | string }>,
): string {
  const hash = createHash('sha256');

  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(digestOf(file.content));
    hash.update('\n');
  }

  return hash.digest('hex');
}

/**
 * Whether two digests match, in constant time.
 *
 * A plain `===` on a hex digest leaks how many leading characters matched, which over enough
 * attempts narrows the search. The cost of not caring is small and the cost of caring is nothing.
 */
export function digestMatches(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;

  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(actual, 'utf8'));
}

export type VerificationOutcome =
  | { trusted: true; keyId: string; owner: string }
  | { trusted: false; reason: string; code: string };

/**
 * Verifies an artefact against a set of trusted keys.
 *
 * The order is deliberate: content first, then key, then signature. Checking the signature before
 * the digest would mean a valid signature over a *different* digest passes — the signature is
 * over the digest, so the digest has to be the one the artefact actually has.
 */
export function verifyArtifact(options: {
  content: Buffer | string;
  signature: ArtifactSignature | null | undefined;
  trustedKeys: readonly TrustedKey[];
  /** For expiry. Injected so a test is not at the mercy of the clock. */
  now?: Date;
}): VerificationOutcome {
  const { content, signature, trustedKeys } = options;
  const now = options.now ?? new Date();

  if (!signature) {
    return {
      trusted: false,
      code: 'unsigned',
      reason:
        'The artefact carries no signature. Unsigned is a failure, not a skip — installing it ' +
        'requires an explicit --allow-unsigned, which is recorded.',
    };
  }

  const actualDigest = digestOf(content);

  if (!digestMatches(signature.digest, actualDigest)) {
    return {
      trusted: false,
      code: 'digest_mismatch',
      reason:
        `The content does not match the signed digest. Expected ${signature.digest.slice(0, 16)}…, ` +
        `got ${actualDigest.slice(0, 16)}…. The artefact was modified after it was signed.`,
    };
  }

  const key = trustedKeys.find((candidate) => candidate.keyId === signature.keyId);

  if (!key) {
    return {
      trusted: false,
      code: 'unknown_key',
      reason:
        `Signed with key "${signature.keyId}", which is not in the trust store. Add the key ` +
        'deliberately — a key added because an install asked for it is not a trust decision.',
    };
  }

  if (key.revoked) {
    return {
      trusted: false,
      code: 'key_revoked',
      reason: `Key "${key.keyId}" (${key.owner}) has been revoked.`,
    };
  }

  if (key.expiresAt && new Date(key.expiresAt) <= now) {
    return {
      trusted: false,
      code: 'key_expired',
      reason: `Key "${key.keyId}" (${key.owner}) expired on ${key.expiresAt.slice(0, 10)}.`,
    };
  }

  if (key.algorithm !== signature.algorithm) {
    /*
     * An algorithm confusion attack: present a signature claiming a weaker algorithm than the key
     * was issued for and hope the verifier honours the claim. The key decides, not the artefact.
     */
    return {
      trusted: false,
      code: 'algorithm_mismatch',
      reason:
        `The signature claims ${signature.algorithm} but key "${key.keyId}" is a ` +
        `${key.algorithm} key. The key decides the algorithm, not the artefact.`,
    };
  }

  const valid = verifySignature(signature, key);

  if (!valid) {
    return {
      trusted: false,
      code: 'bad_signature',
      reason: `The signature does not verify against key "${key.keyId}" (${key.owner}).`,
    };
  }

  return { trusted: true, keyId: key.keyId, owner: key.owner };
}

function verifySignature(signature: ArtifactSignature, key: TrustedKey): boolean {
  try {
    if (key.algorithm === 'Ed25519') {
      // Ed25519 has no separate hash step; `verify` takes the data directly.
      return verifyEd25519(
        null,
        Buffer.from(signature.digest, 'utf8'),
        key.publicKeyPem,
        Buffer.from(signature.signature, 'base64'),
      );
    }

    const verifier = createVerify('SHA256');
    verifier.update(signature.digest);
    verifier.end();

    return verifier.verify(key.publicKeyPem, Buffer.from(signature.signature, 'base64'));
  } catch {
    /*
     * A malformed key or signature is a verification failure, not an exception to propagate. An
     * attacker who can make the verifier throw can make a caller that forgot a try/catch skip the
     * check entirely.
     */
    return false;
  }
}

/**
 * Refuses an artefact that does not verify.
 *
 * `allowUnsigned` exists because a developer building a plugin locally cannot sign every
 * iteration. It permits exactly one failure code — `unsigned` — and never a bad signature, an
 * unknown key or a revoked one. Those are not "unsigned"; they are "signed by someone you do not
 * trust", and no flag should turn that into a warning.
 */
export function assertTrusted(
  outcome: VerificationOutcome,
  options: { artifact: string; allowUnsigned?: boolean } = { artifact: 'artifact' },
): void {
  if (outcome.trusted) return;

  if (options.allowUnsigned && outcome.code === 'unsigned') return;

  throw ApiError.forbidden(`Refusing to install "${options.artifact}": ${outcome.reason}`, {
    code: outcome.code,
  });
}
