import { z } from 'zod';
import { PROVIDER_HEALTH } from '@trustos/provider-sdk';
import { retryPolicySchema } from '@trustos/retry';
import {
  isProviderInterface,
  operationsOf,
  providerInterfaceSchema,
  type ProviderInterfaceName,
} from './interfaces';

/**
 * The connector contract.
 *
 * A connector is *metadata about a binding*: it says that some external system implements
 * `PaymentProvider.execute`, what it takes, what it returns, how long to wait and what to do when
 * it does not answer. It is not the adapter, and it holds no credential — the adapter lives in a
 * deployment and the credential lives in that deployment's secret store.
 *
 * Three refusals in the schema, each of which describes a real way an integration goes wrong:
 *
 * **No URL, anywhere.** A product workflow calls `connectorId`, and a connector names an
 * interface and an operation. The endpoint belongs to the adapter's configuration. A URL in a
 * product definition is an environment leaking into an approved artefact — the staging URL ships
 * to production, and it works, because staging answers.
 *
 * **A timeout is required and bounded.** An integration with no timeout holds a request until
 * something else gives up, which under load is every worker in the pool. Five minutes is the
 * ceiling because a financial operation nobody has answered in five minutes needs a person, not a
 * longer wait.
 *
 * **A retry policy on a non-idempotent operation is refused.** Retrying a capture that is not
 * idempotent captures twice. The policy has to be declared as absent rather than left off, so the
 * decision is visible in review.
 */

export const CONNECTOR_AUTH_TYPES = [
  'none',
  'api_key',
  'oauth2_client_credentials',
  'mutual_tls',
  'signed_request',
] as const;

export type ConnectorAuthType = (typeof CONNECTOR_AUTH_TYPES)[number];

export const CONNECTOR_DATA_CLASSIFICATIONS = [
  'public',
  'internal',
  'confidential',
  'restricted',
] as const;

export const CONNECTOR_LIFECYCLE_STATUSES = [
  'draft',
  'approved',
  'deprecated',
  'withdrawn',
] as const;

/** The same field descriptor shape the block catalog uses, restated so the packages stay independent. */
export const connectorFieldSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-zA-Z0-9]{0,49}$/),
    type: z.enum(['string', 'integer', 'boolean', 'money', 'reference', 'timestamp', 'id']),
    required: z.boolean().default(true),
    description: z.string().min(1).max(300),
    pii: z.boolean().default(false),
  })
  .strict();

/** Anything shaped like a URL. Checked against the whole document, not one field. */
const URL_SHAPED = /(https?:\/\/|\bwww\.|:\/\/)/i;

export const connectorDefinitionSchema = z
  .object({
    connectorId: z.string().regex(/^[a-z][a-z0-9-]{2,79}$/, 'Lowercase kebab-case.'),
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(400),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),

    providerInterface: providerInterfaceSchema,
    operation: z.string().regex(/^[a-z][a-zA-Z0-9]{1,39}$/),

    inputs: z.array(connectorFieldSchema).max(30).default([]),
    outputs: z.array(connectorFieldSchema).max(30).default([]),

    authentication: z.enum(CONNECTOR_AUTH_TYPES),
    /**
     * How long to wait, in milliseconds. Required, and capped.
     *
     * There is no "no timeout" option and there should not be. Every integration this framework
     * has seen that hung did so because somebody left the default, and the default was infinite.
     */
    timeoutMs: z.number().int().min(50).max(300_000),

    /** Whether calling twice with the same key is the same as calling once. */
    idempotent: z.boolean(),
    /** Absent when the operation is not idempotent — and the schema refuses the combination. */
    retry: retryPolicySchema.optional(),

    /**
     * Last known health. Advisory and *stale by construction*: it is a cached observation, not a
     * live probe, and a product that routed on it without a fallback would route on a fact that
     * was true a minute ago.
     */
    health: z.enum(PROVIDER_HEALTH).default('unknown'),
    healthCheckedAt: z.string().datetime().optional(),

    dataClassification: z.enum(CONNECTOR_DATA_CLASSIFICATIONS),
    lifecycleStatus: z.enum(CONNECTOR_LIFECYCLE_STATUSES),
    supersededBy: z.string().max(80).optional(),

    /** Who owns the integration. Answers "who do I call at 3am". */
    technicalOwner: z.string().min(1).max(80),
  })
  .strict()
  .superRefine((connector, ctx) => {
    if (isProviderInterface(connector.providerInterface)) {
      const allowed = operationsOf(connector.providerInterface as ProviderInterfaceName);
      if (!allowed.includes(connector.operation)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['operation'],
          message:
            `"${connector.operation}" is not an operation of ${connector.providerInterface}. ` +
            `One of: ${allowed.join(', ')}. The interface is closed on purpose — an open one ` +
            'lets a vendor-shaped operation through a vendor-neutral name.',
        });
      }
    }

    if (!connector.idempotent && connector.retry) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['retry'],
        message:
          'A retry policy on a non-idempotent operation retries a capture that already ' +
          'succeeded. Make the operation idempotent, or declare no retry.',
      });
    }

    if (connector.lifecycleStatus === 'deprecated' && !connector.supersededBy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supersededBy'],
        message: 'A deprecated connector must name its successor.',
      });
    }

    const document = `${connector.connectorId} ${connector.name} ${connector.description}`;
    if (URL_SHAPED.test(document)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['description'],
        message:
          'A connector carries no endpoint. The URL belongs to the adapter’s configuration in ' +
          'the deployment — one embedded here ships staging to production, and it works, ' +
          'because staging answers.',
      });
    }

    if (connector.authentication === 'none' && connector.dataClassification !== 'public') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authentication'],
        message:
          'An unauthenticated connector may only carry public data. Anything else is an ' +
          'integration anybody who can reach the network can call.',
      });
    }
  });

export type ConnectorDefinition = z.infer<typeof connectorDefinitionSchema>;
