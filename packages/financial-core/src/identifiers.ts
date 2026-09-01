import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';

/**
 * Financial identifiers and references.
 *
 * Two things live here, and they answer different questions.
 *
 * A **financial identifier** is what the system calls something: `txn_...`, `jrn_...`, `wlt_...`.
 * Prefixed, because an id that appears in a log, a support ticket or an error message should say
 * what it is without anybody looking it up — and because a prefix makes "this wallet id was passed
 * where a transaction id was expected" a validation failure rather than a not-found.
 *
 * A **reference** is what a *person* calls it: an invoice number, a payment reference, an external
 * system's id. These are the strings that end up on a bank statement and in a customer's email,
 * and the rules for them are different: they are typed by humans, compared by humans, and read
 * aloud over the phone.
 */

export const ID_PREFIXES = {
  account: 'acc',
  journal: 'jrn',
  entry: 'ent',
  transaction: 'txn',
  wallet: 'wlt',
  hold: 'hld',
  payment: 'pay',
  settlementBatch: 'stb',
  settlementInstruction: 'sti',
  reconciliation: 'rec',
  exception: 'exc',
  fee: 'fee',
  rate: 'rte',
  limit: 'lmt',
} as const;

export type FinancialEntity = keyof typeof ID_PREFIXES;

/**
 * A new identifier.
 *
 * A UUID rather than a sequence, and the reason is not scalability. A sequential financial id
 * leaks volume: a competitor who makes two payments a day apart can read the number of
 * transactions between them off the identifiers. It is also guessable, which matters for anything
 * that appears in a URL.
 */
export function newFinancialId(entity: FinancialEntity): string {
  return `${ID_PREFIXES[entity]}_${randomUUID().replace(/-/g, '')}`;
}

/** Whether an id belongs to the entity it is being used as. */
export function isFinancialId(value: string, entity: FinancialEntity): boolean {
  return value.startsWith(`${ID_PREFIXES[entity]}_`);
}

/**
 * Refuses an id of the wrong kind.
 *
 * Called where an id crosses a boundary. Passing a wallet id where a transaction id belongs
 * otherwise produces a not-found several layers down, and the message names the wrong thing.
 */
export function assertFinancialId(value: string, entity: FinancialEntity, field = 'id'): void {
  if (!isFinancialId(value, entity)) {
    const actual = /^([a-z]+)_/.exec(value)?.[1];
    const named = actual
      ? Object.entries(ID_PREFIXES).find(([, prefix]) => prefix === actual)?.[0]
      : undefined;

    throw ApiError.validation(
      [
        {
          path: field,
          message:
            `"${value}" is not a ${entity} id. ` +
            (named
              ? `It is a ${named} id — the two were probably transposed at the call site.`
              : `A ${entity} id starts with "${ID_PREFIXES[entity]}_".`),
        },
      ],
      `Wrong kind of identifier for ${field}.`,
    );
  }
}

/**
 * A human-facing reference.
 *
 * Upper-case alphanumeric with dashes, 4 to 64 characters. Restricted because these strings are
 * typed by people into forms, compared by people against statements, and read aloud over the
 * phone — so lower case, spaces and punctuation all become support tickets.
 */
export const referenceSchema = z
  .string()
  .min(4)
  .max(64)
  .regex(
    /^[A-Z0-9][A-Z0-9-]*[A-Z0-9]$/,
    'A reference is upper-case letters, digits and dashes, and does not start or end with a dash.',
  );

/**
 * Characters excluded from a generated reference.
 *
 * `0`/`O`, `1`/`I`/`L`, `5`/`S`, `8`/`B`, `2`/`Z` are the pairs people confuse when reading a code
 * aloud or copying it off a screen. Dropping one of each turns a class of support ticket into a
 * shorter alphabet.
 */
const REFERENCE_ALPHABET = '34679ACDEFGHJKMNPQRTUVWXY';

/**
 * A readable reference, optionally prefixed.
 *
 * Not a UUID: nobody reads a UUID over the phone. Twelve characters from a 25-character alphabet
 * is about 55 bits, which is far more than enough for uniqueness within a tenant and short enough
 * to appear on a receipt.
 */
export function newReference(prefix = '', length = 12): string {
  const bytes = randomUUID().replace(/-/g, '');
  let out = '';

  for (let index = 0; index < length; index += 1) {
    const byte = Number.parseInt(bytes.slice(index * 2, index * 2 + 2) || '0', 16);
    out += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  }

  return prefix ? `${prefix.toUpperCase()}-${out}` : out;
}

/**
 * An idempotency key derived from a request.
 *
 * The key is a hash of everything that makes the request *this* request. Two callers sending the
 * same payment twice produce the same key and get one payment; two callers sending genuinely
 * different payments that happen to share an amount produce different keys.
 *
 * The organization is in the hash and it is not optional. A key scoped only to its own value lets
 * one tenant's retry collide with another tenant's first attempt — which returns one tenant the
 * other's transaction, and it looks like a successful idempotent replay.
 */
export function idempotencyKey(input: {
  organizationId: string | null;
  operation: string;
  /** Everything that distinguishes this request. Ordered by key, so field order does not matter. */
  parts: Record<string, string | number | boolean | null | undefined>;
}): string {
  const canonical = Object.entries(input.parts)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('&');

  const material = `${input.organizationId ?? 'platform'}|${input.operation}|${canonical}`;

  return `idm_${createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
}

/**
 * The lifecycle states a financial object can be in.
 *
 * Shared, so "what does completed mean" has one answer across transactions, settlements and
 * payment requests. Each package narrows this to the subset it uses; none of them invents a
 * synonym.
 */
export const FINANCIAL_STATUSES = [
  'pending',
  'authorized',
  'captured',
  'completed',
  'failed',
  'cancelled',
  'expired',
  'reversed',
  'refunded',
] as const;

export type FinancialStatus = (typeof FINANCIAL_STATUSES)[number];

/** Statuses from which nothing further happens. A decision on one of these is refused. */
export const TERMINAL_STATUSES: ReadonlySet<FinancialStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'expired',
  'reversed',
  'refunded',
]);

export function isTerminal(status: FinancialStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** What each status means, for an error message or an operator screen. */
export const STATUS_DESCRIPTIONS: Record<FinancialStatus, string> = {
  pending: 'Created and not yet acted on. No money has moved.',
  authorized: 'Funds are held against the payer but not yet taken.',
  captured: 'Funds have been taken and are not yet settled.',
  completed: 'Finished. The ledger reflects it and nothing further will happen.',
  failed: 'Did not succeed. Any hold has been released.',
  cancelled: 'Stopped before completion, deliberately.',
  expired: 'Not acted on within its window. Any hold has been released.',
  reversed: 'Undone by a compensating journal. The original posting still exists.',
  refunded: 'Returned to the payer, wholly or partly, by a separate transaction.',
};
