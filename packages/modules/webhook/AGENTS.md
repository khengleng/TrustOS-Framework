# AGENTS.md — @trustos/module-webhook

Outbound webhooks with HMAC signatures, overlapping secret rotation, replay protection and delivery history.

## Rules

1. **The implementation belongs in the framework package**, not here. This package declares and
   wires; `@trustos/webhooks`, `@trustos/webhook-runtime` does the work. Logic added
   here is logic no other consumer of that package gets.
2. **Never widen a permission key.** Keys are permanent. Add one; never rename or repurpose.
3. **Always validate the tenant.** Every store call takes `organizationId` explicitly, and a
   method without one is a method that returns every tenant's rows.
4. **Always record an audit entry** for anything an operator does.
5. **Never log a secret**, including a signing secret, a token or a credential — not even
   truncated.
6. **Add a test for every behaviour**, including the negative one. A guarantee with no test that
   it holds is a comment.
