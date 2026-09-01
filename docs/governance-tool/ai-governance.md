# AI in internal tools

Ten features. All of them summarize, explain or draft. **None of them acts.**

## Enforced by shape, not by rule

An AI feature returns `AiAssistOutput`: text, plus provenance. There is no field naming an
operation, no return type carrying an action, and no path from an output to the gateway. A model
cannot execute a financial adjustment because there is nothing to execute one _through_.

`AI_FORBIDDEN_ACTIONS` lists what it may never do — change a balance, approve a merchant, modify
a limit, post a ledger entry, execute a payment, activate a policy, change a classification,
revoke access, publish an API, execute a DR procedure, delete data, publish a product. The list
exists so a test can assert the surface and a reviewer adding a feature has the boundary in front
of them.

## Everything goes through the AI Gateway

This package holds **no provider client and imports no model SDK**.
`buildCompositionBrief`-style construction produces the request; a deployment sends it through
`@trustsystem/ai-gateway`, where policy, guardrails, cost accounting and audit are applied. A call
that went around the gateway is a call nobody can account for afterwards.

`buildGatewayRequest` runs as the **actor**, not the application. Tool permissions are validated
against the actor rather than the agent — phase 7's rule, and the one that makes a successful
prompt injection survivable.

## The input allow-list

The control that does the unexpected work.

| Feature                            | May be given                                        |
| ---------------------------------- | --------------------------------------------------- |
| `summarize_case`                   | caseRef, caseTimeline, caseComments                 |
| `explain_transaction_failure`      | transactionRef, executionSteps, refusalCode         |
| `explain_reconciliation_exception` | exceptionRef, exceptionDetail, statementLine        |
| `draft_customer_response`          | caseRef, caseSummary, templateCode                  |
| `propose_product_configuration`    | productIntent, availableBlocks, availableCurrencies |

A summarization feature becomes a data-exfiltration path when somebody widens its inputs "so it
has more context". A feature that summarizes a case gets the case; it does not get the customer's
full record because that would summarize better.

Inputs are **names and references**, never content. The gateway resolves each reference
server-side under the actor's own permissions — which is what stops a request from carrying data
the requester could not otherwise read.

## Human review

Six features require a person before the output is used — anything that reaches somebody outside
the company or influences a decision about a person:

`draft_customer_response` · `draft_investigation_notes` · `draft_management_report` ·
`recommend_next_step` · `propose_product_configuration` · `summarize_risk_case`

Review happens **before the output is used**, not before it is generated. Reviewing before
generation is reviewing a prompt, which is not the thing that goes wrong.

## Three refusals on using an output

**A blocked guardrail means the output is not used.** Not shown with a warning attached — a
warning beside text is a warning somebody reads once.

**A truncated run is not a final answer.** Presenting half a thought as a conclusion is the
failure mode of every assistant that gets this wrong.

**An unreviewed output that needs a review is not usable.**

## Audit

Provenance and counts: prompt id and version, model id and version, policy, purpose, token
counts, cost, guardrail blocks, whether review was required and who reviewed.

**Never the prompt and never the completion.** Where content lives is one deliberate place, and
an audit trail is not it — an audit record containing a case summary is a case summary in a
system with different access controls.
