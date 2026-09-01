# FINDING — the platform identified itself as DEV

|                 |                                                             |
| --------------- | ----------------------------------------------------------- |
| **Severity**    | HIGH                                                        |
| **Status**      | **FIXED** — 1 September 2026, verified in the runtime       |
| **Raised**      | 2026-08-29                                                  |
| **Environment** | Railway environment `production`, service `governance-tool` |
| **Observed on** | commit `a77b4d7` validation run                             |

## Resolution — 1 September 2026

`TRUSTOS_ENVIRONMENT=prod` is set on **all seven** production services, and the change was
verified in the running process rather than in Railway's variable list:

```
trustosEnvironment="prod" registeredResources=0 appCatalog="database"
```

**The finding understated its own scope.** It recorded the `governance-tool` service. All seven
carried `TRUSTOS_ENVIRONMENT=dev`: `governance-tool`, `trustos-api`, `internal-app-gateway`,
`sre-operations-console`, `api-developer-portal`, `enterprise-governance-admin` and
`financial-product-admin`. Fixing only the named one would have left six services lying and the
finding closed.

**One claim made while fixing this was wrong, and is corrected here.** It was asserted that
production was serving DEV's validation evidence as its own PASS, because the evidence record was
stamped `dev` and production's runtime environment also read `dev`, so the environment-isolation
check would have matched. The reasoning was right about the code on the branch and wrong about
production: production was 46 commits behind and had no evidence feature at all (TOS-019). There
was no false green. The fix was still correct; the stated reason for its urgency was not.

**Why it mattered anyway.** `TRUSTOS_ENVIRONMENT` selects the console catalog
(`consoleCatalogFor`) and gates validation evidence by environment. A production gateway reading
`dev` serves the development catalog and gates evidence as development — and once DEV and UAT were
deleted, the only surviving environment would have been the one misreporting itself.

---

## What was observed

The Railway environment named `production` carries:

```
TRUSTOS_ENVIRONMENT=dev
```

Read directly from the service's variables. It was not changed, and PROD was not
deployed, per the instruction covering this task.

## Why it matters

`TRUSTOS_ENVIRONMENT` is deliberately separate from `NODE_ENV` — a UAT or PROD gateway
runs with `NODE_ENV=production`, and conflating the two is how an environment acquires
the wrong behaviour quietly. That separation only helps if the value is right.

The variable is what the runtime uses to describe which environment it serves. Downstream
consequences of it reading `dev` in production include:

- promotion and environment-registry logic treating production as a development target
- evidence, audit and telemetry attributing production activity to DEV
- any control whose strictness varies by environment being selected on a false premise

The last is the reason this is HIGH rather than MEDIUM: a security posture chosen by
environment name is chosen wrongly.

## What is _not_ claimed

No incorrect behaviour was observed in production during this task. Production was
deliberately left untouched, so this is a configuration defect identified by inspection,
not an incident. The blast radius above is the risk, not a finding of harm.

## Remediation

Set `TRUSTOS_ENVIRONMENT=prod` on the Railway `production` environment and redeploy it
deliberately, outside this task. Before doing so, check whether anything has come to
depend on the current value.

Related: DEV correctly reports `trustosEnvironment="dev"`, and UAT correctly reports
`uat`. Production is the only one that is wrong.
