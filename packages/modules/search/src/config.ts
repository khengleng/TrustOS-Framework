import { z } from 'zod';

/**
 * Search configuration.
 *
 * `maxResultsPerSource` bounds the fan-out: a global search runs every adapter,
 * so an unbounded limit turns one request into a full-table scan per module.
 */
export const searchConfigSchema = z
  .object({
    maxResultsPerSource: z.number().int().min(1).max(200).default(25),
    maxPageSize: z.number().int().min(1).max(200).default(50),
    /** Rank by field weight and match position rather than by source order. */
    weightedRanking: z.boolean().default(true),
    /**
     * Record the search term in the audit trail.
     *
     * On by default. Searching for a person's name is exactly the action an
     * insider-threat review asks about, and a trail that records only "a search
     * happened" cannot answer it. Turn it off where the term itself would be
     * sensitive enough that holding it is the greater risk.
     */
    auditSearchTerms: z.boolean().default(true),
  })
  .strict();

export type SearchConfig = z.infer<typeof searchConfigSchema>;
