# SSO, roles and permissions

## The normalization

An SSO provider hands back claims. Some are facts about who signed in — a subject, a session, how
strongly they proved it. Others are **assertions about authorization**: groups, roles, an
organization. They look identical in a JWT and they are not remotely the same thing.

```ts
const { actor, unmappedGroups } = await normalizeActor({
  claims, // already verified: signature, algorithm, issuer, audience, expiry
  groupRoleMap: { 'okta-finance': 'finance', 'okta-risk': 'risk' },
  resolveOrganization: (actorId) => memberships.organizationFor(actorId),
  allowedIssuers: ['https://sso.example.test'],
});

actor.permissions; // [] — always
```

| Claim                                  | Treatment                                                               |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `sub`                                  | The actor id. Never an email — an email is reassigned, a subject is not |
| `iss`                                  | Checked against the allowed list, then recorded for audit               |
| `groups`                               | **Mapped**, with no fallback. Unmapped groups reported                  |
| `amr`/`acr`                            | Narrowed downward to password / mfa / strong                            |
| `organization`, `roles`, `permissions` | **Ignored.** No code path reads them                                    |
| anything else                          | Ignored, not rejected — a provider adds claims for its own reasons      |

## No fallback role

A `default` role for unmapped groups is the single most tempting line in the normalizer and turns
"somebody was added to a group in the directory" into "somebody has access to the finance
console".

Unmapped groups are returned so a provider that starts emitting `finance-team-v2` produces a
visible gap. Log them; they are a configuration drift signal, not an error.

## Authentication strength is guessed downward

| Provider says                                   | Level      |
| ----------------------------------------------- | ---------- |
| `hwk`, `swk`, acr contains `phishing-resistant` | `strong`   |
| `mfa`, `otp`, `sms`, `pwd_mfa`                  | `mfa`      |
| anything else, or nothing                       | `password` |

A machine actor has no authentication strength at all, and treating that as `strong` is how a
service account passes a check meant for a person with a hardware key.

## The ten internal roles

| Role             | Sees                                                               |
| ---------------- | ------------------------------------------------------------------ |
| Platform Admin   | Apps, resource registry, platform console                          |
| Product Owner    | Product Studio, approval workbench                                 |
| Operations       | Operations console, cases, export requests                         |
| Customer Support | Support console, cases, **PII reveal**                             |
| Finance          | Finance console, export requests, approvals                        |
| Risk             | Risk console, cases, **PII reveal**, approvals                     |
| Compliance       | Risk console, cases, **reveal approval**, **export approval**      |
| Security         | App approval, resource approval, platform console, export approval |
| Auditor          | Read on everything. Write on nothing                               |
| AI Operations    | AI console, AI review                                              |

Three things are worth noticing:

**Risk reveals; Compliance approves the reveal.** One role holding both is the configuration
`GOVERNANCE_SEGREGATED_PAIRS` exists to catch.

**The auditor cannot reveal.** An auditor who can unmask is an auditor whose access is
indistinguishable from an investigator's, and the distinction is why both roles exist.

**No role holds both sides of any segregated pair** — submit/approve, create/approve,
export request/approve, reveal/reveal approve, register/approve resource. A test asserts it over
the seeded roles rather than a runbook describing it.

## Two permission systems, and which is the control

|                            | Decides                           | Checked by                            |
| -------------------------- | --------------------------------- | ------------------------------------- |
| Governance Tool permission | Whether a control **renders**     | The runtime, before it plans anything |
| TrustOS API permission     | Whether the action is **allowed** | The API, every time                   |

Grant the first generously and never rely on it. If it were the only check, hiding a button would
be the control — and a button hidden in a browser is a request anybody can still make with curl.
