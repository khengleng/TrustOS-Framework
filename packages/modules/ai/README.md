# @trustos/module-ai

The AI gateway and everything a model call has to pass through: model registry, prompt registry, guardrails, tenant policy, routing, cost accounting and caching.

## What this package is

A thin module wrapper. The implementation is in `@trustos/ai-cache`, `@trustos/ai-gateway`, `@trustos/ai-observability`, `@trustos/ai-policy`, `@trustos/ai-sdk`, `@trustos/content-filter`, `@trustos/cost-monitor`, `@trustos/guardrails`, `@trustos/model-registry`, `@trustos/model-router`, `@trustos/prompt-registry`, `@trustos/prompt-security`, `@trustos/token-meter`; this package contributes the declarations the platform needs — permissions,
audit events and a health indicator — and the start/stop lifecycle.

## Installing

```bash
trustos add-module ai
```

That adds the dependency and the documentation. Wiring is a Nest module import in the
application's composition root:

```ts
import { AiModule } from '@trustos/module-ai/nest';

@Module({ imports: [AiModule.forRoot(binding)] })
export class AppModule {}
```

The AI tables are part of the framework schema, so there is no migration to run.

## What it does not do

See `outOfScope` in the module catalog (`trustos list-modules --verbose`). The short version:
this is a platform, not a product. It ships no business-specific agent, no chat interface and no
provider credentials.
