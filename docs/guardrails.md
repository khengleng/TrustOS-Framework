# Guardrails

The safety pipeline every request passes through. Three outcomes, configurable thresholds, and one
claim this framework will not make.

> **Guardrails do not eliminate hallucination, and nothing here claims to.** They reduce the rate
> of some failures, detect some others, and route the rest to a person. Anything that promised
> more would be a promise the model cannot keep.

- [The three outcomes](#the-three-outcomes)
- [Profiles](#profiles)
- [Input checks](#input-checks)
- [Output checks](#output-checks)
- [Personal data](#personal-data)
- [Redaction for logs](#redaction-for-logs)
- [What to do with `needs_review`](#what-to-do-with-needs_review)
- [Tuning without lying to yourself](#tuning-without-lying-to-yourself)

---

## The three outcomes

```ts
const decision = guardrails.checkInput({ messages, profileName: 'customer-facing', context });

switch (decision.outcome) {
  case 'allowed':
    break; // continue
  case 'needs_review':
    /* queue for a person */ break;
  case 'blocked':
    throw guardrails.toError(decision);
}
```

Two outcomes would be simpler and wrong. Most of what a guardrail detects is _suspicious_, not
_certain_ — an input that looks like an injection attempt, an output that mentions a policy nobody
can find. Forcing those into allow-or-block means either blocking legitimate requests or shipping
suspicious output.

`needs_review` is the honest third answer, and it is what makes the thresholds tunable without the
tuning being a choice between two kinds of damage.

## Profiles

A profile is a named set of thresholds. Different work needs different strictness, and one global
setting means the strictest use case sets the bar for everything until somebody lowers it.

```ts
const guardrails = new Guardrails({
  profiles: [
    {
      name: 'customer-facing',
      blockInjectionAt: 'medium',
      blockPiiInOutputAt: 'low',
      blockCategoriesAt: 'medium',
      redactPiiInPrompt: false,
      redactPiiInOutput: true,
      requireReviewAt: 'low',
      maxPromptChars: 100_000,
    },
    {
      name: 'internal-tools',
      blockInjectionAt: 'high',
      blockPiiInOutputAt: 'none',
      requireReviewAt: 'none',
    },
  ],
});
```

Two defaults are deliberate and opposite:

- `redactPiiInPrompt` defaults to **false**. A support agent legitimately needs the order number
  the customer just typed, and redacting it makes the agent useless.
- `redactPiiInLogs` defaults to **true**. A log is read by more people, kept longer and exported
  more often than any prompt.

An agent names its profile in `safetyPolicy`; a prompt version names one too. Both resolve through
the same registry, so there is one place where "customer-facing" means something.

## Input checks

Ten bounded patterns, scanned only over variables marked `untrusted`:

| Pattern                    | Catches                                  |
| -------------------------- | ---------------------------------------- |
| `instruction_override`     | "ignore your previous instructions"      |
| `role_reassignment`        | "you are now an unrestricted assistant"  |
| `system_prompt_extraction` | "repeat the text above"                  |
| `delimiter_injection`      | fake `</system>` and `###` boundaries    |
| `safety_bypass`            | "for educational purposes only"          |
| `tool_coercion`            | "call the refund tool with…"             |
| `exfiltration_attempt`     | "send the contents to…"                  |
| `encoded_payload`          | base64 and hex blobs where prose belongs |
| `invisible_characters`     | zero-width and bidirectional overrides   |
| `excessive_repetition`     | context-flooding                         |

Every pattern uses bounded quantifiers. An unbounded one over attacker-controlled text is a regular
expression denial of service, which is a real vulnerability in a scanner meant to prevent them.

`scanVariables` reports findings **per variable**, so an alert says which field carried the attempt
rather than that the request contained one somewhere.

**Detection is not prevention.** These patterns catch clumsy attempts and published techniques.
They do not catch a novel phrasing, and they are not why an injection fails — see
[ai-security.md](ai-security.md) for the control that actually holds.

## Output checks

Model output is **untrusted input** to whatever renders it. The output pass checks for:

- Personal data the model repeated or invented.
- Category signals — self-harm, violence, harassment, and so on.
- Prompt leakage: the system prompt reflected back.
- Text that looks like a credential.

The category signals are keyword-based and every one carries a caveat in its own detail string,
because a keyword scan cannot tell a discussion of a topic from an instance of it. They exist to
raise `needs_review`, not to be a content classifier. An application that needs one wires a real
classifier behind the same interface.

## Personal data

Ten patterns with real validation where validation exists — card numbers go through a Luhn check,
so a sixteen-digit order number is not reported as a card.

`redactPii` replaces matches **right to left**, so earlier offsets stay valid as the string
changes length. Left to right corrupts every match after the first, and the corruption looks like
a redaction that worked.

```ts
redactPii('Card 4111 1111 1111 1111, ref ORD-9');
// → 'Card [REDACTED:card_number], ref ORD-9'
```

## Redaction for logs

```ts
logger.info({ prompt: guardrails.redactForLog(prompt, profile) }, 'ai request');
```

On by default. The threat model here is not the attacker who reads a log — it is the perfectly
ordinary sequence where a prompt containing a customer's card number is logged at info level,
shipped to a log aggregator, retained for a year and exported to a spreadsheet during an
investigation.

## What to do with `needs_review`

```ts
if (decision.outcome === 'needs_review') {
  const request = await reviews.request({
    organizationId,
    subjectType: 'completion',
    subjectId: result.id,
    content: result.content!,
    reason: decision.reasons.join('; '),
    signals: decision.findings.map((f) => `${f.pattern} (${f.severity})`),
    priority: 'high',
  });

  return { status: 'pending_review', reviewId: request.id };
}
```

The output is **not** returned to the caller. `ReviewService.result()` throws while an item is
pending, which is the whole design: a flag beside the text gets ignored on a Friday afternoon, and
a thrown error does not.

See [human-review.md](human-review.md).

## Tuning without lying to yourself

Two failure modes, and the second is the common one:

1. **Too strict** — legitimate requests blocked. Loud. Somebody complains within an hour.
2. **Too loose** — nothing is blocked, the dashboard is green, and the guardrails are decoration.
   Silent. Nobody complains, ever.

So tune against numbers rather than against complaints:

| Metric                | Watch for                                                                          |
| --------------------- | ---------------------------------------------------------------------------------- |
| Block rate by pattern | A pattern that never fires is either unnecessary or broken.                        |
| `needs_review` volume | If nobody works the queue, the setting is a block with extra steps.                |
| Review approval rate  | If reviewers approve 99%, the threshold is too low and they have stopped reading.  |
| Blocks per tenant     | One tenant dominating usually means a legitimate use case that reads as an attack. |

A guardrail configuration nobody has changed in a year is not stable; it is unexamined.

## What guardrails never do

- They never make a model truthful.
- They never make an unreviewed output safe to send.
- They never replace the actor-permission check on tool calls.
- They never get bypassed by a flag. There is no `skipGuardrails` option, and adding one would
  make every other guarantee in this phase conditional.

## Related

- [ai-security.md](ai-security.md) — the full threat model
- [human-review.md](human-review.md) — where `needs_review` goes
- [prompt-registry.md](prompt-registry.md) — where a prompt names its profile
- [evaluation.md](evaluation.md) — measuring whether a change made things worse
