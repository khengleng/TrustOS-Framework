import { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { parseOrThrow } from '../parse';

/**
 * Validates and *replaces* a handler argument with the schema's parsed output.
 *
 * Using the parsed value matters: Zod strips unknown keys, so a caller cannot
 * smuggle `organizationId` or `isSuperAdmin` into a DTO the handler later
 * spreads into a database write (mass assignment).
 *
 *   @Post()
 *   create(@Body(new ZodValidationPipe(createOrgSchema)) body: CreateOrgInput) {}
 */
export class ZodValidationPipe<TSchema extends z.ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown, _metadata: ArgumentMetadata): z.infer<TSchema> {
    return parseOrThrow(this.schema, value);
  }
}

/** Convenience factory: `@Body(zodPipe(schema))`. */
export function zodPipe<TSchema extends z.ZodTypeAny>(schema: TSchema): ZodValidationPipe<TSchema> {
  return new ZodValidationPipe(schema);
}
