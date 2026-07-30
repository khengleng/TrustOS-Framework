# @trustos/module-rag

Answering from documents: chunking, embedding, a vector-store interface, hybrid search, citation checking and per-collection access control.

## What this package is

A thin module wrapper. The implementation is in `@trustos/embedding`, `@trustos/knowledge`, `@trustos/rag`, `@trustos/vector-store`; this package contributes the declarations the platform needs — permissions,
audit events and a health indicator — and the start/stop lifecycle.

## Installing

```bash
trustos add-module rag
```

That adds the dependency and the documentation. Wiring is a Nest module import in the
application's composition root:

```ts
import { RagModule } from '@trustos/module-rag/nest';

@Module({ imports: [RagModule.forRoot(binding)] })
export class AppModule {}
```

The AI tables are part of the framework schema, so there is no migration to run.

## What it does not do

See `outOfScope` in the module catalog (`trustos list-modules --verbose`). The short version:
this is a platform, not a product. It ships no business-specific agent, no chat interface and no
provider credentials.
