import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import { combineClassifications, type DataClassificationLevel } from '@trustos/data-classification';
import type { DataCatalog } from '@trustos/data-catalog';

/**
 * Data lineage.
 *
 * Where governed data came from and where it goes. A graph of catalog entries joined by edges
 * that say *how* — copied, transformed, aggregated, published as an event, exposed on an API,
 * indexed for retrieval.
 *
 * **This is not an ETL scanner and does not try to be.** A scanner that parses SQL and infers
 * lineage is a large, fragile piece of work that is right about the queries it understands and
 * silent about the ones it does not — and "silent" in a lineage graph reads exactly like "no
 * dependency". So lineage here is *declared*, with an extension interface for a deployment that
 * has a scanner and wants to feed it in.
 *
 * The two questions it exists to answer, and neither is answerable without it:
 *
 * **"If we delete this, what breaks?"** — `downstreamOf`. Asked before every retention deletion
 * and every schema change.
 *
 * **"This report contains restricted data. Where did it come from?"** — `upstreamOf`, plus
 * `propagatedClassification`, which computes what a node *actually* carries from what flows into
 * it. A report whose sources include a restricted column is restricted, whatever it was declared
 * as, and that inference is the whole reason to have a graph rather than a list.
 */

export const LINEAGE_RELATIONS = [
  'copied_from',
  'transformed_from',
  'aggregated_from',
  'published_as_event',
  'exposed_via_api',
  'rendered_in_report',
  'indexed_for_retrieval',
  'replicated_to',
] as const;

export type LineageRelation = (typeof LINEAGE_RELATIONS)[number];

/**
 * Relations that **weaken** the classification they carry.
 *
 * Only one, and it is deliberately the only one: an aggregate of a restricted column may be
 * genuinely less sensitive — a count of transactions is not a transaction. It is declared per
 * edge rather than inferred, and it is the single place a classification is permitted to drop.
 *
 * Everything else propagates the source's classification unchanged, because a copy of restricted
 * data is restricted data and a transformation of it usually is too.
 */
const MAY_DECLASSIFY: ReadonlySet<LineageRelation> = new Set(['aggregated_from']);

export const lineageEdgeSchema = z
  .object({
    /** The catalog entry the data comes from. */
    fromEntryId: z.string().min(1).max(120),
    /** The catalog entry it goes to. */
    toEntryId: z.string().min(1).max(120),
    relation: z.enum(LINEAGE_RELATIONS),
    /** What the transformation does, in a sentence. Required for anything but a plain copy. */
    description: z.string().max(400).optional(),
    /**
     * Whether this edge declassifies, and to what.
     *
     * Only permitted on an aggregating edge, and it must be **stated with a reason** — an
     * aggregate that declassifies without saying why is a re-labelling, and the label is what
     * every downstream control reads.
     */
    declassifiesTo: z
      .enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'HIGHLY_RESTRICTED'])
      .optional(),
    declassificationReason: z.string().max(400).optional(),
    /** Where this edge came from: a person, or a scanner a deployment wired. */
    source: z.enum(['declared', 'scanned', 'inferred']).default('declared'),
    recordedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((edge, ctx) => {
    if (edge.fromEntryId === edge.toEntryId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toEntryId'],
        message: 'An edge to itself is a cycle of length one.',
      });
    }

    if (edge.declassifiesTo && !MAY_DECLASSIFY.has(edge.relation)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['declassifiesTo'],
        message:
          `A "${edge.relation}" edge cannot declassify. A copy of restricted data is restricted ` +
          'data. Only an aggregate may genuinely be less sensitive than its source.',
      });
    }

    if (edge.declassifiesTo && (edge.declassificationReason ?? '').trim().length < 20) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['declassificationReason'],
        message:
          'A declassifying edge needs a reason of at least twenty characters. Without one it is ' +
          'a re-labelling, and the label is what every downstream control reads.',
      });
    }
  });

export type LineageEdge = z.infer<typeof lineageEdgeSchema>;

export interface LineagePath {
  nodes: string[];
  relations: LineageRelation[];
}

export class LineageGraph {
  private readonly outgoing = new Map<string, LineageEdge[]>();
  private readonly incoming = new Map<string, LineageEdge[]>();

  constructor(edges: readonly LineageEdge[] = []) {
    for (const edge of edges) this.record(edge);
  }

  record(input: unknown): LineageEdge {
    const edge = lineageEdgeSchema.parse(input);

    this.outgoing.set(edge.fromEntryId, [...(this.outgoing.get(edge.fromEntryId) ?? []), edge]);
    this.incoming.set(edge.toEntryId, [...(this.incoming.get(edge.toEntryId) ?? []), edge]);

    return edge;
  }

  /**
   * Everything downstream of an entry.
   *
   * The "if we delete this, what breaks" query. Breadth-first with a visited set, so a cyclic
   * graph terminates — lineage graphs do contain cycles in practice, because a report feeds a
   * table that feeds the report next quarter.
   */
  downstreamOf(entryId: string, maxDepth = 20): string[] {
    return this.walk(entryId, this.outgoing, (edge) => edge.toEntryId, maxDepth);
  }

  /** Everything upstream. The "where did this come from" query. */
  upstreamOf(entryId: string, maxDepth = 20): string[] {
    return this.walk(entryId, this.incoming, (edge) => edge.fromEntryId, maxDepth);
  }

  private walk(
    start: string,
    index: Map<string, LineageEdge[]>,
    next: (edge: LineageEdge) => string,
    maxDepth: number,
  ): string[] {
    const seen = new Set<string>([start]);
    const result: string[] = [];
    let frontier = [start];
    let depth = 0;

    while (frontier.length > 0 && depth < maxDepth) {
      const following: string[] = [];

      for (const node of frontier) {
        for (const edge of index.get(node) ?? []) {
          const target = next(edge);
          if (seen.has(target)) continue;

          seen.add(target);
          result.push(target);
          following.push(target);
        }
      }

      frontier = following;
      depth += 1;
    }

    return result;
  }

  /**
   * What an entry actually carries, given everything that flows into it.
   *
   * The highest classification of its own and every upstream source — except across a declared
   * declassifying edge, where the edge's stated level applies instead.
   *
   * This is the inference that makes lineage worth maintaining. A report declared `INTERNAL`
   * whose sources include a restricted column is restricted, and nobody would have noticed by
   * reading the report's own row.
   */
  propagatedClassification(
    entryId: string,
    catalog: DataCatalog,
    visited: Set<string> = new Set(),
  ): DataClassificationLevel {
    if (visited.has(entryId)) return catalog.require(entryId).classification;
    visited.add(entryId);

    const own = catalog.inheritedClassification(entryId);

    const upstream = (this.incoming.get(entryId) ?? []).map((edge) =>
      edge.declassifiesTo
        ? edge.declassifiesTo
        : this.propagatedClassification(edge.fromEntryId, catalog, visited),
    );

    return combineClassifications(own, ...upstream);
  }

  /** Entries whose declared classification is below what flows into them. */
  classificationDrift(catalog: DataCatalog): Array<{
    entryId: string;
    declared: DataClassificationLevel;
    propagated: DataClassificationLevel;
  }> {
    return catalog
      .all()
      .map((entry) => ({
        entryId: entry.entryId,
        declared: entry.classification,
        propagated: this.propagatedClassification(entry.entryId, catalog),
      }))
      .filter((entry) => entry.declared !== entry.propagated);
  }

  edgesFrom(entryId: string): LineageEdge[] {
    return [...(this.outgoing.get(entryId) ?? [])];
  }

  edgesTo(entryId: string): LineageEdge[] {
    return [...(this.incoming.get(entryId) ?? [])];
  }

  size(): number {
    return [...this.outgoing.values()].reduce((total, edges) => total + edges.length, 0);
  }
}

/**
 * The extension point for a deployment that has a scanner.
 *
 * A scanner produces edges; this consumes them. What it does **not** do is trust them more than
 * declared ones: a scanned edge is recorded with `source: 'scanned'` so that a lineage report can
 * distinguish "somebody said so" from "a tool inferred it", and an investigation can weigh them
 * differently.
 */
export interface LineageScanner {
  readonly name: string;
  scan(): Promise<LineageEdge[]>;
}

export async function importScanned(
  graph: LineageGraph,
  scanner: LineageScanner,
): Promise<{ imported: number; rejected: Array<{ edge: unknown; reason: string }> }> {
  const edges = await scanner.scan();
  const rejected: Array<{ edge: unknown; reason: string }> = [];
  let imported = 0;

  for (const edge of edges) {
    try {
      graph.record({ ...edge, source: 'scanned' });
      imported += 1;
    } catch (error) {
      /*
       * A rejected edge is reported, never dropped.
       *
       * A scanner that silently loses edges produces a lineage graph that is confidently
       * incomplete, and the gaps are invisible — which is worse than having no graph, because
       * somebody will answer "what breaks if we delete this" from it.
       */
      rejected.push({
        edge,
        reason: error instanceof ApiError ? error.message : String(error),
      });
    }
  }

  return { imported, rejected };
}
