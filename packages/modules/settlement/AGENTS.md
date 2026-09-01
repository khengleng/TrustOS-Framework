# AGENTS.md — @trustsystem/module-settlement

Settlement batches, instructions and windows, with partial confirmation and returns. Asynchronous by construction.

## Rules

1. **The implementation belongs in the framework package**, not here. This package declares and
   wires; `@trustsystem/financial-core`, `@trustsystem/settlement` does the work.
2. **Never modify a posted journal.** A correction is a reversal or an adjustment, both of which
   post a new journal and leave the original standing.
3. **Never use floating-point arithmetic for money.** Every amount is a fixed-point decimal, and
   the one place a float appears is a display layer that never feeds a calculation.
4. **Always validate balancing.** Debits equal credits, per currency, before anything posts.
5. **Always enforce idempotency.** Every operation that moves money takes a key, and the store
   enforces it with a unique constraint rather than a check.
6. **Always audit financial actions**: every posting, every reversal, every status change, every
   limit refusal.
7. **Never bypass limits.** No "internal caller" path that skips the limit engine.
8. **Never bypass tenant isolation.** Every store call takes `organizationId` explicitly.
9. **Add a test for every behaviour**, including the negative one and the concurrent one. A
   guarantee with no test that it holds under two callers is a comment.
