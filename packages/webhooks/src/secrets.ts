import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ApiError } from '@trustos/errors';
import type { SecretCipher } from './ports';

/**
 * Encrypting webhook secrets at rest.
 *
 * AES-256-GCM. Authenticated, so a modified ciphertext fails to decrypt rather than producing
 * plausible-looking garbage that then signs every delivery with the wrong key — a failure that
 * would present as "the receiver rejects everything" and take a day to trace.
 *
 * A fresh random IV per encryption, stored alongside the ciphertext. Reusing an IV with GCM is
 * catastrophic rather than merely weak: it leaks the XOR of the plaintexts and, worse, allows
 * forgery of the authentication tag. This is the single most important line in the file.
 *
 * Format: `v1.<iv-base64>.<tag-base64>.<ciphertext-base64>`. Versioned so a future algorithm
 * change can decrypt old values instead of orphaning every existing endpoint.
 */

const ALGORITHM = 'aes-256-gcm';
const FORMAT_VERSION = 'v1';
const IV_BYTES = 12; // 96 bits, the size GCM is specified for.

export class AesSecretCipher implements SecretCipher {
  private readonly key: Buffer;

  /**
   * @param encryptionKey At least 32 characters. Derived to 32 bytes with SHA-256.
   *
   * Derivation rather than requiring exactly 32 raw bytes, because an operator setting an
   * environment variable will supply a passphrase, and rejecting it would send them to
   * `head -c 32 /dev/urandom | base64` — which produces 44 characters and fails the check anyway.
   * SHA-256 of a high-entropy passphrase is a reasonable key; SHA-256 of "password" is not, which
   * is what the length floor is for.
   */
  constructor(encryptionKey: string) {
    if (!encryptionKey || encryptionKey.length < 32) {
      throw ApiError.internal(
        'The webhook secret encryption key must be at least 32 characters. Generate one with ' +
          '`openssl rand -base64 48` and set WEBHOOK_ENCRYPTION_KEY.',
      );
    }

    this.key = createHash('sha256').update(encryptionKey).digest();
  }

  async encrypt(plaintext: string): Promise<string> {
    // A fresh IV every time. Never derived from the plaintext, never a counter held in memory —
    // a process restart would reset a counter and reuse the IV, which is the catastrophic case.
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);

    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
      FORMAT_VERSION,
      iv.toString('base64'),
      tag.toString('base64'),
      encrypted.toString('base64'),
    ].join('.');
  }

  async decrypt(ciphertext: string): Promise<string> {
    const parts = ciphertext.split('.');

    if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
      throw ApiError.internal(
        'A stored webhook secret is not in the expected format. It was written by a different ' +
          'version, or the column has been altered.',
      );
    }

    const [, ivPart, tagPart, dataPart] = parts as [string, string, string, string];

    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivPart, 'base64'));
      decipher.setAuthTag(Buffer.from(tagPart, 'base64'));

      return Buffer.concat([
        decipher.update(Buffer.from(dataPart, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      /*
       * The two causes are indistinguishable here, and the message says both.
       *
       * Either the key changed — a rotated environment variable, a restored database pointed at a
       * different deployment — or the ciphertext was tampered with. Guessing at one would send
       * somebody down the wrong path at the worst time.
       */
      throw ApiError.internal(
        'A webhook secret could not be decrypted. Either WEBHOOK_ENCRYPTION_KEY has changed ' +
          'since it was written, or the stored value has been modified.',
      );
    }
  }
}

/**
 * A cipher that stores plaintext.
 *
 * For tests only, and it says so in its name so nobody wires it up by accident. A deployment
 * that ends up here has webhook secrets readable by anybody with a database connection — which
 * means anybody who can forge a signed request to every one of that tenant's endpoints.
 */
export class PlaintextSecretCipher implements SecretCipher {
  async encrypt(plaintext: string): Promise<string> {
    return plaintext;
  }

  async decrypt(ciphertext: string): Promise<string> {
    return ciphertext;
  }
}

/**
 * The last four characters of a secret.
 *
 * Enough for an integrator to confirm which secret they have configured, useless to anybody who
 * does not already hold it. Four characters of a 64-character hex string leaves 2^240 — the hint
 * is not what an attacker would attack.
 */
export function secretHint(secret: string): string {
  return secret.slice(-4);
}
