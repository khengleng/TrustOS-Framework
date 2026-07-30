import { z } from 'zod';

/**
 * The message vocabulary.
 *
 * Every provider has its own message shape, and they disagree about almost everything: what a
 * system message is, whether tool results are messages or a separate channel, how content parts
 * are structured. This is the framework's shape, and adapters translate.
 *
 * The translation direction matters. Applications speak *this* vocabulary and never a provider's,
 * because the moment an application constructs an OpenAI message object it has chosen OpenAI —
 * and the choice is invisible until somebody tries to change it.
 *
 * Deliberately absent: images, audio, video. Phase 7 is text and tool calls. A multimodal content
 * part would be a shape every adapter has to handle and no adapter can handle uniformly, and the
 * constraints for this phase exclude image, voice and video work.
 */

export const MESSAGE_ROLES = ['system', 'user', 'assistant', 'tool'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/**
 * A request from the model to call a tool.
 *
 * `arguments` is a **string**, not an object, and that is not laziness. Providers emit tool
 * arguments as a JSON string that is frequently malformed — truncated by a token limit, or
 * containing a trailing comma. Parsing it here would mean the message type could not represent
 * what the provider actually sent, so the raw string is carried and parsed at the point where a
 * parse failure can be reported usefully. See `function-calling`.
 */
export const toolCallSchema = z
  .object({
    /** Provider-assigned. Correlates the call with its result. */
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(120),
    arguments: z.string().max(100_000),
  })
  .strict();

export type ToolCall = z.infer<typeof toolCallSchema>;

export const messageSchema = z
  .object({
    role: z.enum(MESSAGE_ROLES),

    /**
     * The text. Null only for an assistant message that is purely a tool call.
     *
     * Nullable rather than optional so the distinction is explicit: an assistant turn with no
     * content and no tool calls is a bug, and the type should let a check see it.
     */
    content: z.string().max(1_000_000).nullable(),

    /** Present on an assistant message that asked for tools. */
    toolCalls: z.array(toolCallSchema).max(50).optional(),

    /** Present on a `tool` message. Correlates with the call it answers. */
    toolCallId: z.string().max(200).optional(),

    /**
     * A label for a participant, where the provider supports one.
     *
     * Rarely useful and widely inconsistent. Carried because dropping information an application
     * supplied is worse than passing it to an adapter that ignores it.
     */
    name: z.string().max(120).optional(),
  })
  .strict()
  .superRefine((message, ctx) => {
    if (message.role === 'tool' && !message.toolCallId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolCallId'],
        message:
          'A tool message must name the call it answers. Without it the model cannot match the ' +
          'result to the request, and most providers reject the conversation outright.',
      });
    }

    if (message.role !== 'assistant' && message.toolCalls) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolCalls'],
        message: 'Only an assistant message can request tool calls.',
      });
    }

    if (message.content === null && !message.toolCalls?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content'],
        message:
          'A message with no content and no tool calls carries nothing. This is almost always a ' +
          'builder that forgot to set the text.',
      });
    }
  });

export type Message = z.infer<typeof messageSchema>;

/** Convenience constructors. Cheap, and they stop `role: 'sytem'` reaching a provider. */
export const message = {
  system: (content: string): Message => ({ role: 'system', content }),
  user: (content: string, name?: string): Message => ({
    role: 'user',
    content,
    ...(name ? { name } : {}),
  }),
  assistant: (content: string | null, toolCalls?: ToolCall[]): Message => ({
    role: 'assistant',
    content,
    ...(toolCalls?.length ? { toolCalls } : {}),
  }),
  tool: (toolCallId: string, content: string): Message => ({
    role: 'tool',
    content,
    toolCallId,
  }),
};

/**
 * Why generation stopped.
 *
 * Normalised across providers, because every one names these differently and a caller that had
 * to know which provider it was talking to in order to check for truncation is a caller that has
 * a provider dependency.
 *
 *   * `stop`          — the model finished.
 *   * `length`        — it hit the output limit. **The output is truncated.** A caller parsing
 *                        JSON from a `length` finish is parsing half a document.
 *   * `tool_calls`    — it wants tools run.
 *   * `content_filter`— the provider refused. Not the same as our guardrails refusing.
 *   * `cancelled`     — the caller aborted.
 *   * `error`         — the provider failed mid-stream.
 */
export const FINISH_REASONS = [
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'cancelled',
  'error',
] as const;
export type FinishReason = (typeof FINISH_REASONS)[number];

/**
 * Whether the output can be trusted to be complete.
 *
 * The single most useful derived fact about a completion, and the one most often skipped: a
 * truncated JSON response parses as invalid and gets reported as "the model produced bad JSON",
 * which sends somebody to fix a prompt when the fix is a larger `maxOutputTokens`.
 */
export function isComplete(reason: FinishReason): boolean {
  return reason === 'stop' || reason === 'tool_calls';
}

/** Human-readable, for an error message or a log line. */
export const FINISH_REASON_DETAIL: Record<FinishReason, string> = {
  stop: 'The model finished normally.',
  length:
    'The output hit the token limit and is truncated. Raise maxOutputTokens, or ask for less.',
  tool_calls: 'The model asked for one or more tools to be run.',
  content_filter: "The provider's own safety filter refused. This is not a TrustOS guardrail.",
  cancelled: 'The caller cancelled the request.',
  error: 'The provider failed part-way through.',
};
