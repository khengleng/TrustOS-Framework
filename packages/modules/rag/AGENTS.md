# AGENTS.md — @trustsystem/module-rag

Answering from documents: chunking, embedding, a vector-store interface, hybrid search, citation checking and per-collection access control.

## Rules

1. **The implementation belongs in the framework package**, not here. This package declares and
   wires; `@trustsystem/embedding`, `@trustsystem/knowledge`, `@trustsystem/rag`, `@trustsystem/vector-store` does the work.
2. **Never bypass the gateway.** Every model call goes through `@trustsystem/ai-gateway`, which is
   where policy, guardrails, cost accounting and audit are applied.
3. **Never bypass guardrails**, and never add a flag that does. A caller who needs different
   thresholds configures a guardrail profile.
4. **Never expose secrets.** Provider credentials belong in the adapter's configuration and are
   redacted everywhere they are printed — never logged, not even truncated.
5. **Never bypass tenant isolation.** Every store call takes `organizationId` explicitly.
6. **Always audit AI actions**: every request, every tool call, every review decision.
7. **Always use the model registry and the prompt registry.** A hardcoded model name or an inline
   production prompt is a change nobody can review or roll back.
8. **Add a test for every behaviour**, including the negative one. A guarantee with no test that
   it holds is a comment.
