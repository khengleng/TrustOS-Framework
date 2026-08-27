import { createHash, randomUUID } from 'node:crypto';

/**
 * Identifiers and content hashes for the product layer.
 *
 * Two separate concerns live here because they answer the same question from opposite ends.
 * An identifier says *which* product this is; a content hash says *whether this is still the
 * product that was approved*. A layer that has the first and not the second can tell you a
 * transaction ran on `fprd_9c1…` and cannot tell you whether the definition behind that id is
 * the one risk signed off.
 */

export const PRODUCT_ID_PREFIXES = {
  product: 'fprd',
  version: 'fpvr',
  block: 'fpbk',
  connector: 'fpcn',
  variant: 'fpvt',
  execution: 'fpex',
  step: 'fpst',
  simulation: 'fpsm',
  sandboxRun: 'fpsb',
  rule: 'fprl',
  approval: 'fpap',
} as const;

export type ProductEntity = keyof typeof PRODUCT_ID_PREFIXES;

/**
 * A new identifier.
 *
 * A UUID rather than a sequence, for the reason `@trustos/financial-core` gives: a sequential id
 * leaks volume. It matters more here than there, because a product id appears in a public API
 * path and a competitor counting them learns how many products a bank launched last quarter.
 */
export function newProductId(entity: ProductEntity): string {
  return `${PRODUCT_ID_PREFIXES[entity]}_${randomUUID().replace(/-/g, '')}`;
}

export function isProductId(value: string, entity: ProductEntity): boolean {
  return value.startsWith(`${PRODUCT_ID_PREFIXES[entity]}_`);
}

/** The pattern a schema uses. Kept here so the prefix list has one owner. */
export function productIdPattern(entity: ProductEntity): RegExp {
  return new RegExp(`^${PRODUCT_ID_PREFIXES[entity]}_[0-9a-f]{32}$`);
}

/**
 * Canonical JSON.
 *
 * Object keys sorted, `undefined` dropped, arrays left in order. The point is that two
 * definitions that differ only in key order hash the same, and two that differ in any value at
 * all do not — so a hash comparison answers "was this edited" rather than "was this
 * re-serialized".
 *
 * `undefined` and a missing key are the same thing in JSON, and treating them differently would
 * make a round trip through a database change the hash of an unmodified definition.
 *
 * Numbers are a deliberate hazard and the reason every monetary value in this layer is a string:
 * `JSON.stringify(0.1 + 0.2)` is `0.30000000000000004`, so a hash over a float is a hash over a
 * rounding artefact. There is no float in a product definition, and `productContentHash` is not
 * the place that would notice one.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    result[key] = canonicalize(source[key]);
  }
  return result;
}

/**
 * The content hash of a product definition.
 *
 * This is what binds a running execution to the rules it started under. The runtime records the
 * hash at the moment it loads a definition and refuses to continue if the stored definition no
 * longer hashes to it — which is the only check that survives somebody editing a published row
 * directly in the database, and that is exactly the scenario worth surviving.
 */
export function productContentHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

/**
 * Whether two hashes match, in constant time.
 *
 * A hash comparison is not a secret comparison, so this is not about timing attacks. It is about
 * the habit: the day somebody compares a signature with `===` in this layer, the reviewer who
 * sees `hashesEqual` beside it has a reason to ask why.
 */
export function hashesEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
