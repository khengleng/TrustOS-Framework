import {
  productError,
  type ApiOperation,
  type ProductDefinition,
} from '@trustos/financial-product-core';

/**
 * API product exposure.
 *
 * A composed product becomes a stable API, and the API is **derived from the definition** rather
 * than written beside it. That is the property the whole package exists for: a product whose fee
 * changed and whose OpenAPI document did not is a product whose consumers were told the wrong
 * thing, and nobody notices until a partner integrates against the document.
 *
 * The base path is built from the product's slug and the operation's own path — never from free
 * text — so two products cannot collide and no product can claim a path outside its own space. A
 * product that could declare `basePath: '/v1'` would be a product that shadows every other one,
 * and route order would decide which.
 *
 * What a consuming channel sees is deliberately narrow: an operation, a request, a response and a
 * status. It does not see blocks, transitions, rules or which provider answered. That is the
 * whole point of the layer — payKH does not need to understand the workflow, and a channel that
 * did would be a channel that breaks when the workflow changes.
 */

export interface ProductRoute {
  operationId: string;
  method: ApiOperation['method'];
  /** The full path, including the version prefix and the product slug. */
  path: string;
  permission: string;
  entryBlock: string | null;
  createsTransaction: boolean;
  requiresIdempotencyKey: boolean;
  rateLimitPerMinute: number | null;
  authentication: ProductDefinition['apiExposurePolicy']['authentication'];
  description: string;
  productId: string;
  productVersion: string;
}

/** The prefix every exposed product sits under. One place, so nothing can claim a wider space. */
export const API_PREFIX = '/v1/products';

export function productRoutes(definition: ProductDefinition): ProductRoute[] {
  const policy = definition.apiExposurePolicy;
  if (!policy.exposed) return [];

  return policy.operations.map((operation) => ({
    operationId: operation.operationId,
    method: operation.method,
    path: `${API_PREFIX}/${policy.slug}${operation.path}`,
    permission: operation.permission,
    entryBlock: operation.entryBlock ?? null,
    createsTransaction: operation.createsTransaction,
    requiresIdempotencyKey: operation.requiresIdempotencyKey,
    rateLimitPerMinute: operation.rateLimitPerMinute ?? null,
    authentication: policy.authentication,
    description: operation.description ?? '',
    productId: definition.productId,
    productVersion: definition.version,
  }));
}

/**
 * The route table across every exposed product.
 *
 * Refuses a collision rather than letting registration order decide. Two products claiming
 * `POST /v1/products/wallet/payments` is a configuration mistake with a silent symptom: one of
 * them works and the other's transactions go somewhere their owner did not expect.
 */
export class ProductRouteTable {
  private readonly routes = new Map<string, ProductRoute>();

  register(definition: ProductDefinition): ProductRoute[] {
    const added = productRoutes(definition);

    for (const route of added) {
      const key = `${route.method} ${route.path}`;
      const existing = this.routes.get(key);

      if (existing && existing.productId !== route.productId) {
        throw productError(
          'product_definition_invalid',
          `${key} is claimed by both "${existing.productId}" and "${route.productId}". Route ` +
            'order would decide whose transactions go where.',
          { productId: route.productId, expected: existing.productId, actual: route.productId },
        );
      }

      this.routes.set(key, route);
    }

    return added;
  }

  /**
   * Finds the route for a request.
   *
   * Exact segment count, with `:params` matching one segment each. No prefix matching and no
   * wildcard: a router that matched a prefix would send `/payments/../admin` somewhere, and
   * "somewhere" in a financial API is a sentence that ends badly.
   */
  match(method: string, path: string): { route: ProductRoute; params: Record<string, string> } | null {
    const requested = path.split('/').filter(Boolean);

    for (const route of this.routes.values()) {
      if (route.method !== method) continue;

      const declared = route.path.split('/').filter(Boolean);
      if (declared.length !== requested.length) continue;

      const params: Record<string, string> = {};
      let matched = true;

      for (const [index, segment] of declared.entries()) {
        const actual = requested[index] as string;

        if (segment.startsWith(':')) {
          if (actual.length === 0 || actual.includes('..')) {
            matched = false;
            break;
          }
          params[segment.slice(1)] = actual;
          continue;
        }

        if (segment !== actual) {
          matched = false;
          break;
        }
      }

      if (matched) return { route, params };
    }

    return null;
  }

  all(): ProductRoute[] {
    return [...this.routes.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  size(): number {
    return this.routes.size;
  }
}
