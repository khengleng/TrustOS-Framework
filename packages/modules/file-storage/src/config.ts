import { z } from 'zod';

/**
 * File storage configuration.
 *
 * Every field has a default, because `defineModule` requires the module to
 * install and start with no configuration at all. The defaults are chosen to be
 * safe rather than convenient: a relative storage root inside the working
 * directory, a modest size ceiling, and versioning on.
 */
export const fileStorageConfigSchema = z
  .object({
    /**
     * Where the local provider writes. Relative to the process working
     * directory, so the default cannot escape a deployment's own filesystem.
     */
    root: z
      .string()
      .min(1)
      .max(400)
      .default('.trustos-storage')
      .refine((value) => !value.includes('\0'), { message: 'Must not contain a null byte.' }),

    /**
     * Largest object accepted.
     *
     * A ceiling rather than "unlimited": an upload endpoint with no size limit is
     * a disk-exhaustion primitive available to anyone who can authenticate.
     */
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024 * 1024)
      .default(25 * 1024 * 1024),

    /** Keep previous versions when an object is replaced. */
    versioning: z.boolean().default(true),

    /** Versions retained per object, oldest pruned first. */
    maxVersionsPerObject: z.number().int().min(1).max(1000).default(20),

    /**
     * Content types accepted. Empty means "any".
     *
     * An allow-list belongs to the application, not to the module: what is safe
     * to store depends on what the application does with it afterwards.
     */
    allowedContentTypes: z.array(z.string().min(1).max(160)).default([]),
  })
  .strict();

export type FileStorageConfig = z.infer<typeof fileStorageConfigSchema>;
