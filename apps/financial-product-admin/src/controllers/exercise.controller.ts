import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustsystem/authorization/nest';
import { CurrentUser } from '@trustsystem/auth';
import { RequirePermissions } from '@trustsystem/rbac';
import type { ActorContext } from '@trustsystem/shared-types';
import { OrganizationId } from '@trustsystem/tenancy';
import {
  FINANCIAL_PRODUCT_PERMISSIONS,
  executionInputSchema,
} from '@trustsystem/financial-product-core';
import type { ProductRegistry } from '@trustsystem/financial-product-registry';
import {
  SANDBOX_SCENARIOS,
  SCENARIO_DESCRIPTIONS,
  runSandbox,
} from '@trustsystem/financial-product-sandbox';
import { formatReport, simulate } from '@trustsystem/financial-product-simulator';
import { PRODUCT_REGISTRY } from '../tokens';

/**
 * Sandbox and simulator.
 *
 * The two ways to run a product without a customer. Both go through
 * `@trustsystem/financial-product-sandbox`, which has no constructor parameter through which a
 * production store, connector registry or credential could arrive — so "a sandbox run must never
 * touch production data" is a sentence with nowhere to be violated rather than a rule somebody
 * follows.
 *
 * Both routes are **reads** in the sense that matters: they create nothing a customer can see and
 * write nothing outside the request. They still need their own permissions, because a simulation
 * is expensive and a sandbox run reveals the product's internal structure through its step list.
 */
@ApiTags('Sandbox and simulator')
@ApiBearerAuth()
@Controller('financial-products')
export class ExerciseController {
  constructor(@Inject(PRODUCT_REGISTRY) private readonly registry: ProductRegistry) {}

  @Get('sandbox/scenarios')
  @ApiOperation({ summary: 'The failure scenarios a product can be exercised against' })
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_SANDBOX.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_SANDBOX.key)
  scenarios() {
    return {
      scenarios: SANDBOX_SCENARIOS.map((scenario) => ({
        scenario,
        description: SCENARIO_DESCRIPTIONS[scenario],
      })),
    };
  }

  @Post(':productId/sandbox')
  @ApiOperation({ summary: 'Run one transaction against mock providers' })
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_SANDBOX.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_SANDBOX.key)
  async sandbox(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('productId') productId: string,
    @Param('version') requestedVersion: string | undefined,
    @Body() body: { version?: string; input: unknown; scenarios?: unknown[] },
  ) {
    const registryActor = {
      actorId: actor.userId,
      organizationId,
      permissions: actor.permissions ?? [],
    };

    const version = body.version ?? requestedVersion;

    /*
     * A sandbox run may exercise a version that is not active — that is the point of it. The
     * binding still refuses a retired one, and it still verifies the content hash: a definition
     * edited outside the approval path must not be runnable anywhere, including here.
     */
    const published = version
      ? await this.registry.version(registryActor, productId, version)
      : await this.registry.activeVersion(registryActor, productId);

    const result = await runSandbox({
      version: published,
      input: executionInputSchema.parse(body.input),
      scenarios: (body.scenarios ?? []) as never,
    });

    return {
      execution: result.execution,
      events: result.events,
      audit: result.audit,
      unfiredScenarios: result.unfiredScenarios,
    };
  }

  @Post(':productId/simulate')
  @ApiOperation({ summary: 'Run many transactions and report the path distribution' })
  @RequirePermissions(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_SIMULATE.key)
  @Authorize(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_SIMULATE.key)
  async simulate(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('productId') productId: string,
    @Body() body: { version?: string; count?: number; seed?: number },
  ) {
    const registryActor = {
      actorId: actor.userId,
      organizationId,
      permissions: actor.permissions ?? [],
    };

    const published = body.version
      ? await this.registry.version(registryActor, productId, body.version)
      : await this.registry.activeVersion(registryActor, productId);

    /*
     * Bounded, and bounded here rather than by a client.
     *
     * A hundred thousand is the number the specification asks for and roughly six seconds of
     * work; a million from an impatient browser is six minutes of one process doing nothing
     * else. The ceiling is the difference between a feature and a denial of service somebody
     * triggers by holding down a key.
     */
    const count = Math.min(Math.max(body.count ?? 1000, 1), 100_000);

    const report = await simulate({
      version: published,
      count,
      seed: body.seed ?? 1,
      resetBalanceEvery: 1,
    });

    return { report, rendered: formatReport(report) };
  }
}
