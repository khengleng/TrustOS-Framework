import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';

/**
 * Agent definitions.
 *
 * An agent is a *declaration*, not code: a role, a prompt, a set of tools it may call, models it
 * may use, limits it may not exceed. Everything an agent is permitted to do is written down and
 * checkable before it runs.
 *
 * That is the point. The alternative — an agent as a function that calls the gateway however it
 * likes — means the answer to "what can this agent do" is "read the code and hope", and the answer
 * to "what changed" is a diff nobody reviewed as a permission change. A declaration can be
 * reviewed, versioned, diffed and enforced.
 *
 * The limits are not advisory. `maxSteps`, `maxTokens` and `maxRuntimeMs` are enforced by the
 * runtime, because an agent loop with no ceiling is an unbounded bill and an unbounded wait — and
 * the failure mode is not a crash but a quiet, expensive loop that nobody notices until the
 * invoice.
 */

export const AGENT_STOP_CONDITIONS = [
  /** The model produced a final answer with no tool calls. The normal ending. */
  'final_answer',
  /** A named tool was called successfully. For an agent whose job is one action. */
  'tool_success',
  /** The output matched the declared schema. For an agent producing structured data. */
  'schema_satisfied',
  /** A step, token or time limit was reached. Not a success. */
  'limit_reached',
] as const;
export type AgentStopCondition = (typeof AGENT_STOP_CONDITIONS)[number];

export const agentDefinitionSchema = z
  .object({
    /** Stable. Referenced by policy, memory, cost attribution and the audit trail. */
    id: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z][a-z0-9-]*$/, 'An agent id is lowercase, starting with a letter.'),

    name: z.string().min(1).max(200),

    /**
     * What this agent is for, in a sentence.
     *
     * Read by people choosing an agent and by `trustos ai list-agents`. Not sent to the model —
     * that is what `systemPrompt` is for.
     */
    description: z.string().min(1).max(1000),

    /** The role, for a person scanning a list: "Security Reviewer", "Translator". */
    role: z.string().min(1).max(120),

    /**
     * The system prompt, or a prompt-registry key.
     *
     * A registry key is strongly preferred: an inline prompt is a string in a source file with no
     * version, no approval and no way to roll back. Both are supported because a small internal
     * agent should not need the whole publication workflow before it can be tried.
     */
    systemPrompt: z.string().max(100_000).nullable().default(null),
    systemPromptKey: z.string().max(120).nullable().default(null),

    /** Tools this agent may call. Denied by default — an empty list means none. */
    tools: z.array(z.string().max(120)).max(100).default([]),

    /**
     * Permissions the *actor* must hold for this agent to run at all.
     *
     * Distinct from a tool's permission: this gates the agent, those gate individual actions. An
     * agent that reads payroll should not be startable by somebody who cannot read payroll, even
     * if every individual tool is separately checked.
     */
    requiredPermissions: z.array(z.string().max(120)).max(50).default([]),

    /** Knowledge collections this agent may search. Denied by default, like tools. */
    knowledgeBases: z.array(z.string().max(120)).max(50).default([]),

    /** Registry model ids. Empty means whatever the router picks. */
    allowedModels: z.array(z.string().max(120)).max(50).default([]),
    allowedProviders: z.array(z.string().max(60)).max(20).default([]),
    /** The routing profile: `fast`, `balanced`, `deep`. */
    routingProfile: z.string().max(60).default('balanced'),

    /** JSON Schema the final answer must match, for a structured agent. */
    outputSchema: z.record(z.unknown()).nullable().default(null),

    /** The guardrail profile. Null takes the tenant policy's. */
    safetyPolicy: z.string().max(120).nullable().default(null),

    temperature: z.number().min(0).max(2).nullable().default(null),
    maxOutputTokens: z.number().int().min(1).max(200_000).default(4000),

    /**
     * Ceiling on model calls in one run.
     *
     * Ten. A tool loop that has not converged in ten steps is not going to, and each step is a
     * whole conversation re-sent — so step twelve costs more than step two by a wide margin.
     */
    maxSteps: z.number().int().min(1).max(50).default(10),

    /** Ceiling on total tokens across a run. The direct cost control. */
    maxTokens: z.number().int().min(100).max(10_000_000).default(200_000),

    /** Ceiling on wall-clock time. Stops a run waiting on a slow tool forever. */
    maxRuntimeMs: z.number().int().min(1000).max(3_600_000).default(300_000),

    stopConditions: z
      .array(z.enum(AGENT_STOP_CONDITIONS))
      .min(1)
      .default(['final_answer', 'limit_reached']),

    /** For `tool_success`: which tool ends the run. */
    stopAfterTool: z.string().max(120).nullable().default(null),

    /** Memory scopes this agent may write. See `@trustsystem/agent-memory`. */
    memoryScopes: z.array(z.string().max(40)).max(10).default(['conversation']),

    /**
     * Example exchanges, for the prompt and for evaluation.
     *
     * Both uses matter. As few-shot examples they steer behaviour; as evaluation cases they are
     * the minimum regression suite — an agent whose examples stop producing their expected output
     * has changed, whatever the diff says.
     */
    examples: z
      .array(
        z
          .object({
            input: z.string().min(1).max(10_000),
            expectedOutput: z.string().max(10_000).nullable().default(null),
            /** What this example is demonstrating, for whoever reads the definition. */
            note: z.string().max(500).default(''),
          })
          .strict(),
      )
      .max(20)
      .default([]),

    /** Every output from this agent goes to a person first. For a high-stakes agent. */
    requiresReview: z.boolean().default(false),

    version: z.string().max(40).default('1'),
    owner: z.string().max(200).default(''),
  })
  .strict()
  .superRefine((agent, ctx) => {
    if (!agent.systemPrompt && !agent.systemPromptKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['systemPrompt'],
        message:
          'An agent needs a system prompt, inline or from the registry. Without one it has no ' +
          'role and behaves as whatever the underlying model defaults to.',
      });
    }

    if (agent.systemPrompt && agent.systemPromptKey) {
      // Two sources means which one applies depends on the runtime, and a change to the wrong one
      // has no effect and no error.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['systemPromptKey'],
        message:
          'Both an inline prompt and a registry key were given. Choose one — otherwise a change ' +
          'to the wrong one silently does nothing.',
      });
    }

    if (agent.stopConditions.includes('tool_success') && !agent.stopAfterTool) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stopAfterTool'],
        message: 'The tool_success stop condition needs stopAfterTool to name the tool.',
      });
    }

    if (agent.stopAfterTool && !agent.tools.includes(agent.stopAfterTool)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stopAfterTool'],
        message: `"${agent.stopAfterTool}" is not in this agent's tool list, so it can never be called.`,
      });
    }

    if (agent.stopConditions.includes('schema_satisfied') && !agent.outputSchema) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outputSchema'],
        message: 'The schema_satisfied stop condition needs an outputSchema to satisfy.',
      });
    }

    if (!agent.stopConditions.includes('limit_reached')) {
      /*
       * `limit_reached` is not optional.
       *
       * Without it a run that hits its step ceiling has no terminating condition to report, and
       * the caller cannot distinguish "finished" from "gave up". The limits still apply — this is
       * about the run being able to say so.
       */
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stopConditions'],
        message:
          'limit_reached must be among the stop conditions. Without it a run that hits its ceiling ' +
          'cannot report why it stopped, and "finished" becomes indistinguishable from "gave up".',
      });
    }
  });

export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

export class AgentRegistry {
  private readonly agents = new Map<string, AgentDefinition>();

  constructor(definitions: unknown[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(input: unknown): AgentDefinition {
    const parsed = agentDefinitionSchema.safeParse(input);

    if (!parsed.success) {
      const id = (input as { id?: string } | null)?.id ?? '(unnamed)';
      throw ApiError.validation(
        parsed.error.issues.map((issue) => ({
          path: `${id}.${issue.path.join('.')}`,
          message: issue.message,
        })),
        `The agent "${id}" is not defined correctly.`,
      );
    }

    if (this.agents.has(parsed.data.id)) {
      throw ApiError.conflict(`An agent is already registered as "${parsed.data.id}".`, {
        reason: 'agent_conflict',
        agentId: parsed.data.id,
      });
    }

    this.agents.set(parsed.data.id, parsed.data);
    return parsed.data;
  }

  registerAll(definitions: unknown[]): this {
    for (const definition of definitions) this.register(definition);
    return this;
  }

  get(id: string): AgentDefinition {
    const agent = this.agents.get(id);

    if (!agent) {
      throw ApiError.validation(
        [
          {
            path: 'agentId',
            message: `No agent "${id}". Registered: ${this.ids().join(', ') || '(none)'}.`,
          },
        ],
        `Unknown agent "${id}".`,
      );
    }

    return agent;
  }

  find(id: string): AgentDefinition | null {
    return this.agents.get(id) ?? null;
  }

  /**
   * Checks an agent against the tools and knowledge bases that actually exist.
   *
   * Run at start-up. An agent declaring a tool nobody registered fails on its first run with a
   * message from deep inside the tool executor; caught here it is a boot-time configuration
   * error naming the agent.
   */
  validateAgainst(input: {
    availableTools: string[];
    availableKnowledgeBases?: string[];
    availableModels?: string[];
    availablePrompts?: string[];
  }): string[] {
    const problems: string[] = [];
    const tools = new Set(input.availableTools);

    for (const agent of this.agents.values()) {
      for (const tool of agent.tools) {
        if (!tools.has(tool)) {
          problems.push(
            `Agent "${agent.id}" declares the tool "${tool}", which is not registered.`,
          );
        }
      }

      if (input.availableKnowledgeBases) {
        const bases = new Set(input.availableKnowledgeBases);
        for (const base of agent.knowledgeBases) {
          if (!bases.has(base)) {
            problems.push(
              `Agent "${agent.id}" declares the knowledge base "${base}", which does not exist.`,
            );
          }
        }
      }

      if (input.availableModels) {
        const models = new Set(input.availableModels);
        for (const model of agent.allowedModels) {
          if (!models.has(model)) {
            problems.push(
              `Agent "${agent.id}" allows the model "${model}", which is not in the registry.`,
            );
          }
        }
        if (
          agent.allowedModels.length > 0 &&
          !agent.allowedModels.some((model) => models.has(model))
        ) {
          // Worse than a single missing model: the agent cannot run at all.
          problems.push(`Agent "${agent.id}" allows no model that exists, so it can never run.`);
        }
      }

      if (input.availablePrompts && agent.systemPromptKey) {
        if (!input.availablePrompts.includes(agent.systemPromptKey)) {
          problems.push(
            `Agent "${agent.id}" uses the prompt "${agent.systemPromptKey}", which is not published.`,
          );
        }
      }
    }

    return problems;
  }

  ids(): string[] {
    return [...this.agents.keys()].sort();
  }

  list(): AgentDefinition[] {
    return [...this.agents.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** For `trustos ai list-agents`. */
  describe(): Array<{
    id: string;
    name: string;
    role: string;
    tools: number;
    knowledgeBases: number;
    maxSteps: number;
    requiresReview: boolean;
    promptSource: string;
  }> {
    return this.list().map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      tools: agent.tools.length,
      knowledgeBases: agent.knowledgeBases.length,
      maxSteps: agent.maxSteps,
      requiresReview: agent.requiresReview,
      promptSource: agent.systemPromptKey ? `registry:${agent.systemPromptKey}` : 'inline',
    }));
  }

  get size(): number {
    return this.agents.size;
  }
}
