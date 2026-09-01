import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';

/**
 * The SDK an internal application is built against.
 *
 * Headless, like `@trustsystem/template-sdk` and for the same reason: one deployment renders React
 * and another renders something else, and an SDK that imported a renderer would be unusable in
 * half of them.
 *
 * What it enforces is one habit, stated as a rule because it is the habit that decays: **the
 * frontend holds no business logic.** Not a fee calculation, not an eligibility check, not an
 * approval count. Everything it displays came from an API that computed it, and everything it
 * submits is submitted whole.
 *
 * The reason is not purity. A fee recomputed in a browser is a second implementation of the fee,
 * and the two disagree — and the one the customer sees is the browser's, while the one that
 * settles is the server's. That is a support ticket nobody can close.
 *
 * So the client below has `get`, `list` and `submit`, and no `compute`. Every response carries a
 * correlation id, every request carries the actor's context, and pagination is a cursor rather
 * than an offset because an offset over a moving list shows some rows twice and skips others.
 */

export interface SdkActorContext {
  actorId: string;
  organizationId: string;
  roles: readonly string[];
  /** Governance Tool permissions. Decides what renders; never the authorization. */
  permissions: readonly string[];
  authenticationLevel: string;
}

export interface RequestContext {
  actor: SdkActorContext;
  appId: string;
  correlationId: string;
  /** The environment banner every console renders. Present so it cannot be forgotten. */
  environment: 'dev' | 'uat' | 'prod';
}

/** A page of results. A cursor, never an offset. */
export interface Page<T> {
  items: T[];
  /** Opaque. A client that decoded it would be a client coupled to the store's ordering. */
  nextCursor: string | null;
  /** Fields the server masked. What the UI renders a reveal affordance beside. */
  maskedFields: string[];
  /** Fields the request asked for and did not get, with the reason. */
  droppedFields: Array<{ field: string; reason: string }>;
  correlationId: string;
}

export const pageRequestSchema = z
  .object({
    cursor: z.string().max(500).optional(),
    /**
     * How many. Bounded here as well as on the server.
     *
     * Two bounds is not redundancy: the client bound is what stops a console asking for ten
     * thousand rows and rendering them, which is a browser problem rather than a server one.
     */
    limit: z.number().int().min(1).max(200).default(50),
    filters: z.record(z.union([z.string().max(200), z.number(), z.boolean()])).default({}),
    sort: z.string().max(80).optional(),
  })
  .strict();

export type PageRequest = z.infer<typeof pageRequestSchema>;

/**
 * The transport a deployment supplies.
 *
 * The SDK never opens a connection. It builds a request, hands it to this, and interprets what
 * comes back — which is what lets the same SDK run in a browser, in a test and in a server-side
 * renderer without three implementations.
 */
export interface GatewayTransport {
  send(request: {
    method: string;
    /** Always an `/internal/v1` path. The SDK has no way to build another. */
    path: string;
    headers: Record<string, string>;
    body?: unknown;
  }): Promise<{ status: number; body: unknown; headers: Record<string, string> }>;
}

export class GovernanceClient {
  constructor(private readonly transport: GatewayTransport) {}

  private headers(
    context: RequestContext,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    return {
      'x-correlation-id': context.correlationId,
      'x-governance-app': context.appId,
      /*
       * The environment, echoed.
       *
       * Not trusted — the gateway knows which environment it is — and sent so a mismatch is
       * *detectable*. A DEV console talking to the PROD gateway is a configuration mistake that
       * otherwise works perfectly.
       */
      'x-governance-environment': context.environment,
      ...extra,
    };
  }

  /**
   * Reads a page.
   *
   * The path is built from the app's declared data source, never from a caller's string. An SDK
   * that took a path would be an SDK through which an app reaches a resource it never declared.
   */
  async list<T>(
    context: RequestContext,
    dataSourceId: string,
    request: PageRequest = pageRequestSchema.parse({}),
  ): Promise<Page<T>> {
    const parsed = pageRequestSchema.parse(request);

    const response = await this.transport.send({
      method: 'POST',
      path: `/internal/v1/apps/${encodeURIComponent(context.appId)}/data/${encodeURIComponent(dataSourceId)}`,
      headers: this.headers(context),
      body: parsed,
    });

    if (response.status >= 400) throw errorFrom(response, context.correlationId);

    const body = response.body as {
      items?: T[];
      nextCursor?: string | null;
      maskedFields?: string[];
      droppedFields?: Array<{ field: string; reason: string }>;
    };

    return {
      items: body.items ?? [],
      nextCursor: body.nextCursor ?? null,
      maskedFields: body.maskedFields ?? [],
      droppedFields: body.droppedFields ?? [],
      correlationId: response.headers['x-correlation-id'] ?? context.correlationId,
    };
  }

  /**
   * Submits a declared action.
   *
   * Named by its declared id, so the SDK cannot construct a call the definition does not contain.
   * The reason and the approval reference travel with it, because the gateway needs both to
   * enrich the audit record.
   */
  async submit<T>(
    context: RequestContext,
    actionId: string,
    input: {
      payload?: unknown;
      reason?: string;
      approvalRef?: string;
      idempotencyKey?: string;
    } = {},
  ): Promise<T> {
    const response = await this.transport.send({
      method: 'POST',
      path: `/internal/v1/apps/${encodeURIComponent(context.appId)}/actions/${encodeURIComponent(actionId)}`,
      headers: this.headers(
        context,
        input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {},
      ),
      body: {
        payload: input.payload ?? {},
        reason: input.reason ?? null,
        approvalRef: input.approvalRef ?? null,
      },
    });

    if (response.status >= 400) throw errorFrom(response, context.correlationId);
    return response.body as T;
  }

  /** Requests a reveal. Returns what was revealed and what was refused, with reasons. */
  async requestReveal(
    context: RequestContext,
    input: {
      resourceId: string;
      subjectRef: string;
      fields: string[];
      reason: string;
      caseRef?: string;
    },
  ): Promise<{
    fields: string[];
    refused: Array<{ field: string; reason: string }>;
    expiresAt: string;
  }> {
    if (input.reason.trim().length < 20) {
      /*
       * Refused client-side as well as server-side.
       *
       * Not because the client check is a control — it is not — but because a twenty-character
       * floor enforced only after a round trip trains people to type twenty characters of
       * nothing. Refused before the request, it prompts.
       */
      throw new ApiError('validation_error', {
        message: 'A reveal needs a reason of at least twenty characters.',
        details: [{ path: 'reason', message: 'Say what you are looking for and why.' }],
      });
    }

    const response = await this.transport.send({
      method: 'POST',
      path: '/internal/v1/support/reveals',
      headers: this.headers(context),
      body: input,
    });

    if (response.status >= 400) throw errorFrom(response, context.correlationId);
    return response.body as never;
  }

  /** Requests an export. Returns the decision, including everything that would block it. */
  async requestExport(
    context: RequestContext,
    input: {
      resourceId: string;
      fields: string[];
      filters: Record<string, string>;
      justification: string;
    },
  ): Promise<{
    allowed: boolean;
    requiresApproval: boolean;
    refusals: string[];
    requestId: string;
  }> {
    const response = await this.transport.send({
      method: 'POST',
      path: '/internal/v1/platform/exports',
      headers: this.headers(context),
      body: input,
    });

    if (response.status >= 400) throw errorFrom(response, context.correlationId);
    return response.body as never;
  }
}

/**
 * Whether a control should render.
 *
 * The only permission helper the SDK offers, and its name says what it is for. There is no
 * `authorize`, no `can`, no `assertPermission` — because a helper called `can` is a helper
 * somebody uses as the check, and the check is on the server.
 */
export function shouldRender(actor: SdkActorContext, permission: string): boolean {
  return actor.permissions.includes(permission);
}

/**
 * The reason a control is disabled.
 *
 * Returned so it can be shown. A disabled button with no explanation produces a support ticket;
 * one that says why teaches the rule at the moment somebody is trying to break it.
 */
export function disabledReason(
  actor: SdkActorContext,
  input: { permission: string; requiresApproval?: boolean; isRequester?: boolean },
): string | null {
  if (input.isRequester) return 'You submitted this. Somebody else decides it.';
  if (!actor.permissions.includes(input.permission)) return 'You do not have permission for this.';
  if (input.requiresApproval) return 'This needs an approval before it runs.';
  return null;
}

function errorFrom(response: { status: number; body: unknown }, correlationId: string): ApiError {
  const body = response.body as { code?: string; message?: string } | undefined;

  const code =
    response.status === 404
      ? 'not_found'
      : response.status === 409
        ? 'conflict'
        : response.status === 429
          ? 'rate_limited'
          : response.status === 401
            ? 'unauthorized'
            : response.status >= 500
              ? 'internal_error'
              : 'forbidden';

  return new ApiError(code, {
    message: body?.message ?? 'The gateway refused this request.',
    /*
     * The correlation id, on the error.
     *
     * This is what somebody quotes when they call support, and it is what turns "it did not
     * work" into a single row in the audit trail.
     */
    context: { correlationId, status: response.status },
  });
}
