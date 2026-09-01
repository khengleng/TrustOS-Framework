import { ApiError } from '@trustsystem/errors';
import type { FormDefinition } from './forms';
import type { FilterDefinition, AppliedFilter } from './filters';
import { parseFilters, toPrismaWhere } from './filters';
import type { SearchDefinition } from './search';
import { normalizeSearchTerm, toSearchWhere } from './search';
import type { TableDefinition, SortSpec } from './tables';
import { resolveSort, visibleColumns, pickColumns } from './tables';
import type { PermissionCheck } from './permissions';
import type { OffsetQuery } from './pagination';
import { buildOffsetPage, toSkipTake, type OffsetPage } from './pagination';

/**
 * CRUD.
 *
 * A resource is one declaration that the table, the form, the filters, the search box and the
 * permission checks are all read out of. That single-declaration property is the whole point:
 * the recurring bug in an admin console is a field added to the form and forgotten in the table,
 * or a filter added to the UI and never allowed by the API. Both are impossible when there is one
 * list.
 *
 * What this is **not** is a repository. There is no Prisma client here, no `findMany`, no
 * transaction. `buildListQuery` returns the arguments for a query the template runs itself
 * against its own schema — because the moment an SDK owns the query, it owns the tenant scope,
 * and a tenant scope applied by a shared library that a template can forget to configure is worse
 * than one the template writes on every call and a test proves.
 *
 * The framework already has the right place for that: `TenantRepository` in the generated
 * application. This composes with it; it does not replace it.
 */

export type CrudAction = 'list' | 'read' | 'create' | 'update' | 'delete';

export interface ResourceDefinition {
  /** URL segment and the key everything else references. */
  key: string;
  label: string;
  /** Singular, for a detail page title and an error message. */
  singular: string;
  description?: string;
  /** API path, relative to the API root. */
  endpoint: string;
  table: TableDefinition;
  form?: FormDefinition;
  filters?: FilterDefinition[];
  search?: SearchDefinition;
  /**
   * Permission per action.
   *
   * Every action a resource supports must have one. An action with no permission is open to
   * every authenticated actor, and `assertCan` refuses to guess — an omission here is far more
   * likely to be forgetfulness than a decision.
   */
  permissions: Partial<Record<CrudAction, string>>;
  /** Actions the resource supports. Anything absent is not routed at all. */
  actions?: CrudAction[];
}

export const DEFAULT_ACTIONS: CrudAction[] = ['list', 'read', 'create', 'update'];

export function supportsAction(resource: ResourceDefinition, action: CrudAction): boolean {
  return (resource.actions ?? DEFAULT_ACTIONS).includes(action);
}

/**
 * Refuses an action the actor may not take.
 *
 * Throws `notFound` for an unsupported action and `forbidden` for a denied one — but only after
 * the resource itself is known to exist. A caller who cannot list a resource learns nothing about
 * whether a particular record is there.
 */
export function assertCan(
  resource: ResourceDefinition,
  action: CrudAction,
  can: PermissionCheck,
): void {
  if (!supportsAction(resource, action)) {
    throw ApiError.notFound(`${resource.label} does not support "${action}".`);
  }

  const permission = resource.permissions[action];

  if (!permission) {
    throw new Error(
      `Resource "${resource.key}" declares no permission for "${action}". Every routed action ` +
        'needs one — an unguarded write is not a decision anybody makes deliberately.',
    );
  }

  if (!can(permission)) {
    throw ApiError.forbidden(
      `You do not have permission to ${action} ${resource.label.toLowerCase()} (${permission}).`,
    );
  }
}

export interface ListRequest {
  page?: OffsetQuery;
  sort?: Partial<SortSpec>;
  filters?: AppliedFilter[];
  search?: string | null;
}

export interface ListQuery {
  where: Record<string, unknown>;
  orderBy: Record<string, 'asc' | 'desc'>;
  skip: number;
  take: number;
}

/**
 * Turns a validated request into query arguments.
 *
 * Every part of the `where` comes from something the resource declared — filters through
 * `parseFilters`, search through `toSearchWhere`, order through `resolveSort`. Nothing reaches
 * the query that the resource did not name in advance.
 *
 * `scope` is the caller's tenant predicate and is merged last so it cannot be overwritten by a
 * filter on the same field. A caller filtering `organizationId` finds their own scope applied on
 * top, which is the one ordering that is safe.
 */
export function buildListQuery(
  resource: ResourceDefinition,
  request: ListRequest,
  options: { can: PermissionCheck; scope?: Record<string, unknown> } = { can: () => true },
): ListQuery {
  const filters = parseFilters(resource.filters ?? [], request.filters ?? [], options.can);
  const term = normalizeSearchTerm(request.search ?? null);
  const search = resource.search ? toSearchWhere(resource.search, term, options.can) : {};
  const sort = resolveSort(resource.table, request.sort);

  const page: OffsetQuery = request.page ?? { page: 1, pageSize: 25 };
  const { skip, take } = toSkipTake(page);

  return {
    where: { ...toPrismaWhere(filters), ...search, ...(options.scope ?? {}) },
    orderBy: { [sort.key]: sort.direction },
    skip,
    take,
  };
}

/**
 * Shapes rows into a page the caller may see.
 *
 * Projects through the columns the actor is allowed — see `visibleColumns`. This is the step that
 * makes a column permission a real control rather than a rendering hint, and it must run on the
 * server.
 */
export function buildListResponse<T extends Record<string, unknown>>(
  resource: ResourceDefinition,
  rows: T[],
  total: number,
  page: OffsetQuery,
  can: PermissionCheck,
): OffsetPage<Partial<T>> {
  const columns = visibleColumns(resource.table, can);
  return buildOffsetPage(
    rows.map((row) => pickColumns(row, columns)),
    total,
    page,
  );
}

/**
 * Past-tense verb per action. An audit trail records what happened, not what was attempted.
 *
 * A map rather than a rule, because English does not have one: "created", "updated", "deleted"
 * and "viewed" do not derive from their verbs the same way.
 */
const AUDIT_VERBS: Record<CrudAction, string> = {
  list: 'listed',
  read: 'viewed',
  create: 'created',
  update: 'updated',
  delete: 'deleted',
};

/**
 * The audit action name for a CRUD operation.
 *
 * Namespaced under the resource key so a template's actions can never collide with a framework
 * one — the same rule Phase 8 landed on after `accounts.account.*` had to be renamed to
 * `ledger.account.*`.
 */
export function auditAction(resource: ResourceDefinition, action: CrudAction): string {
  return `${resource.key}.${AUDIT_VERBS[action]}`;
}

/** Navigation entry for a resource, so a console's menu is derived rather than maintained. */
export function toNavigationItem(resource: ResourceDefinition): {
  key: string;
  label: string;
  href: string;
  permission?: string;
} {
  return {
    key: resource.key,
    label: resource.label,
    href: `/${resource.key}`,
    permission: resource.permissions.list ?? resource.permissions.read,
  };
}
