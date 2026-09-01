import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import type { ToolCall, ToolDefinition } from '@trustsystem/ai-sdk';

/**
 * Typed function definitions and argument parsing.
 *
 * The layer between "the model asked for `search({query: 'x'})`" and actually running something.
 * Three problems live here, and all three are ones a naive implementation gets wrong:
 *
 * **1. The arguments are a string, and frequently a malformed one.** Providers emit tool arguments
 * as JSON text that is truncated by token limits, wrapped in markdown fences, or prefixed with an
 * explanation. `parseArguments` handles the common malformations rather than failing on them,
 * because a tool call that fails to parse costs a whole extra round trip.
 *
 * **2. The model invents arguments.** It will pass a string where a number is declared, omit a
 * required field, or add a field that does not exist. Validation is not optional and the error
 * must be *returned to the model*, not thrown — a model told "amount must be a number" fixes it
 * on the next turn, while an exception ends the conversation.
 *
 * **3. A JSON Schema is what providers speak.** Zod is what the application speaks. The conversion
 * happens here, once, rather than every tool author writing both.
 */

export const FUNCTION_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

export interface FunctionDefinition<TArgs = unknown, TResult = unknown> {
  /** What the model calls it. Letters, digits and underscore — providers reject anything else. */
  name: string;

  /**
   * What it does, for the model.
   *
   * The single most important field for whether a tool gets used correctly, and the one most
   * often written as an afterthought. "Searches" is useless; "Searches the customer's own order
   * history by order number or date range. Returns at most 20 orders." tells the model when to
   * reach for it and what it gets back.
   */
  description: string;

  /** Validates and types the arguments. */
  parameters: z.ZodType<TArgs>;

  /** What running it produces. Returned to the model as JSON. */
  handler: (args: TArgs, context: FunctionCallContext) => Promise<TResult>;

  /** Permission the caller must hold. Checked before the handler runs. */
  permission?: string;

  /** Ceiling on one call. A tool with no timeout can hang an agent indefinitely. */
  timeoutMs?: number;

  /**
   * Whether the result may be cached within one agent run.
   *
   * For a read that will not change mid-conversation. Off by default, because a tool that reads
   * something the agent just wrote must not return the stale value.
   */
  cacheable?: boolean;

  /**
   * Whether this changes something.
   *
   * Drives two things: a mutating tool is never retried automatically, and a policy may require
   * approval for mutating tools specifically. A retried transfer is two transfers.
   */
  mutating?: boolean;
}

export interface FunctionCallContext {
  organizationId: string | null;
  actorId: string | null;
  /** The agent making the call, when there is one. */
  agentId?: string;
  /** The tool call id, so a result can be correlated. */
  callId: string;
  signal: AbortSignal;
}

/**
 * Converts a zod schema to the JSON Schema providers expect.
 *
 * A deliberately small subset — objects, strings, numbers, booleans, arrays, enums, optionals and
 * descriptions. That covers every tool signature that is a good idea. A tool taking a deeply
 * nested union is a tool the model will call wrongly, so the conversion not supporting one is a
 * feature rather than a gap.
 */
export function toJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  return convert(schema, 0);
}

function convert(schema: z.ZodType<unknown>, depth: number): Record<string, unknown> {
  if (depth > 10) return { type: 'object', description: 'Nesting limit reached.' };

  const definition = schema._def as {
    typeName: string;
    description?: string;
    shape?: () => Record<string, z.ZodType<unknown>>;
    type?: z.ZodType<unknown>;
    innerType?: z.ZodType<unknown>;
    values?: string[];
    options?: z.ZodType<unknown>[];
    defaultValue?: () => unknown;
  };

  const described = (result: Record<string, unknown>): Record<string, unknown> =>
    definition.description ? { ...result, description: definition.description } : result;

  switch (definition.typeName) {
    case 'ZodString':
      return described({ type: 'string' });
    case 'ZodNumber':
      return described({ type: 'number' });
    case 'ZodBoolean':
      return described({ type: 'boolean' });
    case 'ZodEnum':
      return described({ type: 'string', enum: definition.values ?? [] });
    case 'ZodArray':
      return described({
        type: 'array',
        items: definition.type ? convert(definition.type, depth + 1) : {},
      });
    case 'ZodOptional':
    case 'ZodNullable':
      // Optionality is expressed by absence from `required`, not by a wrapper type — which is how
      // JSON Schema does it and what providers understand.
      return definition.innerType ? convert(definition.innerType, depth + 1) : {};
    case 'ZodDefault':
      return definition.innerType ? convert(definition.innerType, depth + 1) : {};
    case 'ZodObject': {
      const shape = definition.shape?.() ?? {};
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape)) {
        properties[key] = convert(value, depth + 1);
        if (!isOptional(value)) required.push(key);
      }

      return described({
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        // Providers honour this and it stops the model inventing fields, which it will otherwise
        // do freely — and an invented field then fails strict validation for no reason the model
        // can see.
        additionalProperties: false,
      });
    }
    case 'ZodUnion': {
      const options = definition.options ?? [];
      return described({ anyOf: options.map((option) => convert(option, depth + 1)) });
    }
    case 'ZodLiteral':
      return described({ const: (definition as { value?: unknown }).value });
    default:
      // An unsupported type becomes a permissive schema rather than throwing: a tool with one
      // exotic parameter should still be callable, even if the model gets less guidance on it.
      return described({});
  }
}

function isOptional(schema: z.ZodType<unknown>): boolean {
  const typeName = (schema._def as { typeName: string }).typeName;
  return typeName === 'ZodOptional' || typeName === 'ZodDefault';
}

/** The provider-neutral tool definition, from a function definition. */
export function toToolDefinition(definition: FunctionDefinition): ToolDefinition {
  if (!FUNCTION_NAME_PATTERN.test(definition.name)) {
    throw ApiError.validation(
      [
        {
          path: 'name',
          message:
            `"${definition.name}" is not a usable function name. Providers accept letters, ` +
            'digits and underscore, starting with a letter, up to 64 characters.',
        },
      ],
      'Invalid function name.',
    );
  }

  return {
    name: definition.name,
    description: definition.description,
    parameters: toJsonSchema(definition.parameters),
  };
}

export interface ParsedArguments<TArgs> {
  ok: boolean;
  args?: TArgs;
  /**
   * The message to send back to the model.
   *
   * Phrased for a model to act on, not for a log: "amount must be a number, and 'forty' was
   * given" produces a corrected call, while "ZodError: invalid_type" produces another wrong one.
   */
  error?: string;
}

/**
 * Parses and validates tool-call arguments.
 *
 * Never throws. A malformed call is a normal event in an agent loop — the model gets the error and
 * tries again — and an exception here would end a conversation that was one turn from working.
 */
export function parseArguments<TArgs>(
  definition: FunctionDefinition<TArgs>,
  rawArguments: string,
): ParsedArguments<TArgs> {
  const cleaned = repairJson(rawArguments);

  let parsed: unknown;

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      ok: false,
      error:
        `The arguments for "${definition.name}" were not valid JSON. Send only a JSON object, ` +
        'with no explanation around it and no markdown fences.',
    };
  }

  const result = definition.parameters.safeParse(parsed);

  if (result.success) return { ok: true, args: result.data };

  /*
   * The error is written for the model.
   *
   * Each issue names the field, what was expected and what arrived. A model given that fixes the
   * call on the next turn; a model given "ZodError: invalid_type at path [0].amount" does not.
   */
  const issues = result.error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.join('.') || '(root)';

    if (issue.code === 'invalid_type') {
      return `"${path}" should be ${issue.expected} and ${issue.received === 'undefined' ? 'was missing' : `was ${issue.received}`}.`;
    }
    if (issue.code === 'unrecognized_keys') {
      return `"${(issue as { keys?: string[] }).keys?.join(', ')}" ${
        ((issue as { keys?: string[] }).keys?.length ?? 0) > 1 ? 'are' : 'is'
      } not a parameter of this function.`;
    }
    if (issue.code === 'invalid_enum_value') {
      return `"${path}" must be one of: ${(issue as { options?: unknown[] }).options?.join(', ')}.`;
    }

    return `"${path}": ${issue.message}`;
  });

  return {
    ok: false,
    error: `The arguments for "${definition.name}" are not valid. ${issues.join(' ')}`,
  };
}

/**
 * Repairs the malformations providers actually produce.
 *
 * Not a general JSON repair — that would silently accept genuinely broken output and produce
 * arguments nobody sent. These three are specific, common, and unambiguous:
 *
 *   * A markdown fence around the object. Models do this constantly.
 *   * Explanatory prose before or after the object.
 *   * A trailing comma, which a model copying an example produces.
 *
 * A truncated object is *not* repaired: closing the braces would invent values for whatever was
 * cut off, and a tool called with invented arguments is worse than a tool call that failed.
 */
export function repairJson(raw: string): string {
  let text = raw.trim();

  // ```json ... ```
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();

  // Prose around the object: take the outermost braces.
  if (!text.startsWith('{') && text.includes('{')) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (end > start) text = text.slice(start, end + 1);
  }

  // A trailing comma before a closing brace or bracket.
  text = text.replace(/,(\s*[}\]])/g, '$1');

  // An empty string means no arguments, which is what a zero-parameter tool call looks like.
  if (text === '') return '{}';

  return text;
}

export interface FunctionResult {
  callId: string;
  name: string;
  ok: boolean;
  /** Serialised for the model. */
  content: string;
  /** The raw value, for the caller. */
  value?: unknown;
  error?: string;
  durationMs: number;
}

/**
 * Serialises a tool result for the model.
 *
 * Bounded, because a tool returning ten thousand rows puts ten thousand rows into the next
 * prompt — and the model then has less room for the conversation than for one tool's output.
 * Truncation is *announced* in the text, so the model knows it is seeing a prefix rather than
 * silently reasoning over a partial list.
 */
export function serialiseResult(value: unknown, maxChars = 20_000): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'string') {
    return value.length > maxChars
      ? `${value.slice(0, maxChars)}\n\n[Truncated: ${value.length - maxChars} more characters. Narrow the query to see the rest.]`
      : value;
  }

  const json = JSON.stringify(value, null, 2);

  if (json.length <= maxChars) return json;

  if (Array.isArray(value)) {
    // For an array, truncating by item keeps the result parseable rather than cutting mid-object.
    const kept: unknown[] = [];
    let size = 0;

    for (const item of value) {
      const itemJson = JSON.stringify(item);
      if (size + itemJson.length > maxChars) break;
      kept.push(item);
      size += itemJson.length;
    }

    return JSON.stringify(
      {
        items: kept,
        truncated: true,
        note: `Showing ${kept.length} of ${value.length}. Narrow the query to see the rest.`,
      },
      null,
      2,
    );
  }

  return `${json.slice(0, maxChars)}\n\n[Truncated. The result was too large to include in full.]`;
}

/** Builds a tool message from a result, for the next turn. */
export function toToolMessage(result: FunctionResult): {
  role: 'tool';
  content: string;
  toolCallId: string;
} {
  return {
    role: 'tool',
    // A failure is returned as content, not thrown. The model reads it and corrects, which is the
    // entire point of a tool loop.
    content: result.ok ? result.content : `Error: ${result.error}`,
    toolCallId: result.callId,
  };
}

/** Whether a call names a function that exists, with a message the model can act on. */
export function resolveCall(
  call: ToolCall,
  definitions: Map<string, FunctionDefinition>,
): { ok: true; definition: FunctionDefinition } | { ok: false; error: string } {
  const definition = definitions.get(call.name);

  if (definition) return { ok: true, definition };

  const available = [...definitions.keys()].sort();

  return {
    ok: false,
    // Names what does exist: a model that called `search_order` when the tool is `search_orders`
    // corrects immediately given the list, and guesses again without it.
    error: `There is no function called "${call.name}". Available: ${available.join(', ') || '(none)'}.`,
  };
}
