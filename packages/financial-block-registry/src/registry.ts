import { productError } from '@trustos/financial-product-core';
import { BLOCK_CATALOG } from './catalog';
import {
  BLOCK_CATEGORIES,
  blockDefinitionSchema,
  patternAdmits,
  type BlockCategory,
  type BlockDefinition,
} from './schema';

/**
 * The registry.
 *
 * Answers four questions the composer and the runtime ask constantly, and refuses rather than
 * returning `undefined` for three of them. The distinction matters: `find` is a lookup and may
 * legitimately miss, but `require` is on the path where a product is being validated or
 * executed, and a `undefined` there would be turned into a default by whichever caller forgot to
 * check.
 *
 * Blocks are versioned, and a product pins an **exact** version. There is no range resolution and
 * no "latest": a product approved against `wallet.debit@1.0.0` executes against `1.0.0` until
 * somebody re-approves it against `1.1.0`. A range would let a block change under a published
 * product, which is the same failure as editing the product — with the additional property that
 * nobody looking at the product would see it.
 */
export class BlockRegistry {
  private readonly byKey = new Map<string, BlockDefinition>();
  private readonly byId = new Map<string, BlockDefinition[]>();

  constructor(blocks: readonly BlockDefinition[] = BLOCK_CATALOG) {
    for (const block of blocks) this.register(block);
  }

  /**
   * Adds a block.
   *
   * Parses first, even for the built-in catalog. The catalog is already parsed at module load, so
   * this is redundant there — and it is the check that catches a deployment registering its own
   * block from a JSON file, which is the case that matters.
   */
  register(input: unknown): BlockDefinition {
    const block = blockDefinitionSchema.parse(input);
    const key = versionKey(block.blockId, block.version);

    if (this.byKey.has(key)) {
      throw productError(
        'product_definition_invalid',
        `Block ${key} is already registered. A second registration of the same version means ` +
          'load order decides which contract applies.',
        { expected: 'a unique block version', actual: key },
      );
    }

    this.byKey.set(key, block);
    this.byId.set(block.blockId, [...(this.byId.get(block.blockId) ?? []), block]);
    return block;
  }

  find(blockId: string, version: string): BlockDefinition | undefined {
    return this.byKey.get(versionKey(blockId, version));
  }

  /**
   * The block, or a refusal.
   *
   * The message distinguishes "no such block" from "no such version of that block", because the
   * two have different fixes and a caller who cannot tell them apart tries the wrong one first.
   */
  require(blockId: string, version: string): BlockDefinition {
    const block = this.find(blockId, version);
    if (block) return block;

    const versions = this.byId.get(blockId);
    if (!versions || versions.length === 0) {
      throw productError(
        'product_block_not_approved',
        `No approved block "${blockId}". Products may only use blocks from the approved catalog.`,
        { expected: 'an approved block', actual: blockId },
      );
    }

    throw productError(
      'product_block_not_approved',
      `Block "${blockId}" has no version ${version}. Approved versions: ` +
        `${versions.map((candidate) => candidate.version).join(', ')}.`,
      { expected: versions.map((candidate) => candidate.version).join(', '), actual: version },
    );
  }

  /**
   * The block, refusing one that is not usable in a product being composed.
   *
   * A draft block is not composable; a withdrawn one is not either. A **deprecated** one is —
   * deliberately. Refusing it would break every published product that contains it the moment
   * somebody deprecates a block, and the point of deprecation is to signal without breaking. The
   * composer warns instead; see `@trustos/financial-product-composer`.
   */
  requireComposable(blockId: string, version: string): BlockDefinition {
    const block = this.require(blockId, version);

    if (block.lifecycleStatus === 'draft' || block.lifecycleStatus === 'withdrawn') {
      throw productError(
        'product_block_not_approved',
        `Block "${blockId}@${version}" is ${block.lifecycleStatus} and may not be composed into ` +
          'a product. Only approved and deprecated blocks are composable.',
        { expected: 'approved', actual: block.lifecycleStatus },
      );
    }

    return block;
  }

  /** Every version of a block, newest declaration last. */
  versions(blockId: string): BlockDefinition[] {
    return [...(this.byId.get(blockId) ?? [])];
  }

  byCategory(category: BlockCategory): BlockDefinition[] {
    return [...this.byKey.values()]
      .filter((block) => block.category === category)
      .sort((left, right) => left.blockId.localeCompare(right.blockId));
  }

  all(): BlockDefinition[] {
    return [...this.byKey.values()];
  }

  categories(): BlockCategory[] {
    return BLOCK_CATEGORIES.filter((category) => this.byCategory(category).length > 0);
  }

  /**
   * Whether one block may follow another.
   *
   * An empty `allowedNext` means "anything approved", which is right for a lookup and wrong for
   * anything that moves money — so every money-moving block in the catalog names its successors.
   * The check is here rather than in the composer because the runtime asks it too, on the path
   * where a rule's `route` outcome proposes a jump the graph did not declare.
   */
  transitionAllowed(fromBlockId: string, fromVersion: string, toBlockId: string): boolean {
    const from = this.find(fromBlockId, fromVersion);
    if (!from) return false;
    if (from.allowedNext.length === 0) return true;
    return from.allowedNext.some((pattern) => patternAdmits(pattern, toBlockId));
  }

  size(): number {
    return this.byKey.size;
  }
}

function versionKey(blockId: string, version: string): string {
  return `${blockId}@${version}`;
}

/** The framework's approved catalog. Built once; a deployment may add to a copy, never to this. */
export const APPROVED_BLOCKS = new BlockRegistry();

/** Summary counts, for the CLI and the admin catalog page. */
export function blockCatalogSummary(registry: BlockRegistry = APPROVED_BLOCKS): {
  total: number;
  byCategory: Record<string, number>;
  movesMoney: number;
  requiresProvider: number;
} {
  const byCategory: Record<string, number> = {};
  for (const category of registry.categories()) {
    byCategory[category] = registry.byCategory(category).length;
  }

  return {
    total: registry.size(),
    byCategory,
    movesMoney: registry.all().filter((block) => block.monetaryEffect === 'moves').length,
    requiresProvider: registry.all().filter((block) => block.providerInterface !== undefined)
      .length,
  };
}
