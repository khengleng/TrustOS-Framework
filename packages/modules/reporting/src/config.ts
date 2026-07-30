import { z } from 'zod';

/**
 * Reporting configuration.
 *
 * `maxExportRows` is the field that matters. Materialising an unbounded report
 * into one file is a memory-exhaustion primitive available to anyone who can run
 * a report, so there is a ceiling and the module refuses rather than truncates.
 */
export const reportingConfigSchema = z
  .object({
    maxExportRows: z.number().int().min(1).max(1_000_000).default(50_000),
    maxPageSize: z.number().int().min(1).max(500).default(100),
    /** Offer PDF export. Off until a renderer is wired in. */
    pdfEnabled: z.boolean().default(false),
  })
  .strict();

export type ReportingConfig = z.infer<typeof reportingConfigSchema>;
