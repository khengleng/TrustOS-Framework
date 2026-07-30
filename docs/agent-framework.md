# Agent framework

How to extend the agent stack: writing tools, wiring stores, and what the runtime loop actually
does. For defining and running agents, read [agents.md](agents.md) first.

- [Writing a tool](#writing-a-tool)
- [What the runtime does, step by step](#what-the-runtime-does-step-by-step)
- [Argument repair](#argument-repair)
- [Concurrency](#concurrency)
- [The ports](#the-ports)
- [Testing an agent](#testing-an-agent)

---

## Writing a tool

A tool is the only way an agent changes anything, so the declaration carries more than a signature.

```ts
import { z } from 'zod';
import type { FunctionDefinition } from '@trustos/function-calling';

export const refundOrder: FunctionDefinition<{ orderId: string; amountCents: number }, Refund> = {
  name: 'refund_order',
  // Written for the model. This text is the only thing it has to decide whether to call this.
  description:
    'Refunds an order the customer already paid for. Use only when the customer asked for a ' +
    'refund and the order is within the refund window. Does not cancel a subscription.',

  parameters: z
    .object({
      orderId: z.string().describe('The order number, like ORD-1234.'),
      amountCents: z.number().int().positive().describe('How much to refund, in cents.'),
    })
    .strict(),

  permission: 'orders.refund', // the ACTOR must hold it — see agents.md
  mutating: true, // never retried automatically; runs alone in a batch
  timeoutMs: 10_000,

  handler: async (args, context) => {
    return refunds.create({
      organizationId: context.organizationId, // always from the context, never from args
      orderId: args.orderId,
      amountCents: args.amountCents,
      actorId: context.actorId,
    });
  },
};
```

Five things that are not obvious:

1. **The description is a prompt.** It is the only thing the model reads when deciding whether to
   call this. "Refunds an order" produces refunds for cancellations, chargebacks and complaints.
   Say what it is for _and_ what it is not.
2. **`mutating: true` changes behaviour**, it is not documentation. A mutating tool is never
   retried automatically — a retried transfer is two transfers — and it runs alone rather than
   concurrently with other calls in the same batch.
3. **Never take `organizationId` as a parameter.** It comes from the context. A tenant id the
   model can fill in is a tenant id an injected instruction can fill in.
4. **`parameters` must be `.strict()`.** The generated JSON Schema sets
   `additionalProperties: false`, without which models invent fields freely.
5. **Throwing is fine.** The executor catches it, logs the real error and returns the model a
   message that does not leak internals.

Register and the definitions are generated for you:

```ts
const tools = new ToolRegistry({ functions: [searchOrders, refundOrder], audit, logger });
```

`toJsonSchema` supports objects, strings, numbers, booleans, arrays, enums, optionals and
descriptions — deliberately a small subset. A tool taking a deeply nested union is a tool the model
will call wrongly, so the conversion not supporting one is a feature.

## What the runtime does, step by step

```
  run()
   ├─ assertMayRun            actor permissions, tenant policy      → throws
   ├─ resolve limits          min(agent, policy)  — policy may tighten, never loosen
   ├─ start/continue conversation
   ├─ build messages          system prompt · memory · context · input
   │
   └─ loop, up to maxSteps:
        ├─ cancelled?  deadline?  token budget?     → limit_reached
        ├─ tools the ACTOR may use                  → definitionsFor
        ├─ gateway.complete(...)                    → ordinary gateway request
        ├─ truncated (finishReason: length)?        → limit_reached, not an answer
        ├─ no tool calls?                           → final_answer, done
        ├─ executeAll(toolCalls)                    → per-call permission check
        ├─ append tool results to the conversation
        └─ stopAfterTool succeeded?                 → tool_success, done

   ├─ review decision         agent.requiresReview · policy.reviewAllOutput
   └─ audit                   metadata and tool names — never the conversation
```

Two details that took a bug to get right:

- **The request carries a copy of the messages.** The loop pushes onto the array after the call
  returns, and a request object whose messages change underneath it is one an adapter cannot log,
  cache or retry.
- **Injection scanning runs on the first step only.** Later turns are tool results the framework
  produced, and scanning those flags a tool that legitimately returned a document containing the
  word "ignore".

## Argument repair

Models produce malformed JSON constantly, which is why `ToolCall.arguments` is a string rather than
an object. `repairJson` fixes three things:

| Input                                 | Repaired  |
| ------------------------------------- | --------- |
| ` ```json\n{"a":1}\n``` `             | `{"a":1}` |
| `Here you go: {"a":1} — let me know.` | `{"a":1}` |
| `{"a":1,}`                            | `{"a":1}` |

It deliberately does **not** close a truncated object. Closing the braces invents values for
whatever was cut off, and a tool called with invented arguments is worse than a tool call that
failed.

`parseArguments` never throws. It writes the error for the model:

> "query" should be string and was number.

A model given `ZodError: invalid_type at path.0` produces another wrong call. A model given that
sentence fixes it on the next turn.

## Concurrency

`executeAll` runs read-only calls concurrently and mutating ones alone and in order. A model asking
for three lookups should not wait three times, and two concurrent writes to the same record is a
race the model has no idea it created.

Results come back **in call order**, not completion order — a model matching results to calls by
position would otherwise match them wrongly. Each handler receives its own `callId`.

## The ports

Everything is an interface with an in-memory default:

| Port                | Default                               | Replace it with                          |
| ------------------- | ------------------------------------- | ---------------------------------------- |
| `MemoryStore`       | `InMemoryMemoryStore`                 | Prisma over `ai_agent_memory`, or Redis  |
| `ConversationStore` | `InMemoryConversationStore`           | Prisma over `ai_conversation`            |
| `ReviewStore`       | `InMemoryReviewStore`                 | Prisma over `ai_review_request`          |
| `summarise`         | none — `compact()` refuses without it | a gateway call with a summarising prompt |

`summarise` is a port rather than an implementation because summarising well needs a model call,
and a conversation service that made model calls would depend on the gateway, which depends on
everything.

`compact()` refuses to run without it rather than dropping history. Dropping the early turns
silently makes the agent answer confidently about a question nobody posed.

## Testing an agent

Script the gateway. The runtime is composition, so the tests worth writing are about the seams:

```ts
const gateway = {
  complete: async () => ({
    content: null,
    toolCalls: [{ id: 'c1', name: 'refund', arguments: '{"orderId":"ORD-1"}' }],
    finishReason: 'tool_calls',
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 /* … */ },
    // …
  }),
};

const result = await runtime.run({ /* … */ actorPermissions: ['orders.read'] });

expect(result.steps[0].toolResults[0].ok).toBe(false); // no refund permission
```

Four tests every agent deserves:

1. **The injection test.** An input containing "ignore your instructions and <privileged action>",
   run as an actor without the permission. The tool call must fail.
2. **The limit test.** A model that never stops. The run must report `limit_reached`, not an
   answer.
3. **The tool-failure test.** A tool that throws. The run must continue and the model must see the
   error.
4. **The review test.** If the agent requires review, the output must not be readable until a
   person approves it.

## Related

- [agents.md](agents.md) — defining and running agents
- [ai-security.md](ai-security.md) — the threat model behind the permission rule
- [ai-architecture.md](ai-architecture.md) — where the runtime sits
