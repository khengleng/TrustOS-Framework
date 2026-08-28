import { ApiError } from '@trustos/errors';
import type { OrganizationId } from '@trustos/shared-types';
import { tenantData, tenantWhere } from './tenant-scope';

/**
 * Wraps a Prisma model delegate so that *every* call is organization-scoped.
 *
 * The framework's position is that "remember to add `organizationId` to the
 * where clause" is not a control — it is a habit, and habits lapse under
 * deadline. This proxy makes the scope structural: a scoped delegate has no
 * method that can read or write outside the active organization.
 *
 *   const widgets = scopedDelegate(prisma.widget);
 *   await widgets.findMany();                    // WHERE "organizationId" = ctx
 *   await widgets.findUnique({ where: { id } }); // rewritten to findFirst + scope
 *
 * Two rewrites deserve attention:
 *
 *   * `findUnique` becomes `findFirst`. A primary-key lookup cannot express a
 *     second condition, so an unscoped `findUnique` would happily return
 *     another organization's row. `findFirst` can carry the scope, and the id
 *     is still unique, so the result is identical for legitimate calls.
 *
 *   * Unknown methods throw. Failing closed on an unrecognized method means a
 *     future Prisma release cannot quietly add an unscoped read path.
 */

type AnyArgs = Record<string, unknown> | undefined;
type DelegateMethod = (args?: AnyArgs) => unknown;

/** Methods whose `where` clause is scoped and otherwise passed through. */
const WHERE_SCOPED = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
]);

/** Methods rewritten to a `findFirst` variant so the scope can be applied. */
const UNIQUE_REWRITES: Record<string, string> = {
  findUnique: 'findFirst',
  findUniqueOrThrow: 'findFirstOrThrow',
};

/** Methods whose `data` payload is stamped with the organization. */
const DATA_SCOPED = new Set(['create', 'createMany']);

export interface ScopedDelegateOptions {
  /** Overrides the ambient tenant context. Reserved for background jobs. */
  organizationId?: OrganizationId;
  /** Model name used in error context. Purely diagnostic. */
  model?: string;
}

export function scopedDelegate<TDelegate extends object>(
  delegate: TDelegate,
  options: ScopedDelegateOptions = {},
): TDelegate {
  const scopeOf = () => options.organizationId;

  return new Proxy(delegate, {
    get(target, property, receiver) {
      const original = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || typeof original !== 'function') return original;

      const call = original.bind(target) as DelegateMethod;

      if (UNIQUE_REWRITES[property]) {
        const replacement = Reflect.get(target, UNIQUE_REWRITES[property], receiver) as
          DelegateMethod | undefined;
        const boundReplacement =
          typeof replacement === 'function' ? (replacement.bind(target) as DelegateMethod) : null;

        return (args?: AnyArgs) =>
          asPromise(() => {
            if (!boundReplacement) {
              throw ApiError.internal(`Delegate lacks ${UNIQUE_REWRITES[property]}.`);
            }
            return boundReplacement({
              ...(args ?? {}),
              where: tenantWhere((args?.where as Record<string, unknown>) ?? {}, scopeOf()),
            });
          });
      }

      if (WHERE_SCOPED.has(property)) {
        return (args?: AnyArgs) =>
          asPromise(() =>
            call({
              ...(args ?? {}),
              where: tenantWhere((args?.where as Record<string, unknown>) ?? {}, scopeOf()),
            }),
          );
      }

      if (DATA_SCOPED.has(property)) {
        return (args?: AnyArgs) =>
          asPromise(() => call({ ...(args ?? {}), data: scopeData(args?.data, scopeOf()) }));
      }

      if (property === 'upsert') {
        return (args?: AnyArgs) =>
          asPromise(() =>
            call({
              ...(args ?? {}),
              where: tenantWhere((args?.where as Record<string, unknown>) ?? {}, scopeOf()),
              create: tenantData((args?.create as Record<string, unknown>) ?? {}, scopeOf()),
              update: (args?.update as Record<string, unknown>) ?? {},
            }),
          );
      }

      // Fail closed: anything not explicitly scoped is not reachable through a
      // scoped delegate.
      return () =>
        asPromise(() => {
          throw ApiError.forbidden('Unsupported operation on a tenant-scoped model.', {
            reason: 'unscoped_operation_blocked',
            operation: property,
            model: options.model,
          });
        });
    },
  }) as TDelegate;
}

/**
 * Converts a synchronous throw into a rejected promise.
 *
 * Scoping runs before the underlying delegate is called, so a scope violation
 * would otherwise throw *synchronously* from a call site that looks
 * asynchronous — and `widgets.create(...).catch(handle)` would never see it.
 * Every failure mode of a scoped delegate is therefore a rejection.
 */
function asPromise(fn: () => unknown): Promise<unknown> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error);
  }
}

function scopeData(data: unknown, organizationId?: OrganizationId): unknown {
  if (Array.isArray(data)) {
    return data.map((row) => tenantData((row ?? {}) as Record<string, unknown>, organizationId));
  }
  return tenantData((data ?? {}) as Record<string, unknown>, organizationId);
}
