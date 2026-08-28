import { ApiError } from '@trustos/errors';
import type { LockoutPolicy } from '@trustos/security-policy';

/**
 * Failed-login tracking and temporary lockout.
 *
 * Two controls that are often confused, doing different jobs:
 *
 *   **Rate limiting** (`@trustos/security-policy`) bounds how fast anyone can try,
 *   per address and per identifier. It protects the service.
 *
 *   **Lockout** — here — bounds how many times *one account* can be guessed at
 *   before it stops answering, regardless of how slowly. It protects the account.
 *
 * A deployment needs both: rate limiting alone lets a patient attacker grind one
 * account forever, and lockout alone lets a fast one spray one guess across every
 * account.
 *
 * Lockout is temporary, never permanent. A permanent lock is a denial-of-service
 * primitive: anyone who knows an email address can disable it, and the recovery
 * path becomes a support queue.
 */

export interface LockoutState {
  /** Correlation key — a hashed identifier, never a raw email. */
  key: string;
  failures: number;
  firstFailureAt: Date;
  lastFailureAt: Date;
  lockedUntil: Date | null;
}

export interface LockoutStore {
  read(key: string): Promise<LockoutState | null>;
  write(state: LockoutState): Promise<void>;
  clear(key: string): Promise<void>;
}

/**
 * In-memory store. Process-local, which is stated rather than hidden.
 *
 * With several instances behind a load balancer, an account tolerates
 * `maxFailedAttempts × instances` guesses before locking anywhere. That is a real
 * weakening, and it is why `LockoutStore` is a port — the same shape implemented
 * over the application's database makes the count global. The framework adds no
 * Redis.
 */
export class InMemoryLockoutStore implements LockoutStore {
  private readonly states = new Map<string, LockoutState>();

  async read(key: string): Promise<LockoutState | null> {
    return this.states.get(key) ?? null;
  }

  async write(state: LockoutState): Promise<void> {
    this.states.set(state.key, { ...state });
  }

  async clear(key: string): Promise<void> {
    this.states.delete(key);
  }

  size(): number {
    return this.states.size;
  }
}

export interface LockoutDecision {
  locked: boolean;
  /** Attempts left before the account locks. */
  remaining: number;
  lockedUntil: Date | null;
}

export class LockoutTracker {
  constructor(
    private readonly store: LockoutStore,
    private readonly policy: LockoutPolicy,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Whether the account is currently locked.
   *
   * Called *before* the password is verified, so a locked account does not spend
   * hashing time — and, more importantly, so a lockout cannot be used as an
   * oracle: the response is identical whether or not the password was right.
   */
  async check(key: string): Promise<LockoutDecision> {
    const state = await this.store.read(key);
    const now = this.now();

    if (!state) {
      return { locked: false, remaining: this.policy.maxFailedAttempts, lockedUntil: null };
    }

    if (state.lockedUntil && state.lockedUntil.getTime() > now.getTime()) {
      return { locked: true, remaining: 0, lockedUntil: state.lockedUntil };
    }

    // The lock has expired, or the failure window has passed. Either way the
    // count starts again — which is what makes the lock temporary.
    if (
      state.lockedUntil ||
      now.getTime() - state.firstFailureAt.getTime() > this.policy.failureWindowSeconds * 1000
    ) {
      await this.store.clear(key);
      return { locked: false, remaining: this.policy.maxFailedAttempts, lockedUntil: null };
    }

    return {
      locked: false,
      remaining: Math.max(0, this.policy.maxFailedAttempts - state.failures),
      lockedUntil: null,
    };
  }

  /** Records a failure and locks the account when the threshold is reached. */
  async recordFailure(key: string): Promise<LockoutDecision> {
    const now = this.now();
    const existing = await this.store.read(key);

    const withinWindow =
      existing !== null &&
      now.getTime() - existing.firstFailureAt.getTime() <= this.policy.failureWindowSeconds * 1000;

    const failures = withinWindow ? existing.failures + 1 : 1;
    const locked = failures >= this.policy.maxFailedAttempts;

    const state: LockoutState = {
      key,
      failures,
      firstFailureAt: withinWindow && existing ? existing.firstFailureAt : now,
      lastFailureAt: now,
      lockedUntil: locked ? new Date(now.getTime() + this.policy.lockoutSeconds * 1000) : null,
    };

    await this.store.write(state);

    return {
      locked,
      remaining: Math.max(0, this.policy.maxFailedAttempts - failures),
      lockedUntil: state.lockedUntil,
    };
  }

  /**
   * Clears the count after a successful login.
   *
   * So a person who mistyped their password twice this morning is not locked out
   * this afternoon by two more mistakes.
   */
  async recordSuccess(key: string): Promise<void> {
    await this.store.clear(key);
  }

  /** Administrative unlock. */
  async unlock(key: string): Promise<void> {
    await this.store.clear(key);
  }
}

/**
 * The message every local authentication failure produces.
 *
 * One constant, used by both the wrong-password path and the locked-account path,
 * because the two must be indistinguishable to a caller. Defined here rather than in
 * the provider so the lockout error cannot drift away from it — which is exactly what
 * happened the first time these were written separately, and what a test now catches.
 */
export const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password.';

/**
 * The error a locked account produces.
 *
 * `unauthorized`, with the *same* client-facing message as a wrong password. "This
 * account is locked" confirms the account exists, which is exactly what an
 * enumeration attempt is looking for. The lock, the remaining attempts and the unlock
 * time go in the context, where operators and the security event see them and the
 * caller does not.
 */
export function lockedOutError(decision: LockoutDecision): ApiError {
  return ApiError.unauthorized(INVALID_CREDENTIALS_MESSAGE, {
    reason: 'account_locked',
    lockedUntil: decision.lockedUntil?.toISOString() ?? null,
  });
}
