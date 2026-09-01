# @trustsystem/module-agent

Agents that take actions: declarative agent definitions, the tool loop with per-actor permission checks, memory, conversation state, stop conditions and human review.

## What this package is

A thin module wrapper. The implementation is in `@trustsystem/agent-framework`, `@trustsystem/agent-memory`, `@trustsystem/agent-runtime`, `@trustsystem/conversation`, `@trustsystem/function-calling`, `@trustsystem/human-review`, `@trustsystem/tool-execution`; this package contributes the declarations the platform needs — permissions,
audit events and a health indicator — and the start/stop lifecycle.

## Installing

```bash
trustos add-module agent
```

That adds the dependency and the documentation. Wiring is a Nest module import in the
application's composition root:

```ts
import { AgentModule } from '@trustsystem/module-agent/nest';

@Module({ imports: [AgentModule.forRoot(binding)] })
export class AppModule {}
```

The AI tables are part of the framework schema, so there is no migration to run.

## What it does not do

See `outOfScope` in the module catalog (`trustos list-modules --verbose`). The short version:
this is a platform, not a product. It ships no business-specific agent, no chat interface and no
provider credentials.
