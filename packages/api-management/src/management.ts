import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import type { AuditService } from '@trustos/audit';
import {
  type ApiCatalog,
  type ApiDefinition,
  type ApiOperation,
  apiClassification,
} from '@trustos/api-catalog';
import {
  type Consumer,
  type ConsumerRegistry,
  type Entitlement,
  decideAccess,
} from '@trustos/api-consumer';
import {
  type Quota,
  type QuotaUsageStore,
  consumeQuota,
  quotaHeaders,
  readQuota,
} from '@trustos/api-quota';
import {
  type RateCounterStore,
  type RateLimit,
  checkRate,
  rateHeaders,
} from '@trustos/api-rate-limit';
import { assertApiPolicy, type ApiPolicyContext } from '@trustos/api-policy';
import type { PolicyDocument } from '@trustos/policy-registry';

/**
 * The API management surface.
 *
 * The other seven packages each answer one question. This one puts them in an order, and the order
 * is the whole contribution — because the wrong order is expensive in ways that are invisible until
 * somebody looks at a bill or a breach.
 *
 * The gate runs:
 *
 *   1. **Catalog** — does this operation exist? A request for something undeclared is refused
 *      before anything else touches it.
 *   2. **Entitlement** — may this consumer call it? Code, not configuration.
 *   3. **Policy** — does any deployment policy refuse? Configuration, and it can only refuse.
 *   4. **Rate** — is the caller arriving too fast?
 *   5. **Quota** — has the caller used what they bought?
 *
 * Rate before quota, because a rate breach is transient and a quota breach is not: telling a
 * caller their quota is exhausted when they merely burst is a support ticket and, if the quota is
 * billable, an argument about money.
 *
 * Quota **last**, because quota consumption is the only step that costs the consumer something.
 * Counting it before an authorization failure means a caller can be billed for calls that were
 * refused — and a misconfigured integration hammering a 403 would exhaust the quota of the party
 * it was refused for.
 *
 * Everything that reaches the gate is recorded, including refusals. A refusal that is not counted
 * is a credential being probed and nobody knowing.
 */

export const analyticsRecordSchema = z
  .object({
    recordedAt: z.string().datetime(),
    apiId: z.string().min(3).max(64),
    apiVersion: z.string().min(5).max(20),
    operationId: z.string().min(3).max(120),
    method: z.string().min(3).max(10),
    consumerId: z.string().min(1).max(64).nullable(),
    organizationId: z.string().min(1).max(64).nullable(),
    /** The outcome of the gate, not of the handler. */
    outcome: z.enum(['allowed', 'refused']),
    /** Which stage refused, for the analytics the specification asks for. */
    refusedAt: z.enum(['catalog', 'entitlement', 'policy', 'rate', 'quota']).nullable(),
    reasonCode: z.string().max(64).nullable(),
    /** Response status, when the request went on to be handled. */
    status: z.number().int().min(100).max(599).nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    /** Whether the operation was deprecated — how deprecated-API use gets measured. */
    deprecated: z.boolean(),
    classification: z.string().min(5).max(30),
    correlationId: z.string().min(1).max(64).nullable(),
  })
  .strict();

export type AnalyticsRecord = z.infer<typeof analyticsRecordSchema>;

export interface AnalyticsSink {
  record(entry: AnalyticsRecord): Promise<void>;
}

export class InMemoryAnalyticsSink implements AnalyticsSink {
  readonly entries: AnalyticsRecord[] = [];

  async record(entry: AnalyticsRecord): Promise<void> {
    this.entries.push(entry);
  }
}

export interface GateRequest {
  readonly apiId: string;
  readonly version: string;
  readonly method: string;
  readonly path: string;
  readonly consumerId: string;
  readonly at: Date;
  readonly correlationId?: string;
}

export interface GateResult {
  readonly allowed: boolean;
  readonly api: ApiDefinition | null;
  readonly operation: ApiOperation | null;
  readonly consumer: Consumer | null;
  readonly entitlement: Entitlement | null;
  readonly refusedAt: 'catalog' | 'entitlement' | 'policy' | 'rate' | 'quota' | null;
  readonly reasonCode: string | null;
  readonly reason: string;
  /** Rate and quota headers, on success and on refusal. */
  readonly headers: Record<string, string>;
}

export interface ApiGatewayOptions {
  catalog: ApiCatalog;
  consumers: ConsumerRegistry;
  policies?: readonly PolicyDocument[];
  rateLimits?: readonly RateLimit[];
  rateStore?: RateCounterStore;
  /** Resolves the quota that applies to a consumer, or null when none does. */
  quotaFor?: (consumer: Consumer, api: ApiDefinition) => Quota | null;
  quotaStore?: QuotaUsageStore;
  analytics?: AnalyticsSink;
  /**
   * Optional. Refusals at the entitlement and policy stages are written here as security-relevant
   * events; successful calls are not — an audit trail with one entry per API call is an audit
   * trail nobody can read, and the analytics sink already counts them.
   */
  audit?: Pick<AuditService, 'record'>;
}

export class ApiGateway {
  constructor(private readonly options: ApiGatewayOptions) {}

  /**
   * Run the gate.
   *
   * Returns rather than throws, so the caller decides the response shape and the analytics record
   * is written exactly once either way. `assertAllowed` is the throwing form.
   */
  async check(request: GateRequest): Promise<GateResult> {
    const started = request.at.getTime();
    const api = this.options.catalog.get(request.apiId, request.version);

    if (!api) {
      return this.refuse({
        request,
        api: null,
        operation: null,
        consumer: null,
        entitlement: null,
        stage: 'catalog',
        code: 'api_not_found',
        reason: `${request.apiId}@${request.version} is not a declared API.`,
        headers: {},
        started,
      });
    }

    const operation = this.options.catalog.findOperation(api, request.method, request.path);

    if (!operation) {
      return this.refuse({
        request,
        api,
        operation: null,
        consumer: null,
        entitlement: null,
        stage: 'catalog',
        code: 'operation_not_declared',
        reason: `${request.method} ${request.path} is not declared on ${api.apiId}@${api.version}.`,
        headers: {},
        started,
      });
    }

    const consumer = this.options.consumers.get(request.consumerId);

    if (!consumer) {
      return this.refuse({
        request,
        api,
        operation,
        consumer: null,
        entitlement: null,
        stage: 'entitlement',
        code: 'consumer_not_registered',
        reason: 'This credential does not belong to a registered consumer.',
        headers: {},
        started,
      });
    }

    const access = decideAccess({ consumer, api, operation, at: request.at });

    if (!access.allowed) {
      return this.refuse({
        request,
        api,
        operation,
        consumer,
        entitlement: access.entitlement,
        stage: 'entitlement',
        code: access.code,
        reason: access.reason,
        headers: {},
        started,
      });
    }

    if (this.options.policies && this.options.policies.length > 0) {
      const context: ApiPolicyContext = {
        consumer,
        api,
        operation,
        entitlement: access.entitlement,
        at: request.at,
      };

      try {
        assertApiPolicy({ policies: this.options.policies, context });
      } catch (error) {
        const apiError = error as ApiError;
        return this.refuse({
          request,
          api,
          operation,
          consumer,
          entitlement: access.entitlement,
          stage: 'policy',
          code: String((apiError.context?.policyId as string | undefined) ?? 'api_policy_denied'),
          reason: apiError.message,
          headers: {},
          started,
        });
      }
    }

    let headers: Record<string, string> = {};

    if (this.options.rateLimits && this.options.rateStore) {
      const decision = await checkRate({
        limits: this.options.rateLimits,
        store: this.options.rateStore,
        request: {
          apiId: api.apiId,
          operationId: operation.operationId,
          consumerId: consumer.consumerId,
          organizationId: consumer.organizationId,
          at: request.at,
        },
      });

      headers = { ...headers, ...rateHeaders(decision) };

      if (!decision.allowed) {
        return this.refuse({
          request,
          api,
          operation,
          consumer,
          entitlement: access.entitlement,
          stage: 'rate',
          code: 'rate_limited',
          reason: decision.reason,
          headers,
          started,
        });
      }
    }

    /*
     * Quota last. It is the only stage that costs the consumer something, so counting it earlier
     * would bill a caller for calls that were refused — and a misconfigured integration hammering
     * a 403 would exhaust the quota of the party it was refused for.
     */
    const quota = this.options.quotaFor?.(consumer, api) ?? null;

    if (quota && this.options.quotaStore) {
      const decision = await consumeQuota({
        quota,
        store: this.options.quotaStore,
        at: request.at,
      });
      headers = { ...headers, ...quotaHeaders(decision.usage) };

      if (!decision.allowed) {
        return this.refuse({
          request,
          api,
          operation,
          consumer,
          entitlement: access.entitlement,
          stage: 'quota',
          code: 'quota_exhausted',
          reason: decision.reason,
          headers,
          started,
        });
      }
    }

    await this.options.analytics?.record(
      analyticsRecordSchema.parse({
        recordedAt: request.at.toISOString(),
        apiId: api.apiId,
        apiVersion: api.version,
        operationId: operation.operationId,
        method: operation.method,
        consumerId: consumer.consumerId,
        organizationId: consumer.organizationId,
        outcome: 'allowed',
        refusedAt: null,
        reasonCode: null,
        status: null,
        durationMs: Math.max(0, request.at.getTime() - started),
        deprecated: operation.deprecated,
        classification: operation.classification,
        correlationId: request.correlationId ?? null,
      }),
    );

    return {
      allowed: true,
      api,
      operation,
      consumer,
      entitlement: access.entitlement,
      refusedAt: null,
      reasonCode: null,
      reason: 'Allowed.',
      headers,
    };
  }

  private async refuse(input: {
    request: GateRequest;
    api: ApiDefinition | null;
    operation: ApiOperation | null;
    consumer: Consumer | null;
    entitlement: Entitlement | null;
    stage: 'catalog' | 'entitlement' | 'policy' | 'rate' | 'quota';
    code: string;
    reason: string;
    headers: Record<string, string>;
    started: number;
  }): Promise<GateResult> {
    await this.options.analytics?.record(
      analyticsRecordSchema.parse({
        recordedAt: input.request.at.toISOString(),
        apiId: input.request.apiId,
        apiVersion: input.request.version,
        operationId: input.operation?.operationId ?? 'unknown',
        method: input.request.method,
        consumerId: input.consumer?.consumerId ?? input.request.consumerId,
        organizationId: input.consumer?.organizationId ?? null,
        outcome: 'refused',
        refusedAt: input.stage,
        reasonCode: input.code,
        status: null,
        durationMs: Math.max(0, input.request.at.getTime() - input.started),
        deprecated: input.operation?.deprecated ?? false,
        classification:
          input.operation?.classification ?? (input.api ? apiClassification(input.api) : 'PUBLIC'),
        correlationId: input.request.correlationId ?? null,
      }),
    );

    /*
     * Authorization refusals reach the audit trail; rate and quota refusals do not. A caller
     * exceeding a limit is normal traffic, and burying an entitlement refusal among ten thousand
     * rate-limit entries is how the interesting one goes unnoticed.
     */
    if (input.stage === 'entitlement' || input.stage === 'policy') {
      await this.options.audit?.record({
        action: 'api.access.refused',
        entityType: 'api',
        entityId: `${input.request.apiId}@${input.request.version}`,
        actorId: null,
        organizationId: input.consumer?.organizationId ?? null,
        metadata: {
          consumerId: input.consumer?.consumerId ?? input.request.consumerId,
          operationId: input.operation?.operationId ?? null,
          method: input.request.method,
          stage: input.stage,
          reasonCode: input.code,
          correlationId: input.request.correlationId ?? null,
        },
      });
    }

    return {
      allowed: false,
      api: input.api,
      operation: input.operation,
      consumer: input.consumer,
      entitlement: input.entitlement,
      refusedAt: input.stage,
      reasonCode: input.code,
      reason: input.reason,
      headers: input.headers,
    };
  }

  async assertAllowed(request: GateRequest): Promise<GateResult> {
    const result = await this.check(request);
    if (result.allowed) return result;

    if (result.refusedAt === 'rate' || result.refusedAt === 'quota') {
      throw ApiError.rateLimited(result.reason, {
        reason: result.reasonCode,
        headers: result.headers,
      });
    }

    if (result.refusedAt === 'catalog') {
      throw ApiError.notFound(result.reason);
    }

    throw ApiError.forbidden(result.reason, { reason: result.reasonCode });
  }

  /** Usage for a consumer, without consuming anything — what a portal usage page reads. */
  async usageFor(input: {
    consumerId: string;
    apiId: string;
    version: string;
    at: Date;
  }): Promise<{ quota: ReturnType<typeof readQuota> | null }> {
    const consumer = this.options.consumers.require(input.consumerId);
    const api = this.options.catalog.require(input.apiId, input.version);
    const quota = this.options.quotaFor?.(consumer, api) ?? null;

    if (!quota || !this.options.quotaStore) return { quota: null };
    return { quota: readQuota({ quota, store: this.options.quotaStore, at: input.at }) };
  }
}

export interface ApiAnalytics {
  readonly totalRequests: number;
  readonly allowed: number;
  readonly refused: number;
  readonly refusalsByStage: Record<string, number>;
  readonly topApis: Array<{ apiId: string; requests: number }>;
  readonly topConsumers: Array<{ consumerId: string; requests: number }>;
  /** Calls to deprecated operations — what makes a retirement date actionable. */
  readonly deprecatedCalls: number;
  /**
   * Refusals at the entitlement stage, by consumer.
   *
   * The number worth alerting on. A consumer suddenly generating authorization failures is either
   * a broken deployment or a credential being probed, and both want a person.
   */
  readonly unauthorizedAttempts: Array<{ consumerId: string; attempts: number }>;
}

export function summariseAnalytics(entries: readonly AnalyticsRecord[]): ApiAnalytics {
  const count = (values: string[]): Map<string, number> => {
    const totals = new Map<string, number>();
    for (const value of values) totals.set(value, (totals.get(value) ?? 0) + 1);
    return totals;
  };

  const top = (totals: Map<string, number>, key: 'apiId' | 'consumerId') =>
    [...totals.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 10)
      .map(([value, requests]) => ({ [key]: value, requests }) as never);

  const refusals = entries.filter((entry) => entry.outcome === 'refused');

  return {
    totalRequests: entries.length,
    allowed: entries.length - refusals.length,
    refused: refusals.length,
    refusalsByStage: Object.fromEntries(
      count(refusals.map((entry) => entry.refusedAt ?? 'unknown')),
    ),
    topApis: top(count(entries.map((entry) => entry.apiId)), 'apiId'),
    topConsumers: top(
      count(entries.filter((entry) => entry.consumerId).map((entry) => entry.consumerId as string)),
      'consumerId',
    ),
    deprecatedCalls: entries.filter((entry) => entry.deprecated).length,
    unauthorizedAttempts: [
      ...count(
        refusals
          .filter((entry) => entry.refusedAt === 'entitlement' || entry.refusedAt === 'policy')
          .map((entry) => entry.consumerId ?? 'unknown'),
      ).entries(),
    ]
      .sort((left, right) => right[1] - left[1])
      .map(([consumerId, attempts]) => ({ consumerId, attempts })),
  };
}
