# FINDING — PROD identifies itself as DEV

|                 |                                                             |
| --------------- | ----------------------------------------------------------- |
| **Severity**    | HIGH                                                        |
| **Status**      | OPEN — not remediated in this task, by instruction          |
| **Raised**      | 2026-08-29                                                  |
| **Environment** | Railway environment `production`, service `governance-tool` |
| **Observed on** | commit `a77b4d7` validation run                             |

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
