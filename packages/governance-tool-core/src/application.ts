import { z } from 'zod';
import { ACCESS_CLASSES, RESOURCE_OPERATIONS } from './access-classes';

/**
 * The internal application definition.
 *
 * A console — the operations console, the support console, the Financial Product Studio — is a
 * **document**, not code. Pages, data sources, actions and their permissions, declared and
 * stored, so that:
 *
 *   * what an internal tool can reach is reviewable without reading its source;
 *   * promotion between environments moves a document rather than a deployment;
 *   * the catalog can answer "which tools read the ledger" without anybody grepping;
 *   * an action that mutates something cannot be added without declaring which API it calls.
 *
 * That last property is the one that makes the layer worth building. In every low-code platform
 * that has gone wrong, the failure was the same: a query editor, a production connection, and a
 * button whose behaviour nobody could enumerate. Here an action names an operation on a
 * registered resource, and a mutation outside Class B is refused at definition time.
 *
 * **There is no query field.** Not a SQL box, not an expression, not a script. A data source
 * names a registered resource and an operation; the parameters are typed. A definition that could
 * carry SQL would be a definition that carries SQL into production through a review that was
 * looking at page layout.
 */

const idPattern = /^[a-z][a-z0-9-]{2,59}$/;

export const APP_LIFECYCLE_STATUSES = [
  'draft',
  'under_review',
  'approved',
  'active',
  'deprecated',
  'retired',
] as const;

export type AppLifecycleStatus = (typeof APP_LIFECYCLE_STATUSES)[number];

export const ENVIRONMENTS = ['dev', 'uat', 'prod'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const DATA_CLASSIFICATIONS = [
  'public',
  'internal',
  'confidential',
  'restricted',
  'highly_restricted',
] as const;

export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];

export const RISK_CLASSIFICATIONS = ['low', 'medium', 'high', 'critical'] as const;

/**
 * A data source: a named resource, an operation, and typed parameters.
 *
 * `parameters` are names and types, never values and never an expression. The runtime binds them
 * from page state; a source that carried an expression would be a source that computes, and a
 * thing that computes over production data inside a UI definition is the query editor by another
 * name.
 */
export const dataSourceSchema = z
  .object({
    id: z.string().regex(idPattern),
    /** A resource id from the approved registry. Checked at definition time and again at runtime. */
    resourceId: z.string().min(1).max(120),
    operation: z.enum(RESOURCE_OPERATIONS),
    parameters: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/),
            type: z.enum(['string', 'integer', 'boolean', 'date', 'id', 'enum']),
            required: z.boolean().default(true),
            values: z.array(z.string().max(60)).max(40).optional(),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    /** Columns this source returns. Checked against the resource's own declaration. */
    fields: z.array(z.string().min(1).max(80)).max(200).default([]),
    /**
     * Field names that look like a credential and are not.
     *
     * `inputTokens` on an AI usage report is a count. Each entry is an exact field name, listed
     * here so it is visible in review — there is no wildcard, because a wildcard is used once
     * during an incident and never removed.
     */
    fieldExceptions: z.array(z.string().min(1).max(80)).max(20).default([]),
    /** Rows a single call may return. Bounded, always — an unbounded read is an outage. */
    maxRows: z.number().int().min(1).max(10_000).default(200),
    description: z.string().max(300).optional(),
  })
  .strict();

export type DataSource = z.infer<typeof dataSourceSchema>;

/**
 * An action: something a person can do from the console.
 *
 * Every action names the **TrustOS API operation** it calls. There is no action kind that writes
 * directly, and adding one would remove the property this whole layer exists for.
 *
 * `requiresReason` and `requiresApproval` are declared per action rather than inferred. A freeze
 * needs a reason; a limit change needs an approval; a search needs neither. Inferring it from the
 * verb would be wrong in both directions.
 */
export const actionSchema = z
  .object({
    id: z.string().regex(idPattern),
    label: z.string().min(1).max(80),
    /** The registered resource this action operates on. */
    resourceId: z.string().min(1).max(120),
    operation: z.enum(RESOURCE_OPERATIONS),
    /** The gateway path. Segments only — no query, no host, no scheme. */
    apiPath: z
      .string()
      .regex(/^\/internal\/v1\/[A-Za-z0-9\-/:{}]{1,180}$/, 'An /internal/v1 gateway path.')
      .refine((value) => !value.includes('..'), 'A path may not contain "..".'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    /** The Governance Tool permission that decides whether the button renders. */
    permission: z.string().min(3).max(80),
    requiresReason: z.boolean().default(false),
    requiresApproval: z.boolean().default(false),
    /** Whether this action can be undone. A destructive action is confirmed twice. */
    reversible: z.boolean().default(true),
    description: z.string().max(300).optional(),
  })
  .strict()
  .superRefine((action, ctx) => {
    if (action.operation === 'delete' && action.reversible) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reversible'],
        message:
          'A delete is not reversible. Marking it so removes the second confirmation, and the ' +
          'second confirmation is the whole control.',
      });
    }

    if (!action.reversible && !action.requiresReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiresReason'],
        message:
          'An irreversible action needs a reason. "Why did we do this" is asked about exactly ' +
          'the actions that cannot be undone.',
      });
    }
  });

export type InternalAction = z.infer<typeof actionSchema>;

export const PAGE_COMPONENTS = [
  'table',
  'form',
  'detail',
  'timeline',
  'queue',
  'chart',
  'kpi',
  'filter',
  'search',
  'approval',
  'case',
  'action_panel',
  'report',
] as const;

export const pageSchema = z
  .object({
    id: z.string().regex(idPattern),
    title: z.string().min(1).max(80),
    /** The permission that decides whether this page appears in the navigation. */
    permission: z.string().min(3).max(80),
    components: z
      .array(
        z
          .object({
            id: z.string().regex(idPattern),
            kind: z.enum(PAGE_COMPONENTS),
            title: z.string().max(80).optional(),
            /** Which declared data source feeds it. */
            dataSourceId: z.string().max(60).optional(),
            /** Which declared actions it offers. */
            actionIds: z.array(z.string().max(60)).max(20).default([]),
            /** Fields shown. Checked against the data source's own list. */
            fields: z.array(z.string().max(80)).max(100).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    description: z.string().max(300).optional(),
  })
  .strict();

export type InternalPage = z.infer<typeof pageSchema>;

/**
 * The catalog metadata every internal application carries.
 *
 * Section 30 of the specification asks for it, and the reason all of it is required rather than
 * optional is the same as everywhere else in this framework: an optional owner field is an empty
 * owner field, and the question "who built this and what does it read" is asked during an
 * incident.
 */
export const internalApplicationSchema = z
  .object({
    appId: z.string().regex(idPattern),
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(400),
    /** Why this exists, in a sentence somebody outside the team can read. */
    businessPurpose: z.string().min(10).max(400),

    owner: z.string().min(1).max(80),
    businessOwner: z.string().min(1).max(80),
    technicalOwner: z.string().min(1).max(80),

    environment: z.enum(ENVIRONMENTS),
    lifecycleStatus: z.enum(APP_LIFECYCLE_STATUSES),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),

    dataClassification: z.enum(DATA_CLASSIFICATIONS),
    riskClassification: z.enum(RISK_CLASSIFICATIONS),

    /** Which internal roles may open it at all. */
    roles: z.array(z.string().min(1).max(60)).max(20).default([]),

    dataSources: z.array(dataSourceSchema).max(60).default([]),
    actions: z.array(actionSchema).max(80).default([]),
    pages: z.array(pageSchema).min(1).max(40),

    /** Whether the app uses AI assistance, and which features. Declared, so it is reviewable. */
    aiFeatures: z.array(z.string().regex(idPattern)).max(20).default([]),

    lastSecurityReview: z.string().datetime().nullable(),
    nextSecurityReview: z.string().datetime(),
  })
  .strict()
  .superRefine((app, ctx) => {
    const sourceIds = new Set(app.dataSources.map((source) => source.id));
    const actionIds = new Set(app.actions.map((action) => action.id));

    for (const [pageIndex, page] of app.pages.entries()) {
      for (const [componentIndex, component] of page.components.entries()) {
        if (component.dataSourceId && !sourceIds.has(component.dataSourceId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['pages', pageIndex, 'components', componentIndex, 'dataSourceId'],
            message: `No data source "${component.dataSourceId}". A component bound to nothing renders empty and looks broken.`,
          });
        }

        for (const actionId of component.actionIds) {
          if (actionIds.has(actionId)) continue;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['pages', pageIndex, 'components', componentIndex, 'actionIds'],
            message: `No action "${actionId}".`,
          });
        }
      }
    }

    /*
     * A highly-restricted application in production needs a completed security review.
     *
     * Checked here rather than at promotion, so it is visible while the app is being written
     * rather than at the moment somebody is trying to ship it.
     */
    if (
      app.environment === 'prod' &&
      app.dataClassification === 'highly_restricted' &&
      app.lastSecurityReview === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lastSecurityReview'],
        message:
          'A highly-restricted application in production has never had a security review. The ' +
          'classification says the data needs one.',
      });
    }
  });

export type InternalApplication = z.infer<typeof internalApplicationSchema>;

export function parseInternalApplication(input: unknown): InternalApplication {
  return internalApplicationSchema.parse(input);
}

/** Every resource an application reaches. What the catalog answers "which tools read the ledger" with. */
export function resourcesUsedBy(app: InternalApplication): string[] {
  return [
    ...new Set([
      ...app.dataSources.map((source) => source.resourceId),
      ...app.actions.map((action) => action.resourceId),
    ]),
  ].sort();
}

/** Every access class an application touches, given a registry's classification of its resources. */
export function accessClassesUsedBy(
  app: InternalApplication,
  classify: (resourceId: string) => (typeof ACCESS_CLASSES)[number] | null,
): string[] {
  return [
    ...new Set(
      resourcesUsedBy(app)
        .map(classify)
        .filter((value): value is (typeof ACCESS_CLASSES)[number] => value !== null),
    ),
  ].sort();
}
