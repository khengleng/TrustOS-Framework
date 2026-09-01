import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import { RETRY_PRESETS, withRetry, type RetryPolicy } from '@trustsystem/retry';

/**
 * Embedding provider abstraction.
 *
 * The thing this exists to prevent: **vectors from two different models in one index.**
 *
 * Embeddings from different models are not comparable. Not "less accurate" — meaningless. A
 * cosine similarity between a 1536-dimension OpenAI vector and a 768-dimension sentence-transformer
 * vector is a number with no relationship to whether the texts are related, and the failure is
 * silent: search still returns results, they are just arbitrary.
 *
 * So every vector carries the model that produced it and the dimension, and the vector store
 * refuses a mismatch. That check is the whole reason this package has a registry rather than
 * being a bare function.
 *
 * **The framework ships no embedding provider.** Same boundary as everywhere else in this phase.
 */

export const DISTANCE_METRICS = ['cosine', 'euclidean', 'dot_product'] as const;
export type DistanceMetric = (typeof DISTANCE_METRICS)[number];

export const embeddingModelSchema = z
  .object({
    /** The registry id an application asks for. */
    id: z.string().min(1).max(120),
    provider: z.string().min(1).max(60),
    providerModelId: z.string().min(1).max(200),

    /**
     * Vector length. Fixed per model, and the first thing a mismatch check compares.
     *
     * Recorded rather than discovered, so a misconfiguration is caught at start-up instead of by
     * a vector store rejecting a write halfway through an ingestion.
     */
    dimensions: z.number().int().min(1).max(16_384),

    /**
     * Which metric this model's vectors are meant to be compared with.
     *
     * Most text embedding models are trained for cosine. Using euclidean on vectors normalised for
     * cosine gives results that are wrong in a way that looks plausible — near-duplicates rank
     * correctly and everything else is noise.
     */
    metric: z.enum(DISTANCE_METRICS).default('cosine'),

    /** Longest input the model accepts, in tokens. Longer text must be chunked first. */
    maxInputTokens: z.number().int().min(1).default(8192),

    /** How many texts may be embedded in one call. */
    maxBatchSize: z.number().int().min(1).max(2048).default(96),

    /** Cents per million tokens. Embeddings are cheap individually and not in bulk. */
    centsPerMillionTokens: z.number().min(0).default(0),

    /**
     * A version marker.
     *
     * When a provider changes a model in place — which happens — this is what makes the change
     * visible. A vector store comparing it refuses to mix old and new vectors rather than
     * silently degrading every search.
     */
    version: z.string().max(60).default('1'),
  })
  .strict();

export type EmbeddingModel = z.infer<typeof embeddingModelSchema>;

/** A vector and everything needed to know whether it is comparable with another. */
export interface Embedding {
  vector: number[];
  /** The registry id of the model that produced it. */
  modelId: string;
  dimensions: number;
  version: string;
  /** Tokens consumed. For cost accounting. */
  tokens: number;
}

export interface EmbeddingProvider {
  readonly key: string;
  /** Embeds a batch. The provider decides how to split; the caller sees one call. */
  embed(input: { texts: string[]; model: EmbeddingModel; signal?: AbortSignal }): Promise<{
    vectors: number[][];
    tokens: number;
  }>;
  health?(): Promise<{ status: 'healthy' | 'degraded' | 'unavailable'; detail: string }>;
}

export interface EmbeddingServiceOptions {
  models: unknown[];
  providers: EmbeddingProvider[];
  retry?: RetryPolicy;
  /** Cache lookups, since the same text is embedded repeatedly during development. */
  cache?: {
    get(key: string): Promise<number[] | null>;
    set(key: string, vector: number[]): Promise<void>;
  };
}

export class EmbeddingService {
  private readonly models = new Map<string, EmbeddingModel>();
  private readonly providers = new Map<string, EmbeddingProvider>();

  constructor(private readonly options: EmbeddingServiceOptions) {
    for (const model of options.models) {
      const parsed = embeddingModelSchema.parse(model);

      if (this.models.has(parsed.id)) {
        throw ApiError.conflict(`An embedding model is already registered as "${parsed.id}".`, {
          reason: 'embedding_model_conflict',
          modelId: parsed.id,
        });
      }

      this.models.set(parsed.id, parsed);
    }

    for (const provider of options.providers) this.providers.set(provider.key, provider);
  }

  model(id: string): EmbeddingModel {
    const model = this.models.get(id);

    if (!model) {
      throw ApiError.validation(
        [
          {
            path: 'modelId',
            message:
              `No embedding model "${id}" is registered. Registered: ` +
              `${[...this.models.keys()].sort().join(', ') || '(none)'}. The framework ships none.`,
          },
        ],
        `Unknown embedding model "${id}".`,
      );
    }

    return model;
  }

  /**
   * Embeds texts.
   *
   * Batched according to the model's limit, so a caller passing ten thousand chunks does not have
   * to know what the provider accepts. Retried, because an embedding call failing mid-ingestion
   * would otherwise leave a knowledge base half-indexed and nobody would know which half.
   */
  async embed(input: {
    texts: string[];
    modelId: string;
    signal?: AbortSignal;
  }): Promise<{ embeddings: Embedding[]; totalTokens: number; costCents: number }> {
    if (input.texts.length === 0) {
      return { embeddings: [], totalTokens: 0, costCents: 0 };
    }

    const model = this.model(input.modelId);
    const provider = this.providers.get(model.provider);

    if (!provider) {
      throw ApiError.internal(
        `No embedding provider is registered for "${model.provider}", which the model ` +
          `"${model.id}" needs. The framework ships no embedding providers.`,
      );
    }

    const embeddings: Embedding[] = [];
    let totalTokens = 0;

    for (let start = 0; start < input.texts.length; start += model.maxBatchSize) {
      const batch = input.texts.slice(start, start + model.maxBatchSize);

      const outcome = await withRetry(
        () => provider.embed({ texts: batch, model, signal: input.signal }),
        {
          operation: `embedding.${model.provider}.${model.id}`,
          policy: this.options.retry ?? RETRY_PRESETS.background,
          signal: input.signal,
        },
      );

      const { vectors, tokens } = outcome.value;

      if (vectors.length !== batch.length) {
        /*
         * A provider returning a different number of vectors than texts is a data-corruption bug,
         * not a transient failure. Continuing would associate each vector with the wrong text —
         * and the search results would be wrong in a way nothing detects.
         */
        throw ApiError.internal(
          `The "${model.provider}" provider returned ${vectors.length} vectors for ${batch.length} ` +
            'texts. Continuing would pair each vector with the wrong text, and the resulting ' +
            'search results would be wrong with no symptom.',
        );
      }

      for (const vector of vectors) {
        if (vector.length !== model.dimensions) {
          // Caught here rather than at the vector store, so the error names the model and the
          // configuration rather than surfacing as a write rejection mid-ingestion.
          throw ApiError.internal(
            `The model "${model.id}" is configured with ${model.dimensions} dimensions and the ` +
              `provider returned a ${vector.length}-dimension vector. One of the two is wrong, ` +
              'and mixing them in an index makes every similarity score meaningless.',
          );
        }

        embeddings.push({
          vector,
          modelId: model.id,
          dimensions: model.dimensions,
          version: model.version,
          tokens: Math.ceil(tokens / batch.length),
        });
      }

      totalTokens += tokens;
    }

    return {
      embeddings,
      totalTokens,
      costCents: (totalTokens / 1_000_000) * model.centsPerMillionTokens,
    };
  }

  /** Embeds one text. The common case, and it should not require array wrapping. */
  async embedOne(text: string, modelId: string, signal?: AbortSignal): Promise<Embedding> {
    const result = await this.embed({ texts: [text], modelId, signal });
    return result.embeddings[0]!;
  }

  models_(): EmbeddingModel[] {
    return [...this.models.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async health(): Promise<Array<{ provider: string; status: string; detail: string }>> {
    return Promise.all(
      [...this.providers.values()].map(async (provider) => {
        if (!provider.health) {
          return { provider: provider.key, status: 'unknown', detail: 'No health check.' };
        }

        try {
          const health = await provider.health();
          return { provider: provider.key, ...health };
        } catch (error) {
          return {
            provider: provider.key,
            status: 'unavailable',
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }
}

/**
 * Whether two embeddings can be compared.
 *
 * Model, dimensions **and** version. The version check catches the case that is otherwise
 * invisible: a provider silently updating a model in place, after which old and new vectors
 * coexist in one index and similarity scores between them mean nothing.
 */
export function areComparable(
  a: Pick<Embedding, 'modelId' | 'dimensions' | 'version'>,
  b: typeof a,
): boolean {
  return a.modelId === b.modelId && a.dimensions === b.dimensions && a.version === b.version;
}

/** Says why two embeddings are not comparable, for an error a person can act on. */
export function explainIncomparable(
  a: Pick<Embedding, 'modelId' | 'dimensions' | 'version'>,
  b: typeof a,
): string | null {
  if (a.modelId !== b.modelId) {
    return (
      `These vectors came from different models ("${a.modelId}" and "${b.modelId}"). Similarity ` +
      'between them is not a weaker signal — it is meaningless. Re-embed the collection with one ' +
      'model.'
    );
  }
  if (a.dimensions !== b.dimensions) {
    return `These vectors have different lengths (${a.dimensions} and ${b.dimensions}).`;
  }
  if (a.version !== b.version) {
    return (
      `These vectors came from different versions of "${a.modelId}" ("${a.version}" and ` +
      `"${b.version}"). The provider changed the model; re-embed the collection.`
    );
  }
  return null;
}

/**
 * Cosine similarity. −1 to 1, higher is more similar.
 *
 * Written here rather than taken from a library because it is eight lines and every vector store
 * adapter needs it for its in-memory fallback.
 */
/**
 * Refuses vectors of different lengths.
 *
 * Applied to every metric, not just cosine. Without it, `euclideanDistance` and `dotProduct` read
 * past the end of the shorter vector, arithmetic on `undefined` yields `NaN`, and the `NaN`
 * propagates into a ranking where it sorts unpredictably — a search that returns a confident,
 * wrong order and never errors.
 */
function assertSameDimensions(a: number[], b: number[]): void {
  if (a.length === b.length) return;

  throw ApiError.internal(
    `Cannot compare a ${a.length}-dimension vector with a ${b.length}-dimension one.`,
  );
}

export function cosineSimilarity(a: number[], b: number[]): number {
  assertSameDimensions(a, b);

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    dot += a[index]! * b[index]!;
    normA += a[index]! * a[index]!;
    normB += b[index]! * b[index]!;
  }

  // A zero vector has no direction, so similarity to it is undefined. Zero rather than NaN,
  // because NaN propagates silently through a ranking and produces an arbitrary order.
  if (normA === 0 || normB === 0) return 0;

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function euclideanDistance(a: number[], b: number[]): number {
  assertSameDimensions(a, b);

  let sum = 0;
  for (let index = 0; index < a.length; index += 1) {
    const delta = a[index]! - b[index]!;
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

export function dotProduct(a: number[], b: number[]): number {
  assertSameDimensions(a, b);

  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += a[index]! * b[index]!;
  return sum;
}

/**
 * Scores two vectors under a metric, normalised so higher is always better.
 *
 * Euclidean is a *distance* — lower is closer — and mixing it with similarity scores in one
 * ranking without normalising is a bug that inverts the results while still producing a
 * plausible-looking list.
 */
export function score(a: number[], b: number[], metric: DistanceMetric): number {
  switch (metric) {
    case 'cosine':
      return cosineSimilarity(a, b);
    case 'dot_product':
      return dotProduct(a, b);
    case 'euclidean':
      // Inverted, so higher is better everywhere.
      return 1 / (1 + euclideanDistance(a, b));
  }
}
