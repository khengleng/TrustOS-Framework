import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustos/authorization/nest';
import { CurrentUser } from '@trustos/auth';
import { RequirePermissions } from '@trustos/rbac';
import type { ActorContext } from '@trustos/shared-types';
import { OrganizationId } from '@trustos/tenancy';
import { FINANCIAL_PRODUCT_PERMISSIONS } from '@trustos/financial-product-core';
import {
  catalogEntry,
  catalogSummary,
  searchCatalog,
  type ProductRegistry,
} from '@trustos/financial-product-registry';
import { productOpenApi, productRoutes } from '@trustos/financial-product-api';
import { PRODUCT_REGISTRY } from '../tokens';

/**
 * The catalog.
 *
 * The screen a product owner opens first, and the one an auditor asks for. Everything here is a
 * read, and every read is tenant-scoped through the registry — the organization comes from
 * `OrganizationId`, which `TenantGuard` resolved from the verified actor, and never from a query
 * parameter.
 *
 * The catalog entries are **derived** from the live definition on every request rather than
 * stored. See the header of `catalog.ts` in `@trustos/financial-product-registry`: a catalog with
 * its own copy of a product's owner and status disagrees with the product within a month, and the
 * disagreement is discovered by whoever trusted the catalog.
 */
@ApiTags('Financial product catalog')
@ApiBearerAuth()
@Controller('financial-products')
export class CatalogController {
  constructor(@Inject(PRODUCT_REGISTRY) private readonly registry: ProductRegistry) {}

  @Get()
  @ApiOperation({ summary: 'Search the product catalog' })
  @ApiOkResponse({ description: 'Catalog entries for this organization.' })
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_READ.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_READ.key)
  async search(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Query('text') text?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
  ) {
    const records = await this.registry.list({
      actorId: actor.userId,
      organizationId,
      permissions: actor.permissions ?? [],
    });

    return {
      summary: catalogSummary(records),
      entries: searchCatalog(records, {
        ...(text ? { text } : {}),
        ...(type ? { productType: type as never } : {}),
        ...(status ? { status } : {}),
      }),
    };
  }

  @Get(':productId')
  @ApiOperation({ summary: 'One catalog entry, with its versions' })
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_READ.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_READ.key)
  async get(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('productId') productId: string,
  ) {
    const record = await this.registry.get(
      { actorId: actor.userId, organizationId, permissions: actor.permissions ?? [] },
      productId,
    );

    return {
      entry: catalogEntry(record),
      versions: record.versions.map((version) => ({
        version: version.version,
        lifecycleStatus: version.definition.lifecycleStatus,
        publishedAt: version.publishedAt,
        changeSummary: version.changeSummary,
        changedPaths: version.changedPaths,
        /*
         * The approval trail, with actor ids rather than names.
         *
         * A version history that carried names would be a version history that leaks the
         * organization chart to anybody with `product.read` — and the directory resolves the
         * ids for whoever is entitled to see them.
         */
        approvedBy: version.approvedBy,
        contentHash: version.contentHash,
      })),
      draft: record.draft
        ? { version: record.draft.version, lifecycleStatus: record.draft.lifecycleStatus }
        : null,
    };
  }

  @Get(':productId/api')
  @ApiOperation({ summary: 'The OpenAPI document for this product, generated from its definition' })
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_READ.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_READ.key)
  async openapi(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('productId') productId: string,
  ) {
    const version = await this.registry.activeVersion(
      { actorId: actor.userId, organizationId, permissions: actor.permissions ?? [] },
      productId,
    );

    return {
      routes: productRoutes(version.definition),
      document: productOpenApi(version.definition),
    };
  }
}
