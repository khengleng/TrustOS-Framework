import { Body, Controller, Delete, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '@trustos/rbac';
import { OrganizationId } from '@trustos/tenancy';
import { z } from '@trustos/validation';
import { ZodValidationPipe } from '@trustos/validation/nest';
import type { Paginated } from '@trustos/shared-types';
import { FILE_STORAGE_SERVICE } from './tokens';
import type { FileStorageService } from '../file-storage.service';
import type { StoredObjectRow, StoredObjectVersionRow } from '../store';

/**
 * Object storage endpoints.
 *
 * Every route declares a permission from the module's own catalog entry, so the
 * framework's deny-by-default `PermissionsGuard` has something to check. The
 * organization comes from `@OrganizationId()`, which reads the value the tenant
 * guard derived from the access token — never from the request body.
 *
 * Content crosses the wire as base64 inside JSON rather than as multipart.
 * Multipart would mean a body-parser dependency and per-framework wiring in a
 * package that is meant to be transport-agnostic; the cost is a 33% size
 * overhead, which is why the size ceiling is applied to the decoded bytes.
 * Streaming is out of scope — see the README.
 */

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/,
    'A name may contain letters, digits, dot, underscore, hyphen and forward slash.',
  );

const storeSchema = z.object({
  name: nameSchema,
  /** Base64. Validated as base64 here; the size limit applies after decoding. */
  content: z
    .string()
    .min(1)
    .max(64 * 1024 * 1024),
  contentType: z.string().trim().min(1).max(160).default('application/octet-stream'),
});

const listSchema = z.object({
  namePrefix: nameSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

@ApiTags('file-storage')
@ApiBearerAuth('access-token')
@Controller('files')
export class FileStorageController {
  constructor(@Inject(FILE_STORAGE_SERVICE) private readonly files: FileStorageService) {}

  @Get()
  @RequirePermissions('file-storage.file.list')
  @ApiOperation({ summary: 'List stored objects.' })
  list(
    @OrganizationId() organizationId: string,
    @Query(new ZodValidationPipe(listSchema)) query: z.infer<typeof listSchema>,
  ): Promise<Paginated<StoredObjectRow>> {
    return this.files.list(organizationId, query);
  }

  @Post()
  @RequirePermissions('file-storage.file.write')
  @ApiOperation({ summary: 'Store an object.' })
  async store(
    @OrganizationId() organizationId: string,
    @Body(new ZodValidationPipe(storeSchema)) body: z.infer<typeof storeSchema>,
  ): Promise<StoredObjectRow> {
    return this.files.store(
      {
        name: body.name,
        content: decodeBase64(body.content),
        contentType: body.contentType,
      },
      organizationId,
    );
  }

  @Get(':id')
  @RequirePermissions('file-storage.file.read')
  @ApiOperation({ summary: 'Read object metadata.' })
  metadata(
    @Param('id') id: string,
    @OrganizationId() organizationId: string,
  ): Promise<StoredObjectRow> {
    return this.files.metadata(id, organizationId);
  }

  @Get(':id/content')
  @RequirePermissions('file-storage.file.read')
  @ApiOperation({ summary: 'Download object content, base64 encoded.' })
  async content(
    @Param('id') id: string,
    @OrganizationId() organizationId: string,
  ): Promise<{ contentType: string; checksum: string; byteSize: number; content: string }> {
    const { object, blob } = await this.files.read(id, organizationId);

    return {
      contentType: object.contentType,
      // The checksum travels with the content so a client can verify what it
      // received rather than trusting the transport.
      checksum: object.checksum,
      byteSize: object.byteSize,
      content: blob.content.toString('base64'),
    };
  }

  @Get(':id/versions')
  @RequirePermissions('file-storage.file.read')
  @ApiOperation({ summary: 'List an object version history.' })
  versions(
    @Param('id') id: string,
    @OrganizationId() organizationId: string,
  ): Promise<StoredObjectVersionRow[]> {
    return this.files.versions(id, organizationId);
  }

  @Delete(':id')
  @RequirePermissions('file-storage.file.delete')
  @ApiOperation({ summary: 'Retire an object.' })
  remove(
    @Param('id') id: string,
    @OrganizationId() organizationId: string,
  ): Promise<StoredObjectRow> {
    return this.files.remove(id, organizationId);
  }
}

/**
 * Decodes base64 strictly.
 *
 * `Buffer.from(value, 'base64')` silently ignores anything it cannot decode, so
 * a corrupted upload would be stored as a shorter object with a valid checksum
 * of the wrong bytes. Re-encoding and comparing is the only way to tell.
 */
function decodeBase64(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');

  if (decoded.toString('base64') !== value.replace(/\s/g, '')) {
    throw z.ZodError.create([
      { code: 'custom', path: ['content'], message: 'Content is not valid base64.' },
    ]);
  }
  return decoded;
}
