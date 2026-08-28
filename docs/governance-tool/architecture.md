# Governance Tool architecture

Phase 12 is the **experience layer** for internal users: operations, support, finance, risk,
compliance, security, auditors, administrators and AI operations.

> **It is not the system of record.** TrustOS remains authoritative for authentication,
> authorization, tenancy, workflow, maker-checker, the ledger, product rules, AI governance,
> audit and security policy. This layer decides what a person _sees_; it never decides what is
> _true_.

- [The five rules](#the-five-rules)
- [Where it sits](#where-it-sits)
- [The two applications](#the-two-applications)
- [An internal application is a document](#an-internal-application-is-a-document)
- [The packages](#the-packages)
- [A request, end to end](#a-request-end-to-end)
- [What is deliberately absent](#what-is-deliberately-absent)

---

## The five rules

**1. Every sensitive action goes through a TrustOS API.** Not "should" — a mutation outside
Class B is refused, and a mutation not routed through `/internal/v1` is refused. A direct write
skips authorization, workflow, maker-checker and audit, and it looks exactly like a working
feature.

**2. There is no query.** Not a SQL box, not an expression, not a script. A data source names a
registered resource and an operation; the parameters are typed. Every low-code platform that has
gone wrong went wrong the same way: a query editor, a production connection, and a button whose
behaviour nobody could enumerate.

**3. Claims become an identity, never an authorization.** `normalizeActor` returns an empty
permission list, always. Permissions come from the server-side membership lookup and nowhere
else, and no code path reads an organization out of a token.

**4. Masking happens server-side, and a reveal is an event.** A value masked in CSS is in the
payload, the network tab and every screenshot. A reveal has a requester, a reason, an expiry and
an audit record — it is not a permission somebody holds and then has.

**5. AI proposes; it never acts.** Enforced by shape rather than by rule: an AI feature returns
text with a provenance record, and there is no return type that carries an action.

## Where it sits

```text
  Internal users     operations · support · finance · risk · compliance · security · audit
                          |
  Phase 12          GOVERNANCE TOOL            INTERNAL APP GATEWAY
                    catalog · consoles         identity · tenancy · access classes
                    resource registry          correlation · audit enrichment
                    promotion                  the only path to data
                          |                            |
                          +--------------+-------------+
                                         |
  Phases 4–11       TrustOS APIs: identity · RBAC · workflow · case · financial
                    product layer · AI gateway · audit · security policy
                                         |
                    Databases · reporting replicas · provider APIs
```

## The two applications

They are separate deployables, and the separation is the point.

|                        | Serves                                                                                       | Reaches                       |
| ---------------------- | -------------------------------------------------------------------------------------------- | ----------------------------- |
| `governance-tool`      | Descriptors: the catalog, console definitions, masking rules, export policy, promotion plans | Nothing. No traffic           |
| `internal-app-gateway` | Two routes: `data` for reads, `actions` for everything else                                  | Every read and every mutation |

The surface that lists what exists and the surface that reaches production data have different
blast radii. Running them in one process means one vulnerability reaches both, and the boot test
asserts the Governance Tool exposes no `/internal/v1` route at all.

## An internal application is a document

A console — operations, support, the Financial Product Studio — is data, not code:

```json
{
  "appId": "customer-support-console",
  "businessPurpose": "Lets a support agent answer 'what happened to my payment'.",
  "dataClassification": "restricted",
  "dataSources": [
    { "id": "customers", "resourceId": "reporting.customers", "operation": "search",
      "fields": ["customerRef", "status", "maskedPhone"], "maxRows": 200 }
  ],
  "actions": [
    { "id": "request-freeze", "resourceId": "trustos.wallet", "operation": "execute",
      "apiPath": "/internal/v1/support/wallets/:walletRef/freeze-requests",
      "requiresReason": true, "requiresApproval": true, "reversible": true }
  ],
  "pages": [ … ]
}
```

Four consequences follow, and each is a thing that is otherwise impossible:

- **What a tool can reach is reviewable** without reading its source.
- **"Which internal tools can see this data"** is a query, not an investigation.
- **Promotion moves a document**, not a deployment.
- **An action that mutates cannot exist** without naming the API it calls.

## The packages

Thirteen, in four groups.

| Group                   | Packages                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Vocabulary**          | `governance-tool-core` — the definition, the three access classes, permissions, the ten consoles                                                                                                        |
| **Identity and access** | `governance-auth-context` · `governance-resource-policy` · `governance-data-access`                                                                                                                     |
| **Sensitive data**      | `governance-pii-policy` · `governance-export-control`                                                                                                                                                   |
| **Bridges and runtime** | `governance-audit-bridge` · `governance-workflow-bridge` · `governance-ai-bridge` · `governance-environment-config` · `governance-tool-runtime` · `governance-tool-sdk` · `governance-tool-integration` |

## A request, end to end

A support agent opens a customer and clicks "request wallet freeze".

1. **The console** renders the button because `shouldRender` said so — a rendering decision, not
   an authorization.
2. **The SDK** submits the _declared action id_. It cannot construct a call the definition does
   not contain.
3. **The gateway** authenticates, resolves the tenant from the verified actor, and looks up the
   application. An unregistered app has no declared actions, so there is nothing to authorize.
4. **The runtime** finds the action, checks the Governance Tool permission, refuses a missing
   reason and a missing approval, and asks the data-access guard to plan the mutation.
5. **The guard** refuses anything that is not Class B routed through `/internal/v1`.
6. **The integration catalog** confirms the path is a real operation and names the API
   permission it needs.
7. **The deployment's forwarder** calls the TrustOS API **with the actor's own credential**.
8. **The audit bridge** records it — with the app, the environment, the reason, the correlation
   id — into the TrustOS trail. And it records the refusal if any step said no.

## What is deliberately absent

| Absent                                          | Why                                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| A query editor                                  | The failure mode of every low-code platform. There is no field it could live in   |
| A React front end                               | A rendering decision belonging to a deployment's design system                    |
| A second audit trail                            | Two trails means two answers to "what happened"                                   |
| A frontend permission check that is _the_ check | Governance Tool permissions decide what renders; the API authorizes               |
| A database client in the gateway                | It plans; a deployment's executor runs. There is no client to point at production |
| A populated resource registry                   | Registering one would ship somebody's credentials and access classes              |
| A service credential on the forwarder           | A gateway calling downstream as itself gives everybody the gateway's permissions  |

Read next: [security.md](security.md) before changing anything in the gateway or the access
classes, and [database-access-policy.md](database-access-policy.md) for the three classes in
full.
