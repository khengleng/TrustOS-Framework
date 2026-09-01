import { Body, Controller, Inject, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustsystem/authorization/nest';
import { CurrentUser } from '@trustsystem/auth';
import { HumanActorsOnly } from '@trustsystem/identity/nest';
import { RequirePermissions } from '@trustsystem/rbac';
import type { ActorContext } from '@trustsystem/shared-types';
import { OrganizationId } from '@trustsystem/tenancy';
import {
  FINANCIAL_PRODUCT_PERMISSIONS,
  parseProductDefinition,
} from '@trustsystem/financial-product-core';
import { parseVariant } from '@trustsystem/financial-product-variants';
import type { ProductRegistry, RegistryActor } from '@trustsystem/financial-product-registry';
import { PRODUCT_REGISTRY } from '../tokens';

/**
 * Composing, governing and deploying a product.
 *
 * Every route here changes something, and every one of them goes through the registry rather than
 * doing the work itself. That is not a layering preference: the registry is the only place that
 * resolves a lifecycle transition before consulting authorization, checks the definition still
 * hashes to what was reviewed, and writes the audit record in the same call as the state change.
 * A controller that reimplemented any of that would be a second implementation with a hole in it.
 *
 * **`HumanActorsOnly` on the governance routes.** A service account may read a product and may
 * execute one; it may not submit, approve, publish or roll one back. An approval recorded by a
 * credential is an approval nobody made, and the trail would show a machine agreeing with itself.
 * `pause` is deliberately not restricted — an automated circuit breaker withdrawing a product
 * during an incident is exactly the thing that should not wait for a person.
 */
@ApiTags('Product composer')
@ApiBearerAuth()
@Controller('financial-products')
export class ComposerController {
  constructor(@Inject(PRODUCT_REGISTRY) private readonly registry: ProductRegistry) {}

  private actorOf(actor: ActorContext, organizationId: string): RegistryActor {
    return {
      actorId: actor.userId,
      organizationId,
      /*
       * Permissions from the verified actor, resolved server-side by `AccessResolver`.
       *
       * Never from the request. The registry checks them again, and a client-supplied list would
       * make both checks decorative.
       */
      permissions: actor.permissions ?? [],
    };
  }

  @Post()
  @ApiOperation({ summary: 'Create a draft product' })
  @HumanActorsOnly()
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_CREATE.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_CREATE.key)
  async create(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Body() body: unknown,
  ) {
    const definition = parseProductDefinition(
      (body as { definition?: unknown }).definition ?? body,
    );
    return this.registry.create(this.actorOf(actor, organizationId), definition);
  }

  @Put(':productId/draft')
  @ApiOperation({ summary: 'Replace the draft' })
  @HumanActorsOnly()
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_UPDATE.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_UPDATE.key)
  async update(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('productId') productId: string,
    @Body() body: unknown,
  ) {
    const definition = parseProductDefinition(
      (body as { definition?: unknown }).definition ?? body,
    );
    return this.registry.updateDraft(this.actorOf(actor, organizationId), productId, definition);
  }

  @Post(':productId/transitions/:action')
  @ApiOperation({ summary: 'Move the draft through the lifecycle' })
  @HumanActorsOnly()
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_UPDATE.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_UPDATE.key)
  async transition(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('productId') productId: string,
    @Param('action') action: string,
  ) {
    return this.registry.transition(this.actorOf(actor, organizationId), productId, action);
  }

  @Post(':productId/decisions')
  @ApiOperation({ summary: 'Record an approval or a rejection' })
  @HumanActorsOnly()
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_APPROVE.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_APPROVE.key)
  async decide(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('productId') productId: string,
    @Body() body: { level: string; decision: 'approved' | 'rejected'; reason?: string },
  ) {
    return this.registry.decide(this.actorOf(actor, organizationId), productId, body);
  }

  @Post(':productId/publish')
  @ApiOperation({ summary: 'Publish the approved draft as an immutable version' })
  @HumanActorsOnly()
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_PUBLISH.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_PUBLISH.key)
  async publish(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('productId') productId: string,
    @Body() body: { changeSummary: string },
  ) {
    return this.registry.publish(
      this.actorOf(actor, organizationId),
      productId,
      body.changeSummary,
    );
  }

  @Post(':productId/versions/:version/activate')
  @ApiOperation({ summary: 'Make a staged version the one new executions bind to' })
  @HumanActorsOnly()
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_PUBLISH.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_PUBLISH.key)
  async activate(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('productId') productId: string,
    @Param('version') version: string,
  ) {
    return this.registry.activate(this.actorOf(actor, organizationId), productId, version);
  }

  /**
   * Withdraw a live product.
   *
   * Deliberately not `HumanActorsOnly`. An automated circuit breaker pausing a product during an
   * incident is the thing that should not wait for somebody to log in, and pausing is the one
   * governed action whose failure mode is "we stopped too much" rather than "we allowed too
   * much".
   */
  @Post(':productId/pause')
  @ApiOperation({ summary: 'Withdraw a live product from new transactions' })
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_PAUSE.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_PAUSE.key)
  async pause(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('productId') productId: string,
    @Body() body: { reason: string },
  ) {
    return this.registry.pause(this.actorOf(actor, organizationId), productId, body.reason);
  }

  @Post(':productId/rollback/plan')
  @ApiOperation({ summary: 'Produce the rollback plan. Changes nothing.' })
  @HumanActorsOnly()
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_ROLLBACK.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_ROLLBACK.key)
  async planRollback(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('productId') productId: string,
    @Body() body: { toVersion: string; reason: string },
  ) {
    return this.registry.planRollback(
      this.actorOf(actor, organizationId),
      productId,
      body.toVersion,
      body.reason,
    );
  }

  /**
   * Apply a rollback plan.
   *
   * Takes the plan the previous route produced, so what was reviewed is what runs. A route that
   * took the arguments again would be a second code path, and it would stop predicting the plan
   * the first time they diverged.
   */
  @Post(':productId/rollback/apply')
  @ApiOperation({ summary: 'Apply a rollback plan' })
  @HumanActorsOnly()
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_ROLLBACK.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_ROLLBACK.key)
  async applyRollback(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Body() body: { plan: Parameters<ProductRegistry['rollback']>[1] },
  ) {
    return this.registry.rollback(this.actorOf(actor, organizationId), body.plan);
  }

  @Put(':productId/variants/:variantId')
  @ApiOperation({ summary: 'Create or change a variant’s override configuration' })
  @HumanActorsOnly()
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.VARIANT_MANAGE.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.VARIANT_MANAGE.key)
  async saveVariant(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Body() body: unknown,
  ) {
    const variant = parseVariant((body as { variant?: unknown }).variant ?? body);
    return this.registry.saveVariant(this.actorOf(actor, organizationId), variant);
  }
}
