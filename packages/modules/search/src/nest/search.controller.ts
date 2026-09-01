import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@trustsystem/auth';
import { RequirePermissions } from '@trustsystem/rbac';
import { OrganizationId } from '@trustsystem/tenancy';
import type { ActorContext, Paginated } from '@trustsystem/shared-types';
import { z } from '@trustsystem/validation';
import { ZodValidationPipe } from '@trustsystem/validation/nest';
import type { SearchHit } from '../adapter';
import type { SearchService, SearchSourceSummary } from '../search.service';
import { SEARCH_SERVICE } from './tokens';

/**
 * Search endpoints.
 *
 * The caller's permission set decides which sources are searched at all, so the
 * same request returns different sources for a support agent and for an auditor —
 * which is the point.
 */

const searchSchema = z.object({
  q: z.string().trim().min(2).max(120),
  // Comma-separated so the query string stays readable; unknown ids are rejected
  // by the service rather than ignored.
  sources: z
    .string()
    .max(400)
    .optional()
    .transform((value) =>
      value
        ? value
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
        : undefined,
    ),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

@ApiTags('search')
@ApiBearerAuth('access-token')
@Controller('search')
export class SearchController {
  constructor(@Inject(SEARCH_SERVICE) private readonly search: SearchService) {}

  @Get()
  @RequirePermissions('search.query.execute')
  @ApiOperation({ summary: 'Search across every source the caller may read.' })
  query(
    @OrganizationId() organizationId: string,
    @CurrentUser() actor: ActorContext,
    @Query(new ZodValidationPipe(searchSchema)) query: z.infer<typeof searchSchema>,
  ): Promise<Paginated<SearchHit>> {
    return this.search.search(
      {
        term: query.q,
        ...(query.sources ? { sources: query.sources } : {}),
        page: query.page,
        pageSize: query.pageSize,
      },
      organizationId,
      actor.permissions,
    );
  }

  @Get('sources')
  @RequirePermissions('search.source.read')
  @ApiOperation({ summary: 'List searchable sources.' })
  sources(@CurrentUser() actor: ActorContext): SearchSourceSummary[] {
    return this.search.sources(actor.permissions);
  }
}
