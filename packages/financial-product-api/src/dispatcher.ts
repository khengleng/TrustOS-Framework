import {
  productError,
  productErrorCode,
  systemClock,
  type ExecutionInput,
  type ProductActor,
  type ProductClock,
} from '@trustos/financial-product-core';
import type { ProductRegistry, RegistryActor } from '@trustos/financial-product-registry';
import type { ExecutionRecord, ProductRuntime } from '@trustos/financial-product-runtime';
import { ProductRouteTable, type ProductRoute } from './routes';

/**
 * The dispatcher.
 *
 * Headless: it takes a request shape and returns a response shape, and it knows nothing about
 * HTTP beyond a method, a path, headers and a body. That is the same choice `@trustos/template-sdk`
 * makes and for the same reason — a deployment runs NestJS, another runs Fastify, and a
 * dispatcher that imported either would be unusable in the other. The framework ships the
 * decision-making; the deployment ships the twelve lines that adapt it.
 *
 * The order of checks is the design, and it is the same order the security-admin application's
 * guards run in, for the same reason: each one can only refuse, and the earlier ones are the ones
 * whose refusal reveals least.
 *
 *   1. **Route.** No such route is a 404 before anything else is consulted.
 *   2. **Authentication.** The actor arrives already verified — the dispatcher never resolves
 *      one, and there is no parameter through which a caller could supply an identity.
 *   3. **Tenant.** From the verified actor, never from a header. An `X-Organization-Id` naming an
 *      organization is a request, not a fact.
 *   4. **Permission.** Deny by default.
 *   5. **Idempotency key.** Required where the operation creates a transaction, and refused as
 *      *missing* rather than silently generated — a generated key makes every retry a new
 *      transaction.
 *   6. **Rate limit.** Last of the refusals, because a 429 tells a caller their credential works.
 *   7. **Execute.**
 */

export interface ProductApiRequest {
  method: string;
  path: string;
  /** Lower-cased header names. The adapter normalises; the dispatcher does not guess. */
  headers: Readonly<Record<string, string>>;
  body: Readonly<Record<string, unknown>>;
  /** The verified actor. Resolved by the deployment's authentication, never by this package. */
  actor: ProductActor;
  /** Permissions resolved server-side from the membership tables. */
  permissions: readonly string[];
  requestId?: string;
}

export interface ProductApiResponse {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export interface RateLimiter {
  /** Whether this actor may make another call to this operation now. */
  allow(key: string, limitPerMinute: number, now: Date): boolean;
}

/**
 * A fixed-window limiter.
 *
 * In memory, per process, and **stated to be approximate**: a fixed window lets twice the limit
 * through across a boundary, and a deployment that needs a real limit wires a shared one. Saying
 * so here is the difference between a known approximation and a control somebody trusts.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { minute: number; count: number }>();

  allow(key: string, limitPerMinute: number, now: Date): boolean {
    const minute = Math.floor(now.getTime() / 60_000);
    const window = this.windows.get(key);

    if (!window || window.minute !== minute) {
      this.windows.set(key, { minute, count: 1 });
      return true;
    }

    if (window.count >= limitPerMinute) return false;

    window.count += 1;
    return true;
  }
}

export interface ProductDispatcherOptions {
  registry: ProductRegistry;
  runtime: ProductRuntime;
  routes?: ProductRouteTable;
  rateLimiter?: RateLimiter;
  clock?: ProductClock;
}

export class ProductDispatcher {
  private readonly routes: ProductRouteTable;
  private readonly rateLimiter: RateLimiter;
  private readonly clock: ProductClock;

  constructor(private readonly options: ProductDispatcherOptions) {
    this.routes = options.routes ?? new ProductRouteTable();
    this.rateLimiter = options.rateLimiter ?? new InMemoryRateLimiter();
    this.clock = options.clock ?? systemClock;
  }

  /** Registers a product's routes. Called when a version is activated. */
  expose(definition: Parameters<ProductRouteTable['register']>[0]): ProductRoute[] {
    return this.routes.register(definition);
  }

  routeTable(): ProductRouteTable {
    return this.routes;
  }

  async dispatch(request: ProductApiRequest): Promise<ProductApiResponse> {
    const now = this.clock.now();

    // --- 1: route ---------------------------------------------------------
    const matched = this.routes.match(request.method, request.path);

    if (!matched) {
      return errorResponse(404, 'not_found', 'No such operation.', request.requestId);
    }

    const { route } = matched;

    // --- 2-3: the actor and the tenant, both already verified --------------
    const registryActor: RegistryActor = {
      actorId: request.actor.actorId,
      organizationId: request.actor.organizationId,
      permissions: request.permissions,
    };

    // --- 4: permission ----------------------------------------------------
    if (!request.permissions.includes(route.permission)) {
      return errorResponse(
        403,
        'forbidden',
        `This operation requires "${route.permission}".`,
        request.requestId,
      );
    }

    // --- 5: idempotency ---------------------------------------------------
    const idempotencyKey = request.headers['idempotency-key'] ?? null;

    if (route.requiresIdempotencyKey && !idempotencyKey) {
      return errorResponse(
        400,
        'idempotency_key_required',
        'This operation creates a transaction and requires an Idempotency-Key header. A key ' +
          'generated on your behalf would make every retry a new transaction.',
        request.requestId,
      );
    }

    // --- 6: rate limit ----------------------------------------------------
    if (route.rateLimitPerMinute !== null) {
      const key = `${request.actor.organizationId ?? 'platform'}|${request.actor.actorId}|${route.operationId}`;

      if (!this.rateLimiter.allow(key, route.rateLimitPerMinute, now)) {
        return {
          status: 429,
          headers: {
            'retry-after': '60',
            ...(request.requestId ? { 'x-request-id': request.requestId } : {}),
          },
          body: {
            code: 'rate_limited',
            message: `This operation is limited to ${route.rateLimitPerMinute} calls a minute.`,
          },
        };
      }
    }

    // --- 7: execute -------------------------------------------------------
    try {
      const version = await this.options.registry.activeVersion(registryActor, route.productId);

      const record = await this.options.runtime.execute({
        version,
        actor: request.actor,
        input: readInput(request.body),
        usage: readUsage(request.body),
        operation: route.operationId,
        idempotencyKey,
        environment: 'production',
        entryBlock: route.entryBlock,
        ...(request.requestId ? { correlationId: request.requestId } : {}),
      });

      return {
        status: statusFor(record),
        headers: {
          'x-trustos-execution-id': record.executionId,
          'x-trustos-product-version': record.productVersion,
          ...(request.requestId ? { 'x-request-id': request.requestId } : {}),
        },
        body: projectExecution(record),
      };
    } catch (error) {
      return errorFromRefusal(error, request.requestId);
    }
  }
}

/**
 * What a channel sees of an execution.
 *
 * A projection, and a narrow one. The full record carries the rule trace, every step, the
 * definition hash and the block ids — all of it useful to an operator and none of it a channel's
 * business. A response that included the trace would be a response a channel starts branching on,
 * and then the workflow cannot change.
 */
export function projectExecution(record: ExecutionRecord): Record<string, unknown> {
  return {
    executionId: record.executionId,
    productId: record.productId,
    productVersion: record.productVersion,
    state: record.state,
    outcome: record.outcome,
    ...(record.refusal ? { refusalCode: record.refusal.code, refusalReason: record.refusal.reason } : {}),
    ...(record.pendingReview ? { pendingReviewLevel: record.pendingReview.level } : {}),
    startedAt: record.startedAt.toISOString(),
    ...(record.finishedAt ? { finishedAt: record.finishedAt.toISOString() } : {}),
  };
}

/**
 * The status an execution's outcome produces.
 *
 * A refusal is a 200 with a refusal code, not a 4xx — and that is a deliberate and arguable
 * choice, so it is worth stating why. The request was well-formed, authorized and processed; the
 * product decided not to proceed. A 4xx says the caller did something wrong, and a channel that
 * treats a limit refusal as a client error retries it, which is the one thing it must not do.
 *
 * A *failure* is a 502: something the platform depends on did not answer, and retrying is
 * reasonable.
 */
function statusFor(record: ExecutionRecord): number {
  if (record.outcome === 'failure') return 502;
  return 200;
}

function readInput(body: Readonly<Record<string, unknown>>): ExecutionInput {
  return {
    ...(typeof body.amountMinorUnits === 'string' ? { amountMinorUnits: body.amountMinorUnits } : {}),
    ...(typeof body.currency === 'string' ? { currency: body.currency } : {}),
    ...(typeof body.country === 'string' ? { country: body.country } : {}),
    ...(typeof body.transactionType === 'string' ? { transactionType: body.transactionType } : {}),
    ...(typeof body.customerType === 'string' ? { customerType: body.customerType } : {}),
    ...(typeof body.merchantType === 'string' ? { merchantType: body.merchantType } : {}),
    ...(typeof body.merchantTier === 'string' ? { merchantTier: body.merchantTier } : {}),
    ...(typeof body.channel === 'string' ? { channel: body.channel } : {}),
    ...(typeof body.kycLevel === 'string' ? { kycLevel: body.kycLevel } : {}),
    references: isStringRecord(body.references) ? body.references : {},
    attributes: isScalarRecord(body.attributes) ? body.attributes : {},
  };
}

/**
 * Usage is read from the request only in the absence of a usage service.
 *
 * Defaulted to zero rather than trusted: a caller-supplied daily usage would let a client tell the
 * limit engine how much they had already spent. The deployment wires `@trustos/limits` and
 * supplies the real figures through the runtime.
 */
function readUsage(_body: Readonly<Record<string, unknown>>) {
  return { dailyUsageMinorUnits: '0', monthlyUsageMinorUnits: '0', velocityCount: 0 };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function isScalarRecord(value: unknown): value is Record<string, string | number | boolean> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every(
      (entry) => typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean',
    )
  );
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string | undefined,
): ProductApiResponse {
  return {
    status,
    headers: requestId ? { 'x-request-id': requestId } : {},
    body: { code, message, ...(requestId ? { requestId } : {}) },
  };
}

/**
 * Turns a product refusal into a response.
 *
 * The message is the framework's own — it names a control rather than an internal — and an
 * unexpected error becomes a 500 with its message withheld, because an unexpected error's message
 * is the one most likely to say something a caller should not see.
 */
function errorFromRefusal(error: unknown, requestId: string | undefined): ProductApiResponse {
  const code = productErrorCode(error);

  if (!code) {
    return errorResponse(500, 'internal_error', 'An unexpected error occurred.', requestId);
  }

  const status =
    code === 'product_not_found' || code === 'product_version_not_found' || code === 'product_tenant_mismatch'
      ? 404
      : code === 'product_idempotency_conflict' || code === 'product_version_binding_broken'
        ? 409
        : code === 'product_not_executable'
          ? 503
          : 403;

  return errorResponse(status, code, (error as Error).message, requestId);
}

export { productError };
