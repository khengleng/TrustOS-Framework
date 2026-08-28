import { z } from 'zod';

/**
 * Chunking.
 *
 * Splitting a document into pieces small enough to embed and large enough to mean something. The
 * single decision that determines whether retrieval works at all, and the one most often made by
 * accident.
 *
 * **Why naive splitting fails.** Cutting every N characters puts the answer to a question across
 * a boundary about as often as not. The retrieved chunk then contains the first half of a
 * sentence that answers the question, the model has no idea it is missing the rest, and the answer
 * is confidently wrong. Splitting on structure — paragraphs, then sentences — and overlapping the
 * pieces is what avoids that.
 *
 * **Why overlap.** A fact that spans a boundary appears in full in at least one chunk. The cost is
 * duplicated tokens in the index; the benefit is that the retrievable unit is a complete thought.
 * The default is 15%, which is enough for a sentence or two of context.
 *
 * The separators are tried in order, largest structure first, so a chunk is a whole section before
 * it is a whole paragraph before it is a whole sentence. Character splitting is the last resort
 * and applies only to a single unbroken run — a minified file, a base64 blob — where there is no
 * structure to respect.
 */

export const chunkingStrategySchema = z
  .object({
    /**
     * Target size in characters, not tokens.
     *
     * Characters because chunking happens before tokenisation and a token count would need a
     * tokeniser per model — which would make the same document chunk differently depending on
     * which model was going to embed it, and therefore make an index un-reusable.
     */
    targetChars: z.number().int().min(100).max(20_000).default(1200),

    /**
     * Overlap as a fraction of the target.
     *
     * 0.15. Enough for a sentence or two of context to appear in both neighbours, which is what
     * makes a fact spanning a boundary retrievable.
     */
    overlapFraction: z.number().min(0).max(0.5).default(0.15),

    /**
     * A chunk shorter than this is merged into its neighbour.
     *
     * A 40-character chunk is a heading with no body. It matches queries about its own words and
     * then contributes nothing to the answer, which is worse than not being retrievable.
     */
    minChars: z.number().int().min(1).max(2000).default(120),

    /** Tried in order, largest structure first. */
    separators: z.array(z.string()).default(['\n## ', '\n### ', '\n\n', '\n', '. ', ' ']),

    /** Keeps the heading a chunk falls under, prepended. See `preserveHeadings`. */
    preserveHeadings: z.boolean().default(true),
  })
  .strict();

export type ChunkingStrategy = z.infer<typeof chunkingStrategySchema>;

export interface Chunk {
  /** Position in the document. What a citation points at. */
  index: number;
  content: string;
  /** Character offsets in the original, so a citation can be located exactly. */
  startOffset: number;
  endOffset: number;
  /** The heading this chunk sits under, when there is one. */
  heading: string | null;
  charCount: number;
}

/**
 * Splits text into chunks.
 *
 * Recursive: try to split on the largest separator that produces pieces under the target, and
 * fall back to the next. Character splitting only happens for a run with no separator in it at
 * all.
 */
export function chunkText(
  text: string,
  strategy: ChunkingStrategy = chunkingStrategySchema.parse({}),
): Chunk[] {
  if (text.trim().length === 0) return [];

  const pieces = split(text, strategy.separators, strategy.targetChars);
  const merged = mergePieces(pieces, strategy);

  const overlapChars = Math.floor(strategy.targetChars * strategy.overlapFraction);
  const chunks: Chunk[] = [];
  let offset = 0;
  let currentHeading: string | null = null;

  for (const [index, piece] of merged.entries()) {
    const startOffset = text.indexOf(piece, Math.max(0, offset - piece.length));
    const resolvedStart = startOffset === -1 ? offset : startOffset;

    // The heading a chunk sits under, carried forward. Without it a retrieved chunk reads as
    // context-free prose — "the limit is 5%" with no indication of what the limit applies to.
    const headingMatch = /(?:^|\n)#{1,6}\s+(.+)/.exec(piece);
    if (headingMatch?.[1]) currentHeading = headingMatch[1].trim();

    const previous = merged[index - 1];
    const overlap = overlapChars > 0 && previous ? previous.slice(-overlapChars) : '';

    const content =
      strategy.preserveHeadings && currentHeading && !piece.includes(currentHeading)
        ? `${currentHeading}\n\n${overlap}${piece}`
        : `${overlap}${piece}`;

    chunks.push({
      index,
      content: content.trim(),
      startOffset: resolvedStart,
      endOffset: resolvedStart + piece.length,
      heading: currentHeading,
      charCount: content.trim().length,
    });

    offset = resolvedStart + piece.length;
  }

  return chunks;
}

/** Recursively splits on the first separator that produces pieces under the target. */
function split(text: string, separators: string[], targetChars: number): string[] {
  if (text.length <= targetChars) return [text];

  const [separator, ...rest] = separators;

  if (separator === undefined) {
    /*
     * No separator left.
     *
     * Only reached by a single unbroken run — a minified file, a base64 blob — where there is no
     * structure to respect. Splitting mid-word here is correct: the alternative is one enormous
     * chunk that no model can read.
     */
    const pieces: string[] = [];
    for (let start = 0; start < text.length; start += targetChars) {
      pieces.push(text.slice(start, start + targetChars));
    }
    return pieces;
  }

  const parts = text.split(separator);

  // The separator is not in this text at all: try the next one rather than returning the whole
  // thing, which would leave an oversized chunk.
  if (parts.length === 1) return split(text, rest, targetChars);

  const pieces: string[] = [];
  let current = '';

  for (const [index, part] of parts.entries()) {
    // Re-attached, so the chunk reads the way the source did rather than losing its punctuation.
    const withSeparator = index === parts.length - 1 ? part : part + separator;

    if (current.length + withSeparator.length > targetChars && current.length > 0) {
      pieces.push(current);
      current = withSeparator;
    } else {
      current += withSeparator;
    }
  }

  if (current.length > 0) pieces.push(current);

  // A piece still over target — a very long paragraph — is split again with the remaining
  // separators.
  return pieces.flatMap((piece) =>
    piece.length > targetChars ? split(piece, rest, targetChars) : [piece],
  );
}

/**
 * Merges pieces below the minimum into their neighbour.
 *
 * A 40-character chunk is a heading with no body: it matches queries about its own words and then
 * contributes nothing to the answer, which is worse than not being retrievable at all.
 */
function mergePieces(pieces: string[], strategy: ChunkingStrategy): string[] {
  const merged: string[] = [];

  for (const piece of pieces) {
    const trimmed = piece.trim();
    if (trimmed.length === 0) continue;

    const previous = merged[merged.length - 1];

    if (
      previous !== undefined &&
      trimmed.length < strategy.minChars &&
      previous.length + trimmed.length <= strategy.targetChars * 1.5
    ) {
      merged[merged.length - 1] = `${previous}\n${trimmed}`;
      continue;
    }

    merged.push(trimmed);
  }

  // A leading fragment has no previous neighbour, so it merges forwards instead.
  if (merged.length > 1 && merged[0]!.length < strategy.minChars) {
    merged[1] = `${merged[0]}\n${merged[1]}`;
    merged.shift();
  }

  return merged;
}

/**
 * Reports problems with a chunking result.
 *
 * Run after ingesting a document. The two signals that predict poor retrieval, both invisible
 * without looking: chunks that are almost all tiny, and one chunk that swallowed the document.
 */
export function assessChunking(chunks: Chunk[], strategy: ChunkingStrategy): string[] {
  if (chunks.length === 0) return ['The document produced no chunks. It may be empty or unparsed.'];

  const problems: string[] = [];
  const sizes = chunks.map((chunk) => chunk.charCount);
  const average = sizes.reduce((sum, size) => sum + size, 0) / sizes.length;

  const tiny = sizes.filter((size) => size < strategy.minChars).length;
  if (tiny > chunks.length / 2) {
    problems.push(
      `${tiny} of ${chunks.length} chunks are below the ${strategy.minChars}-character minimum. ` +
        'The document is probably a list or a table, which chunks badly — consider a smaller ' +
        'target size, or a loader that flattens the structure first.',
    );
  }

  const oversized = sizes.filter((size) => size > strategy.targetChars * 2).length;
  if (oversized > 0) {
    problems.push(
      `${oversized} chunk(s) are more than twice the target size. The document has long runs with ` +
        'none of the configured separators — check whether it needs a different separator list.',
    );
  }

  if (chunks.length === 1 && average > strategy.targetChars) {
    problems.push(
      'The whole document became one oversized chunk. Retrieval will return all or nothing of it.',
    );
  }

  return problems;
}
