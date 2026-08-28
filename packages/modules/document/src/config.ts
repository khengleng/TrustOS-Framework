import { z } from 'zod';

/**
 * Document configuration.
 *
 * `allowedContentTypes` is non-empty by default, which is the opposite of the
 * file-storage module's choice and deliberate: file storage holds whatever an
 * application puts in it, while a document is something a person uploads and a
 * person later opens. An HTML document served back from a customer-facing
 * endpoint is stored cross-site scripting, so the default list contains only
 * formats that are inert when opened.
 */
export const documentConfigSchema = z
  .object({
    /** Where document content is written. Keys are organization-namespaced. */
    storageRoot: z.string().min(1).max(400).default('.trustos-storage'),

    maxUploadBytes: z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024 * 1024)
      .default(20 * 1024 * 1024),

    allowedContentTypes: z
      .array(z.string().min(1).max(160))
      .default([
        'application/pdf',
        'image/png',
        'image/jpeg',
        'text/plain',
        'text/csv',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ]),

    /** Keep previous versions when a document is replaced. */
    versioning: z.boolean().default(true),

    /** Categories a document may be filed under, beyond those created at runtime. */
    requireCategory: z.boolean().default(false),
  })
  .strict();

export type DocumentConfig = z.infer<typeof documentConfigSchema>;
