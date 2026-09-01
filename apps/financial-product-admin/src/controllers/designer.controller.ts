import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustsystem/authorization/nest';
import { CurrentUser } from '@trustsystem/auth';
import { RequirePermissions } from '@trustsystem/rbac';
import type { ActorContext } from '@trustsystem/shared-types';
import { OrganizationId } from '@trustsystem/tenancy';
import {
  FINANCIAL_PRODUCT_PERMISSIONS,
  parseProductDefinition,
  type ReferenceDataRegistry,
} from '@trustsystem/financial-product-core';
import {
  DESIGNER_NAVIGATION,
  PRODUCT_TEMPLATES,
  compareDesigns,
  designerCanvas,
  designerPalette,
  findTemplate,
  validateProduct,
} from '@trustsystem/financial-product-composer';
import {
  APPROVED_BLOCKS,
  blockCatalogSummary,
  type BlockRegistry,
} from '@trustsystem/financial-block-registry';
import {
  PROVIDER_INTERFACES,
  PROVIDER_INTERFACE_NAMES,
  type ConnectorRegistry,
} from '@trustsystem/connector-registry';
import type { ProductRegistry } from '@trustsystem/financial-product-registry';
import { BLOCK_REGISTRY, CONNECTOR_REGISTRY, PRODUCT_REGISTRY, REFERENCE_DATA } from '../tokens';

/**
 * The visual designer's data.
 *
 * Everything the canvas draws comes from here, and none of it is drawn here. The palette, the
 * canvas, the inspector and the validation findings are descriptors; a React surface renders
 * them, a CLI prints them, and a comparison view diffs them — three renderers over one
 * description. See the header of `designer.ts` in `@trustsystem/financial-product-composer`.
 *
 * The endpoint worth noticing is `validate`: the designer calls it on every change, and the
 * findings come back **attached to the block they concern** rather than as a list at the bottom
 * of the screen. A validation error in a list is an error somebody scrolls past; one on the block
 * is one they fix. That is the difference between a designer a business analyst uses and one they
 * ask a developer to operate.
 */
@ApiTags('Product designer')
@ApiBearerAuth()
@Controller('product-designer')
export class DesignerController {
  constructor(
    @Inject(PRODUCT_REGISTRY) private readonly registry: ProductRegistry,
    @Inject(BLOCK_REGISTRY) private readonly blocks: BlockRegistry,
    @Inject(CONNECTOR_REGISTRY) private readonly connectors: ConnectorRegistry,
    @Inject(REFERENCE_DATA) private readonly referenceData: ReferenceDataRegistry,
  ) {}

  @Get('navigation')
  @ApiOperation({ summary: 'The designer’s eleven sections' })
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_READ.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_READ.key)
  navigation() {
    return { sections: DESIGNER_NAVIGATION };
  }

  @Get('palette')
  @ApiOperation({ summary: 'What may be dragged onto the canvas' })
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.BLOCK_READ.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.BLOCK_READ.key)
  palette() {
    return {
      groups: designerPalette(this.blocks),
      summary: blockCatalogSummary(this.blocks),
    };
  }

  @Get('templates')
  @ApiOperation({ summary: 'Starting points that already validate' })
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_READ.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_READ.key)
  templates(@Query('id') id?: string) {
    if (id) {
      const template = findTemplate(id);
      if (!template) return { templates: [], definition: null };
      return { templates: [], definition: template.build() };
    }

    return {
      templates: PRODUCT_TEMPLATES.map((template) => ({
        id: template.id,
        name: template.name,
        description: template.description,
      })),
      definition: null,
    };
  }

  @Get('connectors')
  @ApiOperation({ summary: 'Provider interfaces, and the connectors this tenant has approved' })
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.CONNECTOR_READ.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.CONNECTOR_READ.key)
  connectorCatalog(@OrganizationId() organizationId: string) {
    return {
      interfaces: PROVIDER_INTERFACE_NAMES.map((name) => ({
        providerInterface: name,
        ...PROVIDER_INTERFACES[name],
      })),
      approved: this.connectors.all(organizationId),
      covered: this.connectors.coveredInterfaces(organizationId),
    };
  }

  @Get('reference-data')
  @ApiOperation({ summary: 'The centrally governed codes a product may reference' })
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.REFERENCE_READ.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.REFERENCE_READ.key)
  reference() {
    return {
      domains: this.referenceData.domains().map((domain) => ({
        domain,
        entries: this.referenceData.list(domain),
      })),
    };
  }

  @Post('validate')
  @ApiOperation({ summary: 'Validate a definition and attach findings to the block they concern' })
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_VALIDATE.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_VALIDATE.key)
  validate(@OrganizationId() organizationId: string, @Body() body: unknown) {
    const definition = parseProductDefinition(
      (body as { definition?: unknown }).definition ?? body,
    );

    return {
      canvas: designerCanvas(definition, this.blocks),
      validation: validateProduct(definition, {
        blocks: this.blocks,
        connectors: this.connectors,
        organizationId,
        referenceData: this.referenceData,
      }),
    };
  }

  @Get(':productId/compare')
  @ApiOperation({ summary: 'Compare two versions by node, not by text' })
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_READ.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_READ.key)
  async compare(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('productId') productId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const registryActor = {
      actorId: actor.userId,
      organizationId,
      permissions: actor.permissions ?? [],
    };

    const before = await this.registry.version(registryActor, productId, from);
    const after = await this.registry.version(registryActor, productId, to);

    /*
     * A node-level diff, not a text one.
     *
     * A reviewer deciding whether to approve needs to see that a block was added and a fee
     * changed. A JSON diff is technically complete and useless to them, and a diff they cannot
     * read is a diff they approve anyway.
     */
    return {
      from,
      to,
      comparison: compareDesigns(before.definition, after.definition),
      canvases: {
        from: designerCanvas(before.definition, this.blocks),
        to: designerCanvas(after.definition, this.blocks),
      },
    };
  }
}

export { APPROVED_BLOCKS };
