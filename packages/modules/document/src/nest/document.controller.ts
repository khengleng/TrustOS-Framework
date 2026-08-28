import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '@trustos/rbac';
import { OrganizationId } from '@trustos/tenancy';
import { z } from '@trustos/validation';
import { ZodValidationPipe } from '@trustos/validation/nest';
import type { Paginated } from '@trustos/shared-types';
import type { DocumentService } from '../document.service';
import type { DocumentCategoryRow, DocumentRow, DocumentVersionRow } from '../store';
import { DOCUMENT_SERVICE } from './tokens';

/**
 * Document endpoints.
 *
 * Route order matters here: `/documents/categories` is declared before
 * `/documents/:id`, because Nest matches in declaration order and `categories`
 * would otherwise be captured as an id.
 *
 * Content crosses the wire base64 encoded, for the reason given in the
 * file-storage controller.
 */

const keySchema = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/, 'Lowercase, hyphen or underscore separated.');

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Letters, digits, dot, underscore and hyphen only.');

const uploadSchema = z.object({
  title: z.string().trim().min(1).max(200),
  name: nameSchema,
  content: z
    .string()
    .min(1)
    .max(64 * 1024 * 1024),
  contentType: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional(),
  categoryKey: keySchema.optional(),
});

const versionSchema = z.object({
  content: z
    .string()
    .min(1)
    .max(64 * 1024 * 1024),
  contentType: z.string().trim().min(1).max(160),
  name: nameSchema.optional(),
});

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    categoryKey: keySchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' });

const listSchema = z.object({
  categoryKey: keySchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const categorySchema = z.object({
  key: keySchema,
  name: z.string().trim().min(1).max(120),
});

@ApiTags('documents')
@ApiBearerAuth('access-token')
@Controller('documents')
export class DocumentController {
  constructor(@Inject(DOCUMENT_SERVICE) private readonly documents: DocumentService) {}

  @Get()
  @RequirePermissions('document.document.read')
  @ApiOperation({ summary: 'List documents.' })
  list(
    @OrganizationId() organizationId: string,
    @Query(new ZodValidationPipe(listSchema)) query: z.infer<typeof listSchema>,
  ): Promise<Paginated<DocumentRow>> {
    return this.documents.list(organizationId, query);
  }

  @Get('categories')
  @RequirePermissions('document.category.read')
  @ApiOperation({ summary: 'List document categories.' })
  listCategories(): Promise<DocumentCategoryRow[]> {
    return this.documents.listCategories();
  }

  @Post('categories')
  @RequirePermissions('document.category.manage')
  @ApiOperation({ summary: 'Create a document category.' })
  createCategory(
    @OrganizationId() organizationId: string,
    @Body(new ZodValidationPipe(categorySchema)) body: z.infer<typeof categorySchema>,
  ): Promise<DocumentCategoryRow> {
    return this.documents.createCategory(body, organizationId);
  }

  @Post()
  @RequirePermissions('document.document.upload')
  @ApiOperation({ summary: 'Upload a document.' })
  upload(
    @OrganizationId() organizationId: string,
    @Body(new ZodValidationPipe(uploadSchema)) body: z.infer<typeof uploadSchema>,
  ): Promise<DocumentRow> {
    return this.documents.upload({ ...body, content: decodeBase64(body.content) }, organizationId);
  }

  @Get(':id')
  @RequirePermissions('document.document.read')
  @ApiOperation({ summary: 'Read one document.' })
  find(@Param('id') id: string, @OrganizationId() organizationId: string): Promise<DocumentRow> {
    return this.documents.find(id, organizationId);
  }

  @Get(':id/content')
  @RequirePermissions('document.document.read')
  @ApiOperation({ summary: 'Download document content, base64 encoded.' })
  async content(
    @Param('id') id: string,
    @OrganizationId() organizationId: string,
  ): Promise<{ contentType: string; checksum: string; version: number; content: string }> {
    const { document, content } = await this.documents.download(id, organizationId);

    return {
      contentType: document.contentType,
      checksum: document.checksum,
      version: document.version,
      content: content.toString('base64'),
    };
  }

  @Post(':id/versions')
  @RequirePermissions('document.document.upload')
  @ApiOperation({ summary: 'Upload a new version of a document.' })
  addVersion(
    @Param('id') id: string,
    @OrganizationId() organizationId: string,
    @Body(new ZodValidationPipe(versionSchema)) body: z.infer<typeof versionSchema>,
  ): Promise<DocumentRow> {
    return this.documents.addVersion(
      id,
      { ...body, content: decodeBase64(body.content) },
      organizationId,
    );
  }

  @Get(':id/versions')
  @RequirePermissions('document.version.read')
  @ApiOperation({ summary: 'List a document version history.' })
  versions(
    @Param('id') id: string,
    @OrganizationId() organizationId: string,
  ): Promise<DocumentVersionRow[]> {
    return this.documents.versions(id, organizationId);
  }

  @Put(':id')
  @RequirePermissions('document.document.update')
  @ApiOperation({ summary: 'Update document metadata.' })
  update(
    @Param('id') id: string,
    @OrganizationId() organizationId: string,
    @Body(new ZodValidationPipe(updateSchema)) body: z.infer<typeof updateSchema>,
  ): Promise<DocumentRow> {
    return this.documents.update(id, body, organizationId);
  }

  @Delete(':id')
  @RequirePermissions('document.document.delete')
  @ApiOperation({ summary: 'Retire a document.' })
  remove(@Param('id') id: string, @OrganizationId() organizationId: string): Promise<DocumentRow> {
    return this.documents.remove(id, organizationId);
  }
}

/**
 * Decodes base64 strictly.
 *
 * `Buffer.from(value, 'base64')` ignores what it cannot decode, so a corrupted
 * upload would be stored as shorter content with a valid checksum of the wrong
 * bytes.
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
