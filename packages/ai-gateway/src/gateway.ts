import { randomUUID } from 'node:crypto';
import type { AuditService } from '@trustos/audit';
import type { LoggerPort } from '@trustos/logging';
import type { MetricsRecorder } from '@trustos/observability';
import { RETRY_PRESETS, withRetry, type RetryPolicy } from '@trustos/retry';
import {
  AiError,
  completionRequestSchema,
  type AiRequestContext,
  type CompletionChunk,
  type CompletionRequest,
  type CompletionResult,
  type Usage,
} from '@trustos/ai-sdk';
import { computeCost, type Model, type ModelRegistry } from '@trustos/model-registry';
import type { ModelRouter } from '@trustos/model-router';
import type { AiPolicyEngine } from '@trustos/ai-policy';
import type { CostMonitor } from '@trustos/cost-monitor';
import { AiCache, promptFingerprint } from '@trustos/ai-cache';
import { Guardrails } from '@trustos/guardrails';
import { TokenMeter } from '@trustos/token-meter';
import { detectPii } from '@trustos/content-filter';
import { AI_METRICS } from './metrics';
import { ProviderError, type AiProviderAdapter } from './provider';

/**
 * The AI gateway.
 *
 * **Applications never call a provider directly.** Every completion goes through here, and the
 * reason is not tidiness — it is that eleven things have to happen around a model call, and an
 * application that bypasses the gateway silently skips all of them:
 *
 *      validate → policy → route → fit context → budget → guardrails (in)
 *          → cache → provider (retry, fallback) → usage → cost → guardrails (out) → audit
 *
 * A direct provider call has no tenant policy, no budget, no cost record, no guardrail, no audit
 * entry and no fallback. It works perfectly in development and is unauditable in production.
 *
 * The order matters and is not arbitrary:
 *
 *   * **Policy before routing**, so a denied model is never even considered.
 *   * **Context fitting before the call**, so an oversized prompt fails locally rather than after
 *     the provider has counted and billed the prompt tokens.
 *   * **Budget before the call**, for the same reason.
 *   * **Input guardrails before the cache**, so a blocked request is blocked whether or not an
 *     answer happens to be cached.
 *   * **Cost recorded even on failure**, because a request that failed after the prompt was sent
 *     still cost money, and a cost report that omits failures under-reports exactly when spend is
 *     most surprising.
 */

export interface AiGatewayOptions {
  registry: ModelRegistry;
  router: ModelRouter;
  adapters: AiProviderAdapter[];

  policy?: AiPolicyEngine;
  guardrails?: Guardrails;
  cost?: CostMonitor;
  cache?: AiCache;
  meter?: TokenMeter;

  audit?: Pick<AuditService, 'record'>;
  logger?: LoggerPort;
  metrics?: MetricsRecorder;

  /** Defaults to the interactive preset: two retries, fast. */
  retry?: RetryPolicy;
  /** Ceiling on one provider call. Also passed to the adapter. */
  timeoutMs?: number;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export class AiGateway {
  private readonly adapters = new Map<string, AiProviderAdapter>();
  private readonly guardrails: Guardrails;
  private readonly meter: TokenMeter;
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly options: AiGatewayOptions) {
    for (const adapter of options.adapters) this.adapters.set(adapter.key, adapter);

    this.guardrails = options.guardrails ?? new Guardrails({ logger: options.logger });
    this.meter = options.meter ?? new TokenMeter();
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
  }

  /**
   * Runs a completion.
   *
   * The one method an application calls. Everything above happens inside it.
   */
  async complete(
    input: CompletionRequest,
    context: AiRequestContext,
    options: { guardrailProfile?: string | null; untrustedVariables?: Record<string, string> } = {},
  ): Promise<CompletionResult> {
    const id = this.newId('airq');
    const startedAt = Date.now();

    // 1. Validate. A malformed request must not reach a provider, where it becomes a billable
    //    error with a message written for somebody else's API.
    const request = completionRequestSchema.parse(input);

    this.options.metrics?.increment(AI_METRICS.REQUESTS, 1, {
      application: context.application,
      agent: context.agentId ?? 'none',
    });

    // 2. Resolve policy, and take the guardrail profile from it unless the caller named one.
    const policy = this.options.policy?.resolve({
      organizationId: context.organizationId,
      agentId: context.agentId,
    });

    const guardrailProfile = options.guardrailProfile ?? policy?.guardrailProfile ?? null;

    // 3. Input guardrails, before the cache — so a blocked request is blocked whether or not an
    //    answer happens to be sitting in the cache.
    const inputGuard = await this.guardrails.checkInput({
      messages: request.messages,
      untrustedVariables: options.untrustedVariables,
      profileName: guardrailProfile,
    });

    if (inputGuard.decision === 'blocked') {
      await this.auditBlocked(
        id,
        context,
        'input',
        inputGuard.findings.map((f) => f.code),
      );
      this.options.metrics?.increment(AI_METRICS.BLOCKED, 1, { stage: 'input' });
      throw this.guardrails.toError(inputGuard, 'input');
    }

    const messages = inputGuard.messages;

    // 4. Estimate the prompt, so routing can exclude models that cannot hold it and the budget
    //    check has something to work with.
    const estimate = this.meter.conversation(messages, request.tools ?? []);

    // 5. Route. Policy is applied inside the router, so a denied model is never a candidate.
    const decision = this.options.router.route({
      selection: request.model,
      organizationId: context.organizationId,
      agentId: context.agentId,
      requiredContextTokens: estimate.tokens + request.maxOutputTokens,
      requiredCapabilities: this.capabilitiesFor(request),
    });

    // 6. Budget, using the chosen model's pricing. Before the call, because a request refused
    //    after the prompt was sent has already cost money.
    if (this.options.cost && policy) {
      const estimatedCost = computeCost(decision.model, {
        promptTokens: estimate.tokens,
        completionTokens: request.maxOutputTokens,
      });

      await this.options.cost.assertBudget({
        organizationId: context.organizationId,
        budget: policy.budget,
        estimatedCostCents: estimatedCost,
      });
    }

    // 7. Cache. Only when the caller opted in *and* policy permits.
    const cacheAllowed = Boolean(request.cacheKey) && (policy?.allowCaching ?? false);

    if (this.options.cache && cacheAllowed) {
      const cached = await this.options.cache.get<CompletionResult>({
        organizationId: context.organizationId,
        kind: 'completion',
        modelId: decision.model.id,
        cacheKey: request.cacheKey!,
        promptVersion: context.promptVersion,
        discriminators: {
          fingerprint: promptFingerprint(messages),
          temperature: request.temperature ?? null,
          maxOutputTokens: request.maxOutputTokens,
        },
        allowedByPolicy: cacheAllowed,
      });

      if (cached) {
        this.options.metrics?.increment(AI_METRICS.CACHE_HITS, 1, { model: decision.model.id });

        const result: CompletionResult = {
          ...cached,
          id,
          cached: true,
          latencyMs: Date.now() - startedAt,
          createdAt: this.now(),
        };

        // Recorded at zero cost but as a request, so the cache's saving is visible rather than
        // the traffic simply disappearing from the report.
        await this.options.cost?.record({
          context,
          modelId: decision.model.id,
          usage: { ...cached.usage, estimated: true },
          latencyMs: result.latencyMs,
          outcome: 'cache_hit',
          cached: true,
        });

        return result;
      }
    }

    // 8. Call the provider, with retry and fallback.
    const attempt = await this.callWithFallback(request, messages, decision, context, id);

    // 9. Cost. Recorded before the output guardrails, because a response that a guardrail then
    //    blocks still cost money to produce.
    const costCents = computeCost(attempt.model, attempt.usage);

    await this.options.cost?.record({
      context,
      modelId: attempt.model.id,
      usage: attempt.usage,
      latencyMs: Date.now() - startedAt,
      outcome: attempt.finishReason,
    });

    this.options.metrics?.observe(AI_METRICS.LATENCY_MS, Date.now() - startedAt, {
      model: attempt.model.id,
      provider: attempt.model.provider,
    });
    this.options.metrics?.observe(AI_METRICS.COST_CENTS, costCents, { model: attempt.model.id });
    this.options.metrics?.observe(AI_METRICS.TOKENS, attempt.usage.totalTokens, {
      model: attempt.model.id,
    });

    // 10. Output guardrails.
    const parsed = this.parseIfRequested(request, attempt.content);

    const outputGuard = await this.guardrails.checkOutput({
      content: attempt.content,
      profileName: guardrailProfile,
      parsed: parsed.value,
      schemaValidator: parsed.validator,
    });

    if (outputGuard.decision === 'blocked') {
      await this.auditBlocked(
        id,
        context,
        'output',
        outputGuard.findings.map((f) => f.code),
      );
      this.options.metrics?.increment(AI_METRICS.BLOCKED, 1, { stage: 'output' });
      throw this.guardrails.toError(outputGuard, 'output');
    }

    const result: CompletionResult = {
      id,
      modelId: attempt.model.id,
      provider: attempt.model.provider,
      content: outputGuard.content,
      toolCalls: attempt.toolCalls,
      finishReason: attempt.finishReason,
      usage: attempt.usage,
      parsed: parsed.value,
      latencyMs: Date.now() - startedAt,
      costCents,
      cached: false,
      attempts: attempt.attempts,
      ...(attempt.fallbackFrom ? { fallbackFrom: attempt.fallbackFrom } : {}),
      createdAt: this.now(),
    };

    // 11. Cache the result, if the caller asked and nothing personal is in it.
    if (this.options.cache && cacheAllowed && outputGuard.decision === 'allowed') {
      await this.options.cache.set({
        organizationId: context.organizationId,
        kind: 'completion',
        modelId: attempt.model.id,
        cacheKey: request.cacheKey!,
        promptVersion: context.promptVersion,
        discriminators: {
          fingerprint: promptFingerprint(messages),
          temperature: request.temperature ?? null,
          maxOutputTokens: request.maxOutputTokens,
        },
        value: result,
        allowedByPolicy: cacheAllowed,
        containsPii: detectPii(attempt.content ?? '').found,
        savedCostCents: costCents,
        savedTokens: attempt.usage.totalTokens,
      });
    }

    // 12. Audit. Every AI request produces one — the content never, the metadata always.
    await this.audit(id, context, result, outputGuard.decision);

    return result;
  }

  /**
   * Streams a completion.
   *
   * Guardrails run on the input as normal. On the *output* they cannot: a guardrail decision needs
   * the whole response, and by the time it exists the caller has already seen it. So a streamed
   * response is checked after the fact and the caller is told the verdict at the end — which is
   * why a prompt whose output must be guarded should not be streamed to a customer. Said here
   * rather than discovered.
   */
  async *stream(
    input: CompletionRequest,
    context: AiRequestContext,
    options: { guardrailProfile?: string | null; untrustedVariables?: Record<string, string> } = {},
  ): AsyncIterable<CompletionChunk> {
    const id = this.newId('airq');
    const startedAt = Date.now();
    const request = completionRequestSchema.parse(input);

    const policy = this.options.policy?.resolve({
      organizationId: context.organizationId,
      agentId: context.agentId,
    });

    const inputGuard = await this.guardrails.checkInput({
      messages: request.messages,
      untrustedVariables: options.untrustedVariables,
      profileName: options.guardrailProfile ?? policy?.guardrailProfile ?? null,
    });

    if (inputGuard.decision === 'blocked') {
      yield { kind: 'error', message: this.guardrails.toError(inputGuard, 'input').message };
      return;
    }

    const estimate = this.meter.conversation(inputGuard.messages, request.tools ?? []);

    const decision = this.options.router.route({
      selection: request.model,
      organizationId: context.organizationId,
      agentId: context.agentId,
      requiredContextTokens: estimate.tokens + request.maxOutputTokens,
      // Streaming is a hard requirement here, so a model without it is not a candidate rather
      // than a failure at the adapter.
      requiredCapabilities: [...this.capabilitiesFor(request), 'streaming'],
    });

    const adapter = this.adapterFor(decision.model);

    if (!adapter.stream) {
      yield {
        kind: 'error',
        message: `The ${adapter.displayName} adapter does not support streaming.`,
      };
      return;
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    context.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);

    let content = '';
    let usage: Usage | undefined;

    try {
      for await (const chunk of adapter.stream({
        request: { ...request, messages: inputGuard.messages },
        model: decision.model,
        signal: controller.signal,
      })) {
        if (chunk.kind === 'content') content += chunk.delta;
        if (chunk.kind === 'finish') usage = chunk.usage;
        yield chunk;
      }
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onAbort);
    }

    if (usage) {
      await this.options.cost?.record({
        context,
        modelId: decision.model.id,
        usage,
        latencyMs: Date.now() - startedAt,
        outcome: 'stream',
      });
    }

    /*
     * The output check, after the fact.
     *
     * The caller has already seen the text. This is reported, audited and — for a profile that
     * requires review — enough to hold the *action* the output would trigger, but it cannot
     * unsend what was streamed.
     */
    const outputGuard = await this.guardrails.checkOutput({
      content,
      profileName: options.guardrailProfile ?? policy?.guardrailProfile ?? null,
    });

    if (outputGuard.decision !== 'allowed') {
      this.options.logger?.warn(
        {
          requestId: id,
          organizationId: context.organizationId,
          decision: outputGuard.decision,
          codes: outputGuard.findings.map((finding) => finding.code),
        },
        'streamed output would have been held by a guardrail, but had already been sent',
      );

      yield {
        kind: 'error',
        message:
          `This response was flagged after streaming: ${outputGuard.findings[0]?.detail ?? 'unknown'}. ` +
          'Do not stream a prompt whose output must be guarded.',
      };
    }
  }

  /**
   * Calls the provider, retrying and then falling back.
   *
   * Two different mechanisms, and the distinction matters: **retry** is for a transient failure of
   * one model, **fallback** is for a model that is not coming back. Retrying a model that returns
   * "model not found" forever would be four attempts of guaranteed failure before anything useful
   * happens.
   */
  private async callWithFallback(
    request: CompletionRequest,
    messages: CompletionRequest['messages'],
    decision: ReturnType<ModelRouter['route']>,
    context: AiRequestContext,
    requestId: string,
  ): Promise<{
    model: Model;
    content: string | null;
    toolCalls: CompletionResult['toolCalls'];
    finishReason: CompletionResult['finishReason'];
    usage: Usage;
    attempts: number;
    fallbackFrom?: string;
  }> {
    const chain = [decision.model, ...decision.fallbacks];
    let lastError: unknown;

    for (const [index, model] of chain.entries()) {
      const adapter = this.adapterFor(model);
      const supported = adapter.supports({ ...request, messages }, model);

      if (!supported.ok) {
        this.options.logger?.debug(
          { requestId, modelId: model.id, reason: supported.reason },
          'skipping a model whose adapter cannot serve this request',
        );
        lastError = new ProviderError(supported.reason, { retryable: false, modelId: model.id });
        continue;
      }

      try {
        const outcome = await withRetry(
          async (_attempt, signal) => {
            const controller = new AbortController();
            const onAbort = () => controller.abort();
            signal?.addEventListener('abort', onAbort, { once: true });
            context.signal?.addEventListener('abort', onAbort, { once: true });
            const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);

            try {
              return await adapter.complete({
                request: { ...request, messages },
                model,
                signal: controller.signal,
              });
            } finally {
              clearTimeout(timer);
              signal?.removeEventListener('abort', onAbort);
              context.signal?.removeEventListener('abort', onAbort);
            }
          },
          {
            operation: `ai.${model.provider}.${model.id}`,
            policy: this.options.retry ?? RETRY_PRESETS.interactive,
            signal: context.signal,
            isRetryable: (error) =>
              error instanceof ProviderError ? error.detail.retryable : true,
            onRetry: (retryAttempt) => {
              this.options.metrics?.increment(AI_METRICS.RETRIES, 1, { model: model.id });
              this.options.logger?.warn(
                {
                  requestId,
                  modelId: model.id,
                  attempt: retryAttempt.attempt,
                  error:
                    retryAttempt.error instanceof Error
                      ? retryAttempt.error.message
                      : String(retryAttempt.error),
                },
                'AI provider call failed; retrying',
              );
            },
          },
        );

        return {
          model,
          content: outcome.value.content,
          toolCalls: outcome.value.toolCalls,
          finishReason: outcome.value.finishReason,
          usage: outcome.value.usage,
          attempts: outcome.attempts,
          ...(index > 0 ? { fallbackFrom: chain[0]!.id } : {}),
        };
      } catch (error) {
        lastError = error;

        const cause = error instanceof ProviderError ? error : unwrapProviderError(error);

        if (cause?.detail.refused) {
          // A provider safety refusal is not an outage. Falling back to another model to get past
          // it would be the framework routing around a safety decision, which is not its call.
          throw AiError.policyDenied(
            `The provider refused this request on its own safety grounds: ${cause.message}`,
            { reason: 'provider_refused', modelId: model.id, provider: model.provider },
          );
        }

        if (cause?.detail.modelUnavailable) {
          // Marked in the registry, so the router stops choosing it for everybody — which is what
          // makes an outage self-healing rather than a per-request retry storm.
          this.options.registry.markUnavailable(model.id, cause.message);
        }

        this.options.metrics?.increment(AI_METRICS.FAILURES, 1, {
          model: model.id,
          provider: model.provider,
        });

        this.options.logger?.warn(
          {
            requestId,
            modelId: model.id,
            remaining: chain.length - index - 1,
            error: error instanceof Error ? error.message : String(error),
          },
          'AI model failed; trying the next in the fallback chain',
        );
      }
    }

    throw AiError.providerUnavailable(
      `Every model in the chain failed (${chain.map((model) => model.id).join(' → ')}). ` +
        `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      { reason: 'provider_unavailable' },
    );
  }

  private adapterFor(model: Model): AiProviderAdapter {
    const adapter = this.adapters.get(model.provider);

    if (!adapter) {
      throw AiError.noModelAvailable(
        `No adapter is registered for the provider "${model.provider}", which the model ` +
          `"${model.id}" needs. The framework ships no provider adapters — a deployment supplies ` +
          'them.',
        { modelId: model.id, provider: model.provider },
      );
    }

    return adapter;
  }

  /** Capabilities this particular request needs, so routing excludes models that lack them. */
  private capabilitiesFor(request: CompletionRequest): string[] {
    const capabilities: string[] = [];

    if (request.tools?.length) capabilities.push('tools');
    if (request.responseFormat?.kind === 'json_schema') capabilities.push('json_schema');
    else if (request.responseFormat?.kind === 'json') capabilities.push('json');

    return capabilities;
  }

  /** Parses a structured response, when one was asked for. */
  private parseIfRequested(
    request: CompletionRequest,
    content: string | null,
  ): { value: unknown; validator?: (value: unknown) => { valid: boolean; error?: string } } {
    if (!request.responseFormat || request.responseFormat.kind === 'text' || !content) {
      return { value: undefined };
    }

    let value: unknown;

    try {
      value = JSON.parse(content);
    } catch (error) {
      return {
        value: undefined,
        validator: () => ({
          valid: false,
          // Names the likely cause: a truncated response is by far the most common reason a model
          // "produced invalid JSON".
          error:
            `The model was asked for JSON and produced something that does not parse: ` +
            `${error instanceof Error ? error.message : 'unknown'}. If the finish reason is ` +
            '"length", the output is truncated rather than malformed.',
        }),
      };
    }

    const format = request.responseFormat;

    if (format.kind !== 'json_schema' || !format.strict) {
      return { value };
    }

    return {
      value,
      // The gateway validates shape locally regardless of whether the provider enforced it, so a
      // provider that ignores the schema does not produce a "successful" mismatched result.
      // `format` is captured after narrowing rather than re-read, so the closure cannot see a
      // different branch than the check did.
      validator: (parsed: unknown) => validateAgainstSchema(parsed, format),
    };
  }

  private async audit(
    id: string,
    context: AiRequestContext,
    result: CompletionResult,
    decision: string,
  ): Promise<void> {
    await this.options.audit?.record({
      action: 'ai.request.completed',
      entityType: 'AiRequest',
      entityId: id,
      actorId: context.actorId,
      organizationId: context.organizationId,
      /*
       * Metadata, never content.
       *
       * An audit trail of prompts and responses is a copy of every conversation in a table that
       * more people can read than the conversation itself. What is recorded is enough to answer
       * "who asked what model for what, what did it cost, and was it checked".
       */
      after: {
        modelId: result.modelId,
        provider: result.provider,
        application: context.application,
        agentId: context.agentId ?? null,
        promptId: context.promptId ?? null,
        promptVersion: context.promptVersion ?? null,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        costCents: result.costCents,
        latencyMs: result.latencyMs,
        finishReason: result.finishReason,
        guardrailDecision: decision,
        cached: result.cached,
        attempts: result.attempts,
        fallbackFrom: result.fallbackFrom ?? null,
      },
    });
  }

  private async auditBlocked(
    id: string,
    context: AiRequestContext,
    stage: 'input' | 'output',
    codes: string[],
  ): Promise<void> {
    await this.options.audit?.record({
      action: 'ai.request.blocked',
      entityType: 'AiRequest',
      entityId: id,
      actorId: context.actorId,
      organizationId: context.organizationId,
      after: { stage, codes, application: context.application, agentId: context.agentId ?? null },
    });
  }

  /** Adapter health, for the health endpoint and `trustos ai doctor`. */
  async health(): Promise<
    Array<{ provider: string; status: string; detail: string; latencyMs: number }>
  > {
    return Promise.all(
      [...this.adapters.values()].map(async (adapter) => {
        if (!adapter.health) {
          return {
            provider: adapter.key,
            status: 'unknown',
            detail: 'This adapter does not implement a health check.',
            latencyMs: 0,
          };
        }

        try {
          const health = await adapter.health();
          return { provider: adapter.key, ...health };
        } catch (error) {
          // A throwing health check reports unavailable with the reason, rather than taking the
          // health endpoint down with it.
          return {
            provider: adapter.key,
            status: 'unavailable',
            detail: error instanceof Error ? error.message : String(error),
            latencyMs: 0,
          };
        }
      }),
    );
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.adapters.values()].map((adapter) => adapter.shutdown?.() ?? Promise.resolve()),
    );
  }

  providerKeys(): string[] {
    return [...this.adapters.keys()].sort();
  }
}

/** Finds a `ProviderError` inside a retry wrapper. */
function unwrapProviderError(error: unknown): ProviderError | null {
  if (error instanceof ProviderError) return error;

  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof ProviderError) return cause;

  return null;
}

/**
 * A deliberately small JSON Schema check.
 *
 * Type, required properties and enum values. Not a full validator — a complete implementation is
 * a package of its own, and the cases that actually catch a model's mistake are these three. A
 * deployment that needs more passes a zod schema through `schemaValidatorFor` in `guardrails`.
 */
function validateAgainstSchema(
  value: unknown,
  format: { kind: 'json_schema'; name: string; schema: Record<string, unknown> },
): { valid: boolean; error?: string } {
  const schema = format.schema;
  const expected = schema.type as string | undefined;

  if (expected === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { valid: false, error: `Expected an object for "${format.name}".` };
    }

    const required = (schema.required as string[] | undefined) ?? [];
    const missing = required.filter((key) => !(key in (value as Record<string, unknown>)));

    if (missing.length > 0) {
      return {
        valid: false,
        error: `"${format.name}" is missing required propert${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')}.`,
      };
    }

    const properties = (schema.properties as Record<string, Record<string, unknown>>) ?? {};
    for (const [key, definition] of Object.entries(properties)) {
      const propertyValue = (value as Record<string, unknown>)[key];
      if (propertyValue === undefined) continue;

      const propertyType = definition.type as string | undefined;
      if (propertyType && !matchesType(propertyValue, propertyType)) {
        return {
          valid: false,
          error: `"${format.name}.${key}" should be ${propertyType} and is ${typeof propertyValue}.`,
        };
      }

      const allowed = definition.enum as unknown[] | undefined;
      if (allowed && !allowed.includes(propertyValue)) {
        return {
          valid: false,
          error: `"${format.name}.${key}" is "${String(propertyValue)}", which is not one of: ${allowed.join(', ')}.`,
        };
      }
    }

    return { valid: true };
  }

  if (expected === 'array' && !Array.isArray(value)) {
    return { valid: false, error: `Expected an array for "${format.name}".` };
  }

  return { valid: true };
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}
