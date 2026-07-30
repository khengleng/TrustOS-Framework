# Prompt registry

A production prompt is a piece of the product's behaviour. It gets reviewed, versioned, approved
and rolled back like any other — and **a published version is never edited**.

- [Why a registry](#why-a-registry)
- [The lifecycle](#the-lifecycle)
- [Writing a prompt](#writing-a-prompt)
- [The template language](#the-template-language)
- [Trusted and untrusted variables](#trusted-and-untrusted-variables)
- [Rendering](#rendering)
- [Comparing and rolling back](#comparing-and-rolling-back)
- [Tamper detection](#tamper-detection)
- [Validating prompts in CI](#validating-prompts-in-ci)

---

## Why a registry

An inline prompt string has no version, no author, no approval and no rollback. When the support
agent starts promising refunds, the questions are: what changed, when, who approved it, and what
was it before. A `const` in a service file answers the second one, badly.

So: prompts live in a registry, versions are immutable once published, and three people are
involved before text reaches a customer.

## The lifecycle

```
  draft ──▶ in_review ──▶ approved ──▶ published ──▶ retired
    │                         │            │
    └── edit freely           │            └── immutable from here
                              └── rollback returns here
```

| Transition             | Requires                             |
| ---------------------- | ------------------------------------ |
| `draft → in_review`    | the author                           |
| `in_review → approved` | **somebody other than the author**   |
| `approved → published` | **somebody other than the approver** |
| `published → retired`  | anyone with the permission           |

Three people, not one. Self-approval turns a control into a formality, and a prompt is the one
artefact where a single person can change what the product says to every customer without touching
code.

```ts
const draft = await prompts.create({/* … */}, { actorId: 'usr_author' });
await prompts.submitForReview(draft.id, null, { actorId: 'usr_author' });
await prompts.approve(draft.id, null, { actorId: 'usr_reviewer' }); // not usr_author
await prompts.publish(draft.id, null, { actorId: 'usr_lead' }); // not usr_reviewer
```

At most one version of a key is published at a time — enforced by a partial unique index, not just
by the service. Two rows claiming to be live would make which one renders a function of row order,
and the same request would produce different prompts on different days.

## Writing a prompt

```json
{
  "promptKey": "support.system",
  "version": 3,
  "organizationId": null,
  "description": "The support agent's system prompt.",
  "owner": "Customer Support",

  "system": "You are a support agent for {{company}}.",
  "template": "Answer this using only the sources below.\n\n{{question}}\n\n{{#each sources}}[{{.}}]\n{{/each}}",

  "variables": [
    { "name": "company", "type": "string", "description": "The tenant's display name." },
    {
      "name": "question",
      "type": "string",
      "description": "The customer's question.",
      "untrusted": true
    },
    { "name": "sources", "type": "string_list", "description": "Retrieved passages." }
  ],

  "safetyPolicy": "customer-facing",
  "temperature": 0.2,
  "maxOutputTokens": 1500
}
```

`promptKey` is stable across versions — it is what an application asks for. `version` increments.
`organizationId` is null for a platform prompt and set for a tenant override.

## The template language

Deliberately tiny:

| Syntax                           | Does                         |
| -------------------------------- | ---------------------------- |
| `{{name}}`                       | substitutes a variable       |
| `{{#if name}}…{{/if}}`           | includes when truthy         |
| `{{#unless name}}…{{/unless}}`   | includes when falsy          |
| `{{#each list}}…{{.}}…{{/each}}` | repeats over a `string_list` |
| `{{> component}}`                | includes a named fragment    |

There is no expression evaluation, no function call, no property access and no arithmetic. That is
the point: **a template language is a code-execution primitive if you let it be**, and prompts are
edited by people who are not reviewing them as code.

Two properties worth knowing:

- **Sections render before variables.** A secret referenced inside a false branch is never
  evaluated, let alone substituted.
- **Substituted values are never re-scanned.** A user who types `{{admin_key}}` into a support
  ticket gets the literal text `{{admin_key}}` in the prompt, not the value. Without this rule, a
  template language is server-side template injection with extra steps.

## Trusted and untrusted variables

`untrusted: true` marks a variable that carries user input. It drives two things:

1. **Injection scanning** applies to those variables and not to the rest. A tenant's configured
   tone of voice does not need scanning; a support ticket body does.
2. **Audit redaction** — untrusted values are not written to the audit record.

`trustos ai validate-prompts` warns when a variable named like user input (`message`, `question`,
`ticket`, `comment`, `body`, `feedback`, …) is not marked untrusted. That flag is easy to forget and
nothing about the prompt looks wrong without it.

Untrusted content can also be fenced explicitly:

```ts
import { fenceUntrusted } from '@trustos/prompt-security';

const fenced = fenceUntrusted(ticket.body, 'customer message');
```

Fencing helps and does not solve the problem. See [ai-security.md](ai-security.md).

## Rendering

```ts
const rendered = await prompts.render({
  promptKey: 'support.system',
  organizationId,
  variables: { company: 'Wing', question: ticket.body, sources },
});

const result = await gateway.complete(
  {
    messages: rendered.messages,
    model: { kind: 'requirement', profile: 'fast' },
    maxOutputTokens: rendered.maxOutputTokens ?? 1500,
  },
  context,
  { guardrailProfile: rendered.safetyPolicy },
);
```

`render` resolves the tenant override when there is one and the platform prompt otherwise, checks
the content hash, applies defaults, enforces `maxLength` per variable, and reports which variables
were used and which of those were untrusted. A missing required variable is an error, not an empty
string — an empty string produces a prompt that reads fine and asks the wrong question.

## Comparing and rolling back

`compare` separates three kinds of change, because they carry different risk:

| Kind              | Example                                                  | Risk                           |
| ----------------- | -------------------------------------------------------- | ------------------------------ |
| `contractChanges` | a variable added or removed, the output schema changed   | breaks callers                 |
| `safetyChanges`   | the safety policy changed, a refusal instruction removed | changes what the model will do |
| `wordingChanged`  | everything else                                          | usually fine                   |

A wording change to a customer-facing prompt is a normal deploy. A safety change is a decision.
Presenting them as one diff makes the second look like the first.

```ts
await prompts.rollback('support.system', 2, null, { actorId: 'usr_lead' });
```

Rollback republishes a **previously approved** version. It cannot resurrect a draft, because that
would be publishing unapproved text through the door marked "undo".

## Tamper detection

Every published version carries a SHA-256 of its content fields, checked on every render. The hash
covers the content only — not status, not timestamps — so retiring a version does not read as
tampering.

This is the third layer, after the service and (in a real deployment) a database trigger. It is the
one that catches a direct `UPDATE` against the table, which the application's own credentials can
perform.

A mismatch refuses to render. A prompt that was edited in the database is a prompt nobody reviewed.

## Validating prompts in CI

```bash
trustos ai validate-prompts
```

Checks, in order of how expensive the mistake is:

1. **It parses.** A prompt that fails the schema never renders.
2. **The template syntax is valid.** An unbalanced `{{#if}}` reaches the model as literal text —
   a bug that produces a plausible answer, which is the worst kind.
3. **Every variable used is declared, and every variable declared is used.** The first fails at
   render; the second is usually a rename done in one place.
4. **Components referenced exist.**
5. **Anything that looks like user input is marked untrusted.**

Exit code 1 on an error, 0 with warnings. Run it in the build.

## Related

- [ai-security.md](ai-security.md) — prompt injection and what fencing does not do
- [guardrails.md](guardrails.md) — where `safetyPolicy` is resolved
- [agents.md](agents.md) — an agent's prompt lives here
