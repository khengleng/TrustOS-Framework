import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  FUNCTION_NAME_PATTERN,
  parseArguments,
  repairJson,
  resolveCall,
  serialiseResult,
  toJsonSchema,
  toToolDefinition,
  type FunctionDefinition,
} from './index';

/**
 * Tool calling.
 *
 * Everything here consumes model output, which means everything here consumes text that is
 * frequently *almost* valid: JSON in a code fence, a trailing comma, a name that does not exist.
 * The tests are about being tolerant of the shapes a model actually produces without becoming
 * tolerant of arguments that fail validation — the second kind of tolerance is how a tool runs
 * with the wrong parameters.
 */

const definition: FunctionDefinition<{ query: string; limit?: number }> = {
  name: 'search_invoices',
  description: 'Search invoices by text.',
  parameters: z.object({ query: z.string().min(1), limit: z.number().int().optional() }),
};

describe('definitions', () => {
  it('accepts a well-formed name and rejects one a provider would refuse', () => {
    // Providers constrain the name shape; failing here beats failing at the provider with a
    // message about a field the caller never set.
    expect(FUNCTION_NAME_PATTERN.test('search_invoices')).toBe(true);

    for (const name of ['search-invoices', '1search', 'search invoices', '']) {
      expect({ name, valid: FUNCTION_NAME_PATTERN.test(name) }).toEqual({ name, valid: false });
    }
  });

  it('refuses to build a tool definition from an invalid name', () => {
    expect(() => toToolDefinition({ ...definition, name: 'not valid' })).toThrow();
  });

  it('produces a JSON Schema a provider can consume', () => {
    const tool = toToolDefinition(definition);

    expect(tool.name).toBe('search_invoices');
    expect(tool.parameters).toMatchObject({ type: 'object' });
  });

  it('converts a zod object to a schema with its properties', () => {
    const schema = toJsonSchema(z.object({ a: z.string(), b: z.number().optional() })) as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };

    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties)).toEqual(['a', 'b']);
    // Optional fields must not be required, or every call fails validation at the provider.
    expect(schema.required ?? []).toEqual(['a']);
  });
});

describe('repairing model output', () => {
  it('unwraps a fenced code block', () => {
    // The single most common shape: the model was asked for JSON and produced a markdown block.
    expect(repairJson('```json\n{"query":"acme"}\n```')).toBe('{"query":"acme"}');
    expect(repairJson('```\n{"query":"acme"}\n```')).toBe('{"query":"acme"}');
  });

  it('leaves valid JSON alone', () => {
    expect(repairJson('{"query":"acme"}')).toBe('{"query":"acme"}');
  });

  it('trims surrounding whitespace', () => {
    expect(repairJson('  \n {"a":1} \n ')).toBe('{"a":1}');
  });

  it('does not turn invalid JSON into something that parses as different data', () => {
    /*
     * The line this must not cross. Repairing a fence is recovering the *same* value from a
     * wrapper; inventing a value from broken text would run the tool with arguments nobody sent.
     */
    const broken = '{"query": ';

    expect(() => JSON.parse(repairJson(broken))).toThrow();
  });
});

describe('parsing arguments', () => {
  it('parses and validates a well-formed call', () => {
    const result = parseArguments(definition, '{"query":"acme","limit":10}');

    expect(result.ok).toBe(true);
    expect(result.args).toEqual({ query: 'acme', limit: 10 });
  });

  it('parses arguments the model wrapped in a fence', () => {
    const result = parseArguments(definition, '```json\n{"query":"acme"}\n```');

    expect(result.ok).toBe(true);
  });

  it('fails rather than guessing when a required argument is missing', () => {
    /*
     * The failure that matters. A tool run with defaulted-in arguments does something nobody
     * asked for, and the model is told it succeeded.
     */
    const result = parseArguments(definition, '{"limit":10}');

    expect(result.ok).toBe(false);
  });

  it('fails on an argument of the wrong type', () => {
    expect(parseArguments(definition, '{"query":"acme","limit":"ten"}').ok).toBe(false);
  });

  it('fails on text that is not JSON at all', () => {
    expect(parseArguments(definition, 'I will search for acme invoices.').ok).toBe(false);
  });

  it('explains the failure in terms the model can act on', () => {
    // The error goes back to the model as a tool message. "Invalid" teaches it nothing.
    const result = parseArguments(definition, '{"limit":10}');

    expect(result.error?.length ?? 0).toBeGreaterThan(10);
  });
});

describe('serialising a result', () => {
  it('renders null for nothing', () => {
    expect(serialiseResult(undefined)).toBe('null');
    expect(serialiseResult(null)).toBe('null');
  });

  it('passes a string through unchanged when it fits', () => {
    expect(serialiseResult('done')).toBe('done');
  });

  it('truncates a long result and says how much was dropped', () => {
    /*
     * Silent truncation is the worst option: the model reasons over a partial answer believing it
     * is complete. Saying what was cut lets it narrow the query instead.
     */
    const output = serialiseResult('x'.repeat(500), 100);

    expect(output).toContain('[Truncated: 400 more characters');
    expect(output.startsWith('x'.repeat(100))).toBe(true);
  });

  it('serialises an object as JSON', () => {
    expect(JSON.parse(serialiseResult({ total: 3 }))).toEqual({ total: 3 });
  });
});

describe('resolving a call', () => {
  const definitions = new Map<string, FunctionDefinition>([
    ['search_invoices', definition as FunctionDefinition],
  ]);

  it('finds a defined function', () => {
    const resolved = resolveCall(
      { id: '1', name: 'search_invoices', arguments: '{}' },
      definitions,
    );

    expect(resolved.ok).toBe(true);
  });

  it('refuses a function that was never defined', () => {
    /*
     * A model will invent a plausible tool name. Dispatching on it would call whatever happened
     * to match; refusing and naming the real ones is what gets the next attempt right.
     */
    const resolved = resolveCall(
      { id: '1', name: 'delete_everything', arguments: '{}' },
      definitions,
    );

    expect(resolved.ok).toBe(false);
    expect(resolved.ok ? '' : resolved.error).toContain('search_invoices');
  });
});
