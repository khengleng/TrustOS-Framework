import { randomUUID } from 'node:crypto';
import { ApiError } from '@trustos/errors';
import type { AuditService } from '@trustos/audit';
import type { LoggerPort } from '@trustos/logging';
import type { MetricsRecorder } from '@trustos/observability';
import {
  AiError,
  isComplete,
  message,
  type AiRequestContext,
  type CompletionRequest,
  type CompletionResult,
  type Message,
  type ToolCall,
} from '@trustos/ai-sdk';
import type { AgentDefinition } from '@trustos/agent-framework';
import type { AiGateway } from '@trustos/ai-gateway';
import type { AiPolicyEngine } from '@trustos/ai-policy';
import type { MemoryService } from '@trustos/agent-memory';
import type { ConversationService } from '@trustos/conversation';
import { toToolMessage, type FunctionResult } from '@trustos/function-calling';
import type { ToolRegistry } from '@trustos/tool-execution';

/**
 * The agent runtime.
 *
 * The loop: send the conversation, get a response, run any tools it asked for, send the results,
 * repeat until it stops or hits a limit.
 *
 * Everything difficult about an agent is in when to *stop*, and the answer is not "when the model
 * says it is done". Four things end a run, and three of them are limits:
 *
 *   * **A final answer** — the model responded with no tool calls. The normal ending.
 *   * **Steps** — a loop that has not converged in ten model calls is not going to. Each step
 *     re-sends the whole conversation, so step twelve costs far more than step two.
 *   * **Tokens** — the direct cost control, and the one that actually bounds the bill.
 *   * **Time** — a run waiting on a slow tool would otherwise wait forever.
 *
 * A run that hits a limit is **not a success**. It reports `limit_reached`, and a caller that
 * treats that as an answer is presenting a half-finished thought as a conclusion.
 *
 * The other thing worth stating: **every tool call is checked against the actor's permissions**,
 * not the agent's. That is what makes a successful prompt injection survivable — an instruction
 * smuggled into a support ticket telling the agent to issue a refund fails because the person on
 * whose behalf it is acting cannot issue refunds, and no wording changes that.
 */

export const AGENT_METRICS = {
  RUNS: 'agent.runs',
  STEPS: 'ai.agent.steps',
  TOOL_CALLS: 'ai.agent.tool_calls',
  LIMIT_REACHED: 'ai.agent.limit_reached',
  DURATION_MS: 'ai.agent.duration_ms',
  COST_CENTS: 'ai.agent.cost_cents',
  REVIEW_REQUIRED: 'ai.agent.review_required',
} as const;

export interface AgentRunStep {
  step: number;
  /** What the model said, if anything. */
  content: string | null;
  toolCalls: ToolCall[];
  toolResults: FunctionResult[];
  modelId: string;
  tokens: number;
  costCents: number;
  latencyMs: number;
}

export interface AgentRunResult {
  runId: string;
  agentId: string;
  conversationId: string | null;

  /** The final answer, or null when the run ended without one. */
  output: string | null;
  /** Parsed and validated, when the agent declares an output schema. */
  parsed: unknown;

  /** Why it stopped. `limit_reached` is not a success. */
  stopReason: 'final_answer' | 'tool_success' | 'schema_satisfied' | 'limit_reached' | 'error';
  /** Which limit, when one was hit. */
  limitHit: 'steps' | 'tokens' | 'runtime' | null;

  steps: AgentRunStep[];
  totalTokens: number;
  totalCostCents: number;
  durationMs: number;

  /** True when this output must be reviewed before it reaches anybody. */
  needsReview: boolean;
  reviewReason: string | null;

  error: string | null;
}

export interface AgentRunInput {
  agentId: string;
  /** What the user asked. */
  input: string;
  context: AiRequestContext;
  /** Permissions the *actor* holds. See the header. */
  actorPermissions: string[];

  /** Continues an existing conversation. A new one is started when absent. */
  conversationId?: string;
  /** Extra context: retrieved passages, a rendered prompt, structured data. */
  additionalContext?: string;
  /** Untrusted values, scanned for injection. Usually the user's own text. */
  untrustedVariables?: Record<string, string>;
  signal?: AbortSignal;
  /** Called after each step, for streaming progress to a UI. */
  onStep?: (step: AgentRunStep) => void;
}

export interface AgentRuntimeOptions {
  gateway: AiGateway;
  agents: { get(id: string): AgentDefinition; find(id: string): AgentDefinition | null };
  tools: ToolRegistry;

  policy?: AiPolicyEngine;
  memory?: MemoryService;
  conversations?: ConversationService;
  /** Renders a registry prompt, when an agent uses one. */
  prompts?: {
    render(
      key: string,
      variables: Record<string, string>,
      options: { organizationId: string | null },
    ): Promise<{ messages: Message[]; version: number }>;
  };

  audit?: Pick<AuditService, 'record'>;
  logger?: LoggerPort;
  metrics?: MetricsRecorder;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export class AgentRuntime {
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
  }

  /**
   * Runs an agent to completion or to a limit.
   *
   * Never throws for an ordinary failure — a tool that failed, a limit reached, a model that
   * refused. Those come back in the result, because a caller needs the partial work and the
   * reason. It *does* throw for a refusal to start: a missing permission, a denied policy, an
   * unknown agent.
   */
  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const runId = this.newId('run');
    const startedAt = Date.now();
    const agent = this.options.agents.get(input.agentId);

    this.assertMayRun(agent, input);

    const policy = this.options.policy?.resolve({
      organizationId: input.context.organizationId,
      agentId: agent.id,
    });

    // The tightest of the agent's own limit and the tenant policy's. A policy cannot loosen an
    // agent's declared ceiling, only tighten it — otherwise a permissive tenant policy would
    // undo a deliberate constraint on a specific agent.
    const limits = {
      maxSteps: Math.min(agent.maxSteps, policy?.maxAgentSteps ?? agent.maxSteps),
      maxTokens: agent.maxTokens,
      maxRuntimeMs: Math.min(agent.maxRuntimeMs, policy?.maxRuntimeMs ?? agent.maxRuntimeMs),
      maxOutputTokens: Math.min(
        agent.maxOutputTokens,
        policy?.maxOutputTokens ?? agent.maxOutputTokens,
      ),
    };

    this.options.metrics?.increment(AGENT_METRICS.RUNS, 1, { agent: agent.id });

    const conversationId = await this.resolveConversation(agent, input);
    const messages = await this.buildInitialMessages(agent, input, conversationId);

    const steps: AgentRunStep[] = [];
    let totalTokens = 0;
    let totalCostCents = 0;
    let output: string | null = null;
    let parsed: unknown;
    let stopReason: AgentRunResult['stopReason'] = 'limit_reached';
    let limitHit: AgentRunResult['limitHit'] = 'steps';
    let error: string | null = null;

    const deadline = startedAt + limits.maxRuntimeMs;

    try {
      for (let step = 1; step <= limits.maxSteps; step += 1) {
        if (input.signal?.aborted) {
          stopReason = 'error';
          error = 'The run was cancelled.';
          limitHit = null;
          break;
        }

        if (Date.now() > deadline) {
          limitHit = 'runtime';
          break;
        }

        if (totalTokens >= limits.maxTokens) {
          limitHit = 'tokens';
          break;
        }

        const tools = this.options.tools.definitionsFor({
          allowedTools: agent.tools,
          actorPermissions: input.actorPermissions,
        });

        const request: CompletionRequest = {
          // A copy. The loop pushes onto `messages` after this call returns, and a request object
          // whose messages change underneath it is one an adapter cannot log, cache or retry.
          messages: [...messages],
          model: {
            kind: 'requirement',
            profile: agent.routingProfile,
            capabilities: tools.length > 0 ? ['tools'] : [],
            ...(agent.allowedProviders[0] ? { preferredProvider: agent.allowedProviders[0] } : {}),
          },
          maxOutputTokens: limits.maxOutputTokens,
          ...(agent.temperature !== null ? { temperature: agent.temperature } : {}),
          ...(tools.length > 0 ? { tools } : {}),
          ...(agent.outputSchema
            ? {
                responseFormat: {
                  kind: 'json_schema' as const,
                  name: `${agent.id}_output`,
                  schema: agent.outputSchema,
                  strict: true,
                },
              }
            : {}),
        };

        const completion = await this.options.gateway.complete(
          request,
          { ...input.context, agentId: agent.id, signal: input.signal },
          {
            guardrailProfile: agent.safetyPolicy,
            // Only on the first step: the later turns are tool results the framework produced,
            // and scanning those would flag a tool that legitimately returned a document
            // containing the word "ignore".
            untrustedVariables: step === 1 ? input.untrustedVariables : undefined,
          },
        );

        totalTokens += completion.usage.totalTokens;
        totalCostCents += completion.costCents;

        const record: AgentRunStep = {
          step,
          content: completion.content,
          toolCalls: completion.toolCalls,
          toolResults: [],
          modelId: completion.modelId,
          tokens: completion.usage.totalTokens,
          costCents: completion.costCents,
          latencyMs: completion.latencyMs,
        };

        this.options.metrics?.increment(AGENT_METRICS.STEPS, 1, { agent: agent.id });

        messages.push(message.assistant(completion.content, completion.toolCalls));
        await this.recordTurn(conversationId, input, completion);

        if (completion.toolCalls.length === 0) {
          /*
           * A truncated answer is not a final answer.
           *
           * `finishReason: 'length'` means the model was cut off mid-sentence. Treating that as
           * the agent's conclusion presents half a thought as a result, and the caller has no
           * way to tell.
           */
          if (!isComplete(completion.finishReason)) {
            steps.push(record);
            input.onStep?.(record);
            limitHit = 'tokens';
            error =
              `The model's output was cut off (${completion.finishReason}). Raise the agent's ` +
              'maxOutputTokens, or ask for a shorter answer.';
            break;
          }

          output = completion.content;
          parsed = completion.parsed;
          stopReason = agent.outputSchema ? 'schema_satisfied' : 'final_answer';
          limitHit = null;

          steps.push(record);
          input.onStep?.(record);
          break;
        }

        const results = await this.options.tools.executeAll(completion.toolCalls, {
          organizationId: input.context.organizationId,
          actorId: input.context.actorId,
          agentId: agent.id,
          signal: input.signal ?? new AbortController().signal,
          // The actor's permissions, not the agent's. See the header.
          actorPermissions: input.actorPermissions,
          allowedTools: agent.tools,
        });

        record.toolResults = results;
        this.options.metrics?.increment(AGENT_METRICS.TOOL_CALLS, results.length, {
          agent: agent.id,
        });

        for (const result of results) {
          const toolMessage = toToolMessage(result);
          messages.push(toolMessage);
          await this.recordToolTurn(conversationId, input, toolMessage);
        }

        steps.push(record);
        input.onStep?.(record);

        // `tool_success`: an agent whose whole job is one action stops as soon as it lands.
        if (
          agent.stopConditions.includes('tool_success') &&
          agent.stopAfterTool &&
          results.some((result) => result.name === agent.stopAfterTool && result.ok)
        ) {
          output = completion.content;
          stopReason = 'tool_success';
          limitHit = null;
          break;
        }
      }
    } catch (caught) {
      stopReason = 'error';
      limitHit = null;
      error = caught instanceof Error ? caught.message : String(caught);

      this.options.logger?.error(
        {
          runId,
          agentId: agent.id,
          organizationId: input.context.organizationId,
          steps: steps.length,
          error,
        },
        'agent run failed',
      );
    }

    if (limitHit !== null && stopReason === 'limit_reached') {
      this.options.metrics?.increment(AGENT_METRICS.LIMIT_REACHED, 1, {
        agent: agent.id,
        limit: limitHit,
      });

      error ??= this.explainLimit(limitHit, limits, steps.length, totalTokens);
    }

    const durationMs = Date.now() - startedAt;
    const review = this.reviewDecision(agent, policy, input, output);

    this.options.metrics?.observe(AGENT_METRICS.DURATION_MS, durationMs, { agent: agent.id });
    this.options.metrics?.observe(AGENT_METRICS.COST_CENTS, totalCostCents, { agent: agent.id });

    if (review.needsReview) {
      this.options.metrics?.increment(AGENT_METRICS.REVIEW_REQUIRED, 1, { agent: agent.id });
    }

    const result: AgentRunResult = {
      runId,
      agentId: agent.id,
      conversationId,
      output,
      parsed,
      stopReason,
      limitHit,
      steps,
      totalTokens,
      totalCostCents,
      durationMs,
      needsReview: review.needsReview,
      reviewReason: review.reason,
      error,
    };

    await this.auditRun(result, input);

    return result;
  }

  /**
   * Refuses to start when the actor cannot use this agent.
   *
   * Distinct from a per-tool permission: this gates the agent as a whole. An agent that reads
   * payroll should not be startable by somebody who cannot read payroll, even if every individual
   * tool is separately checked — otherwise the run happens, costs money, and produces a
   * conversation full of permission errors.
   */
  private assertMayRun(agent: AgentDefinition, input: AgentRunInput): void {
    const missing = agent.requiredPermissions.filter(
      (permission) => !input.actorPermissions.includes(permission),
    );

    if (missing.length > 0) {
      throw ApiError.forbidden(
        `You do not have permission to run the "${agent.name}" agent. It requires: ${missing.join(', ')}.`,
        { reason: 'agent_permission_denied', agentId: agent.id, missing },
      );
    }

    if (this.options.policy) {
      // Tool permissions are checked per call as well; this catches an agent whose *whole* tool
      // set is denied before spending anything on a first model call.
      const check = this.options.policy.check({
        context: { organizationId: input.context.organizationId, agentId: agent.id },
        toolNames: agent.tools,
        knowledgeBaseIds: agent.knowledgeBases,
      });

      if (!check.allowed && agent.tools.length > 0) {
        // Counted from the decision's detail rather than its wording, so improving a message does
        // not change who can start an agent.
        const deniedTools = new Set(
          check.decisions
            .filter((decision) => decision.effect === 'deny')
            .map((decision) => decision.detail?.tool)
            .filter((tool): tool is string => typeof tool === 'string'),
        );

        if (agent.tools.every((tool) => deniedTools.has(tool))) {
          throw AiError.policyDenied(
            `The tenant policy "${check.policy.name}" denies every tool this agent needs, so a ` +
              'run would produce nothing but permission errors.',
            { agentId: agent.id },
          );
        }
      }
    }
  }

  private async resolveConversation(
    agent: AgentDefinition,
    input: AgentRunInput,
  ): Promise<string | null> {
    if (!this.options.conversations) return input.conversationId ?? null;
    if (input.conversationId) return input.conversationId;

    const conversation = await this.options.conversations.start({
      organizationId: input.context.organizationId,
      userId: input.context.actorId,
      agentId: agent.id,
    });

    return conversation.id;
  }

  /** Builds the opening messages: system prompt, memory, extra context, the user's input. */
  private async buildInitialMessages(
    agent: AgentDefinition,
    input: AgentRunInput,
    conversationId: string | null,
  ): Promise<Message[]> {
    const messages: Message[] = [];

    if (agent.systemPromptKey && this.options.prompts) {
      // A registry prompt: versioned, approved, immutable.
      const rendered = await this.options.prompts.render(
        agent.systemPromptKey,
        {},
        { organizationId: input.context.organizationId },
      );
      messages.push(...rendered.messages.filter((entry) => entry.role === 'system'));
    } else if (agent.systemPrompt) {
      messages.push(message.system(agent.systemPrompt));
    }

    if (this.options.memory && conversationId) {
      const memories = await this.options.memory.recall({
        organizationId: input.context.organizationId,
        userId: input.context.actorId,
        conversationId,
        agentId: agent.id,
      });

      const formatted = this.options.memory.format(memories);
      if (formatted) messages.push(message.system(formatted));
    }

    // Existing turns, when continuing a conversation.
    if (this.options.conversations && input.conversationId) {
      const history = await this.options.conversations.messages(
        input.conversationId,
        input.context.organizationId,
      );
      messages.push(...history.filter((entry) => entry.role !== 'system'));
    }

    if (input.additionalContext) {
      // A separate system message rather than concatenated onto the user's text, so retrieved
      // passages are not mistaken for something the user wrote.
      messages.push(message.system(input.additionalContext));
    }

    messages.push(message.user(input.input));

    await this.recordTurn(conversationId, input, null, input.input);

    return messages;
  }

  private reviewDecision(
    agent: AgentDefinition,
    policy: ReturnType<AiPolicyEngine['resolve']> | undefined,
    input: AgentRunInput,
    output: string | null,
  ): { needsReview: boolean; reason: string | null } {
    if (agent.requiresReview) {
      return {
        needsReview: true,
        reason: `The "${agent.name}" agent requires every output to be reviewed before it is used.`,
      };
    }

    if (policy?.reviewAllOutput) {
      return {
        needsReview: true,
        reason: `The "${policy.name}" policy requires every AI output to be reviewed.`,
      };
    }

    void input;
    void output;
    return { needsReview: false, reason: null };
  }

  /** Says which limit was hit and what to do, rather than reporting a bare stop. */
  private explainLimit(
    limit: 'steps' | 'tokens' | 'runtime',
    limits: { maxSteps: number; maxTokens: number; maxRuntimeMs: number },
    steps: number,
    tokens: number,
  ): string {
    switch (limit) {
      case 'steps':
        return (
          `The agent used all ${limits.maxSteps} of its steps without reaching an answer. This is ` +
          'usually a tool that keeps failing, or a task that needs breaking down — raising the ' +
          'limit rarely helps, because each step re-sends the whole conversation.'
        );
      case 'tokens':
        return (
          `The agent used ${tokens} tokens of its ${limits.maxTokens} budget across ${steps} step(s). ` +
          'Either the conversation is too long or a tool is returning too much; look at the tool ' +
          'results before raising the budget.'
        );
      case 'runtime':
        return (
          `The agent ran for its full ${Math.round(limits.maxRuntimeMs / 1000)} seconds without ` +
          'finishing. Something it called is slow — check the tool durations in the step history.'
        );
    }
  }

  private async recordTurn(
    conversationId: string | null,
    input: AgentRunInput,
    completion: CompletionResult | null,
    userInput?: string,
  ): Promise<void> {
    if (!this.options.conversations || !conversationId) return;

    await this.options.conversations.append({
      conversationId,
      organizationId: input.context.organizationId,
      message:
        userInput !== undefined
          ? message.user(userInput)
          : message.assistant(completion!.content, completion!.toolCalls),
      modelId: completion?.modelId ?? null,
      tokens: completion?.usage.totalTokens ?? 0,
      costCents: completion?.costCents ?? 0,
    });
  }

  private async recordToolTurn(
    conversationId: string | null,
    input: AgentRunInput,
    toolMessage: { role: 'tool'; content: string; toolCallId: string },
  ): Promise<void> {
    if (!this.options.conversations || !conversationId) return;

    await this.options.conversations.append({
      conversationId,
      organizationId: input.context.organizationId,
      message: toolMessage,
    });
  }

  private async auditRun(result: AgentRunResult, input: AgentRunInput): Promise<void> {
    await this.options.audit?.record({
      action: 'agent.run',
      entityType: 'AiAgentRun',
      entityId: result.runId,
      actorId: input.context.actorId,
      organizationId: input.context.organizationId,
      /*
       * Metadata and the tools that were called — not the conversation.
       *
       * Which tools ran is the part of an agent run that is an *action*, and an audit trail
       * without it cannot answer what the agent did. The text of the exchange is a conversation,
       * and the conversation store is where it lives.
       */
      after: {
        agentId: result.agentId,
        conversationId: result.conversationId,
        stopReason: result.stopReason,
        limitHit: result.limitHit,
        steps: result.steps.length,
        totalTokens: result.totalTokens,
        costCents: result.totalCostCents,
        durationMs: result.durationMs,
        needsReview: result.needsReview,
        toolsCalled: result.steps
          .flatMap((step) => step.toolResults)
          .map((toolResult) => ({ name: toolResult.name, ok: toolResult.ok })),
        error: result.error,
      },
    });
  }
}
