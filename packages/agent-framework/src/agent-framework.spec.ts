import { describe, expect, it } from 'vitest';
import { ApiError } from '@trustsystem/errors';
import { AgentRegistry, agentDefinitionSchema } from './agent';
import { EXAMPLE_AGENTS, SECURITY_REVIEWER_AGENT, SUPPORT_AGENT } from './examples';

/**
 * An agent definition is a declaration, so the tests are mostly about what the schema refuses.
 *
 * Each refusal exists because the alternative is a failure with no error: an agent with two prompt
 * sources where editing the wrong one does nothing, a stop condition naming a tool the agent
 * cannot call, a run that hits its ceiling and cannot say so.
 */

const issuesOf = (error: unknown): string =>
  ((error as { details?: Array<{ path: string; message: string }> }).details ?? [])
    .map((detail) => `${detail.path} ${detail.message}`)
    .join('\n');

const valid = (overrides: Record<string, unknown> = {}) => ({
  id: 'test-agent',
  name: 'Test Agent',
  role: 'Tester',
  description: 'An agent for tests.',
  systemPrompt: 'You are a test agent.',
  stopConditions: ['final_answer', 'limit_reached'],
  ...overrides,
});

describe('definition', () => {
  it('accepts a minimal agent and applies defaults', () => {
    const agent = agentDefinitionSchema.parse(valid());

    expect(agent).toMatchObject({
      tools: [],
      maxSteps: 10,
      requiresReview: false,
      routingProfile: 'balanced',
      // Absent, not zero: the model's own default is usually better tuned than ours.
      temperature: null,
    });
  });

  it('refuses an agent with no prompt at all', () => {
    const error = agentDefinitionSchema.safeParse(valid({ systemPrompt: undefined }));

    expect(error.success).toBe(false);
    expect(error.error!.issues[0]!.message).toMatch(/needs a system prompt/);
  });

  it('refuses an agent with both an inline prompt and a registry key', () => {
    // Two sources means a change to the wrong one silently does nothing.
    const error = agentDefinitionSchema.safeParse(valid({ systemPromptKey: 'support.system' }));

    expect(error.success).toBe(false);
    expect(error.error!.issues[0]!.message).toMatch(/Choose one/);
  });

  it('requires limit_reached among the stop conditions', () => {
    /*
     * Without it, a run that used all its steps has no condition to report, and the caller cannot
     * tell "finished" from "gave up" — which is the difference between an answer and half of one.
     */
    const error = agentDefinitionSchema.safeParse(valid({ stopConditions: ['final_answer'] }));

    expect(error.success).toBe(false);
    expect(error.error!.issues[0]!.message).toMatch(/limit_reached must be/);
  });

  it('requires stopAfterTool to name a tool the agent has', () => {
    const error = agentDefinitionSchema.safeParse(
      valid({
        tools: ['search_orders'],
        stopConditions: ['tool_success', 'limit_reached'],
        stopAfterTool: 'refund_order',
      }),
    );

    expect(error.success).toBe(false);
    expect(error.error!.issues[0]!.message).toMatch(/never be called/);
  });

  it('requires tool_success to say which tool', () => {
    const error = agentDefinitionSchema.safeParse(
      valid({ stopConditions: ['tool_success', 'limit_reached'] }),
    );

    expect(error.success).toBe(false);
    expect(error.error!.issues[0]!.message).toMatch(/needs stopAfterTool/);
  });

  it('requires schema_satisfied to have a schema', () => {
    const error = agentDefinitionSchema.safeParse(
      valid({ stopConditions: ['schema_satisfied', 'limit_reached'] }),
    );

    expect(error.success).toBe(false);
    expect(error.error!.issues[0]!.message).toMatch(/needs an outputSchema/);
  });

  it('rejects an unknown field rather than ignoring it', () => {
    // A typo in a definition file is otherwise a setting that silently does nothing.
    expect(agentDefinitionSchema.safeParse(valid({ maxStep: 3 })).success).toBe(false);
  });
});

describe('registry', () => {
  it('names the agent in a validation failure', () => {
    const registry = new AgentRegistry();

    const error = (() => {
      try {
        registry.register(valid({ id: 'broken', stopConditions: ['final_answer'] }));
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(ApiError);
    expect(issuesOf(error)).toMatch(/broken\.stopConditions/);
  });

  it('refuses a duplicate id', () => {
    const registry = new AgentRegistry([valid()]);
    expect(() => registry.register(valid())).toThrow(/already registered/);
  });

  it('lists what is registered when asked for something that is not', () => {
    const registry = new AgentRegistry([valid({ id: 'a' }), valid({ id: 'b' })]);

    expect(() => registry.get('c')).toThrow(/Unknown agent "c"/);
    expect(
      issuesOf(
        (() => {
          try {
            registry.get('c');
          } catch (e) {
            return e;
          }
        })(),
      ),
    ).toMatch(/Registered: a, b/);
  });

  it('finds without throwing', () => {
    const registry = new AgentRegistry([valid()]);

    expect(registry.find('test-agent')).toMatchObject({ id: 'test-agent' });
    expect(registry.find('nope')).toBeNull();
  });
});

describe('validateAgainst', () => {
  it('reports a tool nobody registered', () => {
    // Caught at boot as a configuration error naming the agent, rather than on the first run as a
    // message from deep inside the tool executor.
    const registry = new AgentRegistry([valid({ tools: ['search_orders', 'refund_order'] })]);

    expect(registry.validateAgainst({ availableTools: ['search_orders'] })).toEqual([
      'Agent "test-agent" declares the tool "refund_order", which is not registered.',
    ]);
  });

  it('reports a prompt that is not published', () => {
    const registry = new AgentRegistry([
      valid({ systemPrompt: undefined, systemPromptKey: 'support.system' }),
    ]);

    expect(
      registry.validateAgainst({ availableTools: [], availablePrompts: ['other.system'] }),
    ).toEqual(['Agent "test-agent" uses the prompt "support.system", which is not published.']);
  });

  it('says separately when an agent can never run at all', () => {
    // Worse than one missing model, and worth its own line: the agent is dead, not degraded.
    const registry = new AgentRegistry([valid({ allowedModels: ['gone.1', 'gone.2'] })]);

    const problems = registry.validateAgainst({
      availableTools: [],
      availableModels: ['present.1'],
    });

    expect(problems).toHaveLength(3);
    expect(problems[2]).toMatch(/can never run/);
  });

  it('is quiet when everything an agent needs exists', () => {
    const registry = new AgentRegistry([
      valid({ tools: ['search_orders'], knowledgeBases: ['support'] }),
    ]);

    expect(
      registry.validateAgainst({
        availableTools: ['search_orders'],
        availableKnowledgeBases: ['support'],
      }),
    ).toEqual([]);
  });
});

describe('example agents', () => {
  it('are all valid definitions', () => {
    // They are parsed at import, so this is really a guard against somebody loosening that.
    for (const agent of EXAMPLE_AGENTS) {
      expect(agentDefinitionSchema.safeParse(agent).success).toBe(true);
    }
  });

  it('declare no tools, so registering one cannot fail on a missing tool', () => {
    const registry = new AgentRegistry(EXAMPLE_AGENTS);

    expect(registry.validateAgainst({ availableTools: [] })).toEqual([]);
  });

  it('cover the nine roles the platform ships', () => {
    expect(new AgentRegistry(EXAMPLE_AGENTS).ids()).toEqual([
      'architect',
      'business-analyst',
      'developer',
      'documentation-writer',
      'product-owner',
      'qa',
      'security-reviewer',
      'support-agent',
      'translator',
    ]);
  });

  it('makes the security reviewer’s output reviewable', () => {
    expect(SECURITY_REVIEWER_AGENT.requiresReview).toBe(true);
  });

  it('tells the support agent to refuse rather than fill a gap', () => {
    // The only example that talks to a customer, and the only one where a confident wrong answer
    // gets acted on.
    expect(SUPPORT_AGENT.systemPrompt).toMatch(/do not fill\s+the gap/i);
    expect(SUPPORT_AGENT.systemPrompt).toMatch(/never commit the business/i);
  });
});

describe('describe', () => {
  it('reports the prompt source, for trustos ai list-agents', () => {
    const registry = new AgentRegistry([
      valid({ id: 'inline' }),
      valid({ id: 'registry', systemPrompt: undefined, systemPromptKey: 'support.system' }),
    ]);

    expect(registry.describe()).toEqual([
      expect.objectContaining({ id: 'inline', promptSource: 'inline' }),
      expect.objectContaining({ id: 'registry', promptSource: 'registry:support.system' }),
    ]);
  });
});
