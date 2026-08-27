import type { ProductDefinition } from '@trustos/financial-product-core';
import { API_PREFIX, productRoutes, type ProductRoute } from './routes';

/**
 * The OpenAPI document, generated from the definition.
 *
 * Generated rather than written, for the reason the package header gives: a hand-written document
 * is a second description of the same API, and the two diverge on the first field either of them
 * gains. A partner integrating against a stale document is the failure mode, and it surfaces as
 * their bug report rather than as ours.
 *
 * The document deliberately describes **less** than the product contains. No blocks, no
 * transitions, no rules, no provider — a consuming channel needs an operation, a request, a
 * response and a status, and everything beyond that is internal structure they would then depend
 * on. The header of `routes.ts` says why that matters.
 *
 * `Idempotency-Key` is a *required* header on every operation that creates a transaction, and it
 * appears in the document as required rather than as a note. A required header documented as
 * optional is a header half the integrations will not send.
 */

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  servers: Array<{ url: string; description: string }>;
  paths: Record<string, Record<string, unknown>>;
  components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
}

export function productOpenApi(
  definition: ProductDefinition,
  options: { serverUrl?: string } = {},
): OpenApiDocument {
  const routes = productRoutes(definition);
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const path = paths[route.path] ?? {};
    path[route.method.toLowerCase()] = operationObject(route);
    paths[route.path] = path;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: definition.productName,
      version: definition.version,
      description: definition.description,
    },
    servers: [
      { url: options.serverUrl ?? '/', description: 'The deployment this product is exposed from.' },
    ],
    paths,
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        api_key: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        service_account: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        ExecutionResult: {
          type: 'object',
          required: ['executionId', 'state', 'outcome'],
          properties: {
            executionId: { type: 'string' },
            state: { type: 'string' },
            outcome: { type: 'string', enum: ['success', 'refusal', 'failure', 'open'] },
            /*
             * Amounts are strings in every response, never numbers.
             *
             * A JSON number goes through a double each way, and a consumer totalling responses
             * gets a figure that disagrees with the ledger. Documenting it as a string is what
             * stops a generated client from parsing it as one.
             */
            feeMinorUnits: { type: 'string', description: 'Minor units as a string. Never a number.' },
            refusalCode: { type: 'string', nullable: true },
          },
        },
        Error: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
            requestId: { type: 'string' },
          },
        },
      },
    },
  };
}

function operationObject(route: ProductRoute): Record<string, unknown> {
  const parameters: Array<Record<string, unknown>> = [];

  for (const segment of route.path.split('/')) {
    if (!segment.startsWith(':')) continue;
    parameters.push({
      name: segment.slice(1),
      in: 'path',
      required: true,
      schema: { type: 'string' },
    });
  }

  if (route.requiresIdempotencyKey) {
    parameters.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      description:
        'Scoped to the tenant, the product and the operation. Reusing a key with a different ' +
        'payload is refused; reusing it with the same payload returns the first result.',
      schema: { type: 'string', maxLength: 200 },
    });
  }

  return {
    operationId: route.operationId,
    summary: route.description || route.operationId,
    security: route.authentication.map((scheme) => ({ [scheme]: [] })),
    parameters,
    ...(route.method === 'GET' || route.method === 'DELETE'
      ? {}
      : {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    amountMinorUnits: {
                      type: 'string',
                      description: 'Minor units as a string. Never a number.',
                    },
                    currency: { type: 'string' },
                    reference: { type: 'string' },
                    attributes: { type: 'object', additionalProperties: true },
                  },
                },
              },
            },
          },
        }),
    responses: {
      '200': {
        description: 'The execution result.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ExecutionResult' } } },
      },
      '403': {
        description: 'Refused by a control: a permission, a policy or a rule.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      '404': {
        description:
          'The product does not exist, or belongs to another tenant. The two are deliberately ' +
          'indistinguishable.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      '409': {
        description: 'A conflict: an idempotency key reused with a different payload, or a stale version.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      '429': {
        description: 'Rate limited.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
    'x-trustos-product': route.productId,
    'x-trustos-product-version': route.productVersion,
    'x-trustos-creates-transaction': route.createsTransaction,
  };
}

/** Every exposed product's document, keyed by slug. What a developer portal renders. */
export function catalogOpenApi(
  definitions: readonly ProductDefinition[],
  options: { serverUrl?: string } = {},
): Record<string, OpenApiDocument> {
  const documents: Record<string, OpenApiDocument> = {};

  for (const definition of definitions) {
    if (!definition.apiExposurePolicy.exposed) continue;
    documents[definition.apiExposurePolicy.slug] = productOpenApi(definition, options);
  }

  return documents;
}

export { API_PREFIX };
