import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  parseArguments,
  repairJson,
  serialiseResult,
  toJsonSchema,
  toToolDefinition,
  toToolMessage,
  type FunctionDefinition,
} from '@trustsystem/function-calling';
import { ToolRegistry } from './executor';

const searchOrders: FunctionDefinition<{ query: string; limit?: number }, unknown> = {
  name: 'search_orders',
  description: "Searches the customer's own order history by order number or date range.",
  parameters: z
    .object({
      query: z.string().describe('An order number or a date range.'),
      limit: z.number().optional().describe('How many to return.'),
    })
    .strict(),
  permission: 'orders.read',
  handler: async (args) => [{ id: 'ord_1', query: args.query }],
};

const refundOrder: FunctionDefinition<{ orderId: string; amount: number }, unknown> = {
  name: 'refund_order',
  description: 'Refunds an order.',
  parameters: z.object({ orderId: z.string(), amount: z.number() }).strict(),
  permission: 'orders.refund',
  mutating: true,
  handler: async (args) => ({ refunded: args.amount }),
};

function setup(
  functions: FunctionDefinition[] = [
    searchOrders as FunctionDefinition,
    refundOrder as FunctionDefinition,
  ],
) {
  const audit = { record: vi.fn() };
  return { audit, registry: new ToolRegistry({ functions, audit }) };
}

const context = (overrides: Record<string, unknown> = {}) => ({
  organizationId: 'org_1' as string | null,
  actorId: 'usr_1' as string | null,
  agentId: 'support-agent',
  signal: new AbortController().signal,
  actorPermissions: ['orders.read'],
  allowedTools: ['search_orders'],
  ...overrides,
});

const call = (overrides: Record<string, unknown> = {}) => ({
  id: 'call_1',
  name: 'search_orders',
  arguments: '{"query":"ORD-123"}',
  ...overrides,
});

describe('JSON Schema conversion', () => {
  it('converts an object with required and optional fields', () => {
    const schema = toJsonSchema(searchOrders.parameters);

    expect(schema).toMatchObject({
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'An order number or a date range.' },
        limit: { type: 'number' },
      },
    });
  });

  it('forbids additional properties, so the model does not invent fields', () => {
    // It will otherwise do so freely, and the invented field then fails validation for no reason
    // the model can see.
    expect(toJsonSchema(searchOrders.parameters).additionalProperties).toBe(false);
  });

  it('converts an enum to a string with allowed values', () => {
    const schema = toJsonSchema(z.object({ status: z.enum(['open', 'closed']) }));

    expect((schema.properties as Record<string, unknown>).status).toMatchObject({
      type: 'string',
      enum: ['open', 'closed'],
    });
  });

  it('converts an array of objects', () => {
    const schema = toJsonSchema(z.object({ items: z.array(z.object({ id: z.string() })) }));
    const items = (schema.properties as Record<string, { items?: unknown }>).items;

    expect(items?.items).toMatchObject({ type: 'object' });
  });

  it('treats a defaulted field as optional', () => {
    const schema = toJsonSchema(z.object({ a: z.string(), b: z.string().default('x') }));

    expect(schema.required).toEqual(['a']);
  });

  it('refuses a name a provider would reject', () => {
    try {
      toToolDefinition({ ...searchOrders, name: 'search orders!' } as FunctionDefinition);
      expect.unreachable();
    } catch (error) {
      // The detail carries the rule; `toThrow` only sees the one-line summary.
      const details = (error as { details?: Array<{ message: string }> }).details ?? [];
      expect(details[0]?.message).toMatch(/letters, digits and underscore/);
    }
  });
});

describe('argument repair', () => {
  it('strips a markdown fence, which models produce constantly', () => {
    expect(repairJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('extracts the object from surrounding prose', () => {
    expect(repairJson('Here you go: {"a":1} — let me know.')).toBe('{"a":1}');
  });

  it('drops a trailing comma', () => {
    expect(repairJson('{"a":1,}')).toBe('{"a":1}');
  });

  it('treats empty arguments as an empty object', () => {
    expect(repairJson('  ')).toBe('{}');
  });

  it('does not close a truncated object', () => {
    /*
     * Closing the braces would invent values for whatever was cut off, and a tool called with
     * invented arguments is worse than a tool call that failed.
     */
    expect(repairJson('{"a":1, "b": "unfinis')).not.toContain('}');
  });
});

describe('argument validation', () => {
  it('parses valid arguments', () => {
    const result = parseArguments(searchOrders, '{"query":"ORD-123","limit":5}');

    expect(result.ok).toBe(true);
    expect(result.args).toEqual({ query: 'ORD-123', limit: 5 });
  });

  it('writes the error for the model, naming the field and the types', () => {
    // A model given "ZodError: invalid_type" produces another wrong call.
    const result = parseArguments(searchOrders, '{"query":123}');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/"query" should be string and was number/);
  });

  it('says which field is missing', () => {
    expect(parseArguments(searchOrders, '{}').error).toMatch(
      /"query" should be string and was missing/,
    );
  });

  it('names an invented parameter', () => {
    expect(parseArguments(searchOrders, '{"query":"x","colour":"red"}').error).toMatch(
      /"colour" is not a parameter of this function/,
    );
  });

  it('tells the model to send only JSON when the text does not parse', () => {
    expect(parseArguments(searchOrders, 'I think we should search for ORD-123').error).toMatch(
      /Send only a JSON object/,
    );
  });

  it('never throws', () => {
    // A malformed call is a normal event in an agent loop.
    expect(() => parseArguments(searchOrders, '<<<garbage>>>')).not.toThrow();
  });
});

describe('result serialisation', () => {
  it('returns JSON for an object', () => {
    expect(JSON.parse(serialiseResult({ a: 1 }))).toEqual({ a: 1 });
  });

  it('announces truncation rather than silently cutting', () => {
    // Otherwise the model reasons over a partial list believing it is complete.
    const result = serialiseResult('x'.repeat(5000), 100);

    expect(result).toMatch(/Truncated: 4900 more characters/);
  });

  it('truncates an array by item, so the result stays parseable', () => {
    const items = Array.from({ length: 1000 }, (_, index) => ({
      id: index,
      name: `item ${index}`,
    }));
    const result = serialiseResult(items, 500);

    expect(() => JSON.parse(result)).not.toThrow();
    expect(JSON.parse(result)).toMatchObject({ truncated: true });
  });

  it('turns a failure into a tool message the model can read', () => {
    const message = toToolMessage({
      callId: 'c1',
      name: 'x',
      ok: false,
      content: '',
      error: 'not permitted',
      durationMs: 1,
    });

    expect(message).toEqual({ role: 'tool', content: 'Error: not permitted', toolCallId: 'c1' });
  });
});

describe('registration', () => {
  it('refuses two tools with one name', () => {
    const { registry } = setup();

    expect(() => registry.register(searchOrders as FunctionDefinition)).toThrow(
      /already registered/,
    );
  });

  it('validates the name at registration, not at the first run', () => {
    expect(() =>
      new ToolRegistry().register({ ...searchOrders, name: 'bad name' } as FunctionDefinition),
    ).toThrow();
  });
});

describe('which tools the model is offered', () => {
  it('offers only what the agent may call', () => {
    const { registry } = setup();

    const offered = registry.definitionsFor({
      allowedTools: ['search_orders'],
      actorPermissions: ['orders.read', 'orders.refund'],
    });

    expect(offered.map((tool) => tool.name)).toEqual(['search_orders']);
  });

  it('does not offer a tool the actor cannot use', () => {
    // Otherwise the model calls it, gets a permission error, and spends a turn discovering
    // something the prompt could have avoided.
    const { registry } = setup();

    const offered = registry.definitionsFor({
      allowedTools: ['search_orders', 'refund_order'],
      actorPermissions: ['orders.read'],
    });

    expect(offered.map((tool) => tool.name)).toEqual(['search_orders']);
  });
});

describe('execution', () => {
  it('runs a permitted tool and returns its result', async () => {
    const { registry } = setup();

    const result = await registry.execute(call(), context());

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content)).toEqual([{ id: 'ord_1', query: 'ORD-123' }]);
  });

  it('answers an unknown tool rather than executing anything', async () => {
    const { registry } = setup();

    const result = await registry.execute(call({ name: 'search_order' }), context());

    expect(result.ok).toBe(false);
    // Naming what exists is what lets a model correct a near-miss immediately.
    expect(result.error).toMatch(/Available: refund_order, search_orders/);
  });

  it('refuses a tool the agent may not call', async () => {
    const { registry } = setup();

    const result = await registry.execute(
      call({ name: 'refund_order', arguments: '{"orderId":"o1","amount":10}' }),
      context({ actorPermissions: ['orders.refund'] }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/agent is not permitted/);
  });

  it('refuses when the actor lacks the permission, whatever the agent is allowed', async () => {
    /*
     * The check that makes a successful prompt injection survivable: an instruction hidden in a
     * ticket telling the agent to refund fails because the support representative cannot refund.
     */
    const { registry } = setup();

    const result = await registry.execute(
      call({ name: 'refund_order', arguments: '{"orderId":"o1","amount":10}' }),
      context({
        allowedTools: ['search_orders', 'refund_order'],
        actorPermissions: ['orders.read'],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot be granted by asking/);
  });

  it('returns an argument error rather than throwing', async () => {
    const { registry } = setup();

    const result = await registry.execute(call({ arguments: '{"query":123}' }), context());

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/should be string and was number/);
  });

  it('times out a hanging tool', async () => {
    const registry = new ToolRegistry({
      functions: [
        {
          name: 'slow',
          description: 'Never returns.',
          parameters: z.object({}),
          timeoutMs: 20,
          handler: () => new Promise(() => {}),
        },
      ],
    });

    const result = await registry.execute(
      call({ name: 'slow', arguments: '{}' }),
      context({ allowedTools: ['slow'], actorPermissions: [] }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/);
  });

  it('does not leak an internal error message to the model', async () => {
    /*
     * A stack trace tells the model things about the system it should not reason about, and it
     * can end up quoted to a customer.
     */
    const registry = new ToolRegistry({
      functions: [
        {
          name: 'broken',
          description: 'Throws.',
          parameters: z.object({}),
          handler: async () => {
            throw new Error('connection to postgres://user:pw@internal-db:5432 refused');
          },
        },
      ],
    });

    const result = await registry.execute(
      call({ name: 'broken', arguments: '{}' }),
      context({ allowedTools: ['broken'], actorPermissions: [] }),
    );

    expect(result.error).not.toContain('postgres://');
    expect(result.error).toMatch(/Do not retry with the same arguments/);
  });
});

describe('auditing', () => {
  it('records the arguments, because a tool call is an action', async () => {
    // "The agent called refund_order" without saying which order is not an audit trail.
    const { registry, audit } = setup();

    await registry.execute(call(), context());

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent.tool.executed',
        after: expect.objectContaining({ tool: 'search_orders', arguments: '{"query":"ORD-123"}' }),
      }),
    );
  });

  it('records a denial as well as a success', async () => {
    const { registry, audit } = setup();

    await registry.execute(
      call({ name: 'refund_order', arguments: '{"orderId":"o1","amount":10}' }),
      context(),
    );

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent.tool.denied' }),
    );
  });

  it('records a failure', async () => {
    const registry = new ToolRegistry({
      functions: [
        {
          name: 'broken',
          description: 'x',
          parameters: z.object({}),
          handler: async () => {
            throw new Error('boom');
          },
        },
      ],
      audit: { record: vi.fn() },
    });

    const result = await registry.execute(
      call({ name: 'broken', arguments: '{}' }),
      context({ allowedTools: ['broken'], actorPermissions: [] }),
    );

    expect(result.ok).toBe(false);
  });
});

describe('running several calls', () => {
  it('runs read-only calls concurrently', async () => {
    let concurrent = 0;
    let peak = 0;

    const registry = new ToolRegistry({
      functions: [
        {
          name: 'lookup',
          description: 'x',
          parameters: z.object({ id: z.string() }),
          handler: async () => {
            concurrent += 1;
            peak = Math.max(peak, concurrent);
            await new Promise((resolve) => setTimeout(resolve, 20));
            concurrent -= 1;
            return 'ok';
          },
        },
      ],
    });

    await registry.executeAll(
      ['a', 'b', 'c'].map((id) => ({ id: `c_${id}`, name: 'lookup', arguments: `{"id":"${id}"}` })),
      context({ allowedTools: ['lookup'], actorPermissions: [] }),
    );

    // A model asking for three lookups should not wait three times.
    expect(peak).toBeGreaterThan(1);
  });

  it('runs a mutating call alone', async () => {
    // Two concurrent writes to the same record is a race the model has no idea it created.
    let concurrent = 0;
    let peak = 0;

    const track = async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrent -= 1;
      return 'ok';
    };

    const registry = new ToolRegistry({
      functions: [
        {
          name: 'write',
          description: 'x',
          parameters: z.object({}),
          mutating: true,
          handler: track,
        },
      ],
    });

    await registry.executeAll(
      [
        { id: 'c1', name: 'write', arguments: '{}' },
        { id: 'c2', name: 'write', arguments: '{}' },
      ],
      context({ allowedTools: ['write'], actorPermissions: [] }),
    );

    expect(peak).toBe(1);
  });

  it('returns results in the order the calls were made', async () => {
    // A model matching results to calls by position would otherwise match them wrongly.
    const registry = new ToolRegistry({
      functions: [
        {
          name: 'lookup',
          description: 'x',
          parameters: z.object({ id: z.string() }),
          handler: async (args) => {
            // The first call is slowest, so completion order differs from call order.
            await new Promise((resolve) => setTimeout(resolve, args.id === 'a' ? 30 : 1));
            return args.id;
          },
        },
      ],
    });

    const results = await registry.executeAll(
      ['a', 'b', 'c'].map((id) => ({ id: `c_${id}`, name: 'lookup', arguments: `{"id":"${id}"}` })),
      context({ allowedTools: ['lookup'], actorPermissions: [] }),
    );

    expect(results.map((result) => result.callId)).toEqual(['c_a', 'c_b', 'c_c']);
  });

  it('gives each handler its own call id rather than the batch leader', async () => {
    // A tool that correlates its work by callId would otherwise attribute the whole batch to the
    // first call.
    const seen: string[] = [];

    const registry = new ToolRegistry({
      functions: [
        {
          name: 'lookup',
          description: 'x',
          parameters: z.object({ id: z.string() }),
          handler: async (_args, callContext) => {
            seen.push(callContext.callId);
            return 'ok';
          },
        },
      ],
    });

    await registry.executeAll(
      ['a', 'b'].map((id) => ({ id: `c_${id}`, name: 'lookup', arguments: `{"id":"${id}"}` })),
      context({ allowedTools: ['lookup'], actorPermissions: [] }),
    );

    expect(seen.sort()).toEqual(['c_a', 'c_b']);
  });
});

describe('describe', () => {
  it('reports permissions and which tools mutate', () => {
    const { registry } = setup();

    expect(registry.describe()).toEqual([
      expect.objectContaining({
        name: 'refund_order',
        mutating: true,
        permission: 'orders.refund',
      }),
      expect.objectContaining({ name: 'search_orders', mutating: false }),
    ]);
  });
});
