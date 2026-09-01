import {
  ResourceRegistry,
  resourceRegistrationSchema,
  type ResourceRegistration,
} from '@trustsystem/governance-resource-policy';
import type { Environment } from '@trustsystem/governance-tool-core';

/**
 * The resources this deployment has approved, per environment.
 *
 * **Why this file exists.** Until now the only way to register a resource was to pass one in
 * code at the call site of `GovernanceToolModule.forRoot`, which nothing did — so every read
 * was refused with "no approved resource" in every deployed environment. That refusal is the
 * honest answer to an unregistered resource, but "nobody has ever registered one" and "this
 * resource is not approved" should not be the same state, and they were.
 *
 * **Why a TypeScript module and not a JSON file under `docs/`.** The runtime image copies
 * `packages/`, `apps/` and `package.json` — not `docs/`. A registry read from a docs file at
 * start-up is a registry that is always empty in production, which is exactly the defect
 * recorded as TOS-014. Declared here, it is type-checked, it ships with the application, and a
 * change to what this deployment claims is approved shows up in a diff.
 *
 * **What a registration is not.** It is not a code decision. Each entry names an owner, an
 * approver, an access class and a credential reference, and the schema refuses a production
 * resource whose approver is its own owner — "the registrant approved their own production
 * resource. That is the control, collapsed." Those are facts about an organisation, so they are
 * supplied by whoever owns the data, not invented here.
 *
 * That is why every environment below is empty. An empty list is a true statement: nothing has
 * been approved yet. A populated list of plausible-looking entries would be a fabricated
 * approval record, which is worse than an empty one in precisely the way this framework exists
 * to prevent.
 *
 * **To register one**, add it to the environment's array. The shape, from
 * `resourceRegistrationSchema`:
 *
 * ```ts
 *   {
 *     resourceId: 'reporting.transactions',
 *     environment: 'prod',
 *     accessClass: 'read_only',            // what a console may do with it
 *     owner: 'usr_...',                    // who is accountable for the data
 *     approvedBy: 'usr_...',               // must NOT be the owner, in prod
 *     credentialRef: 'secret://...',       // a reference, never a credential
 *   }
 * ```
 *
 * Run the suite afterwards: the schema is enforced at load, so a malformed entry fails the
 * build rather than the request.
 */
const DECLARED: Record<Environment, readonly unknown[]> = {
  dev: [],
  uat: [],
  prod: [],
};

/**
 * Parses the declarations for one environment.
 *
 * Validated at load rather than at first use, so a bad declaration stops a deployment starting
 * instead of surfacing as a refused read hours later. A registration naming a different
 * environment than the one asked for is rejected outright — a `dev` entry that reached the
 * `prod` list would be a development credential reference approved for production data.
 */
export function resourceRegistrationsFor(environment: Environment): ResourceRegistration[] {
  return DECLARED[environment].map((declaration, index) => {
    const parsed = resourceRegistrationSchema.parse(declaration);

    if (parsed.environment !== environment) {
      throw new Error(
        `Resource declaration ${index} in the ${environment} list declares ` +
          `environment "${parsed.environment}". A resource is approved for one environment, and ` +
          'a mismatch here would approve it for another.',
      );
    }

    return parsed;
  });
}

/** The registry this deployment serves, for one environment. */
export function resourceRegistryFor(environment: Environment): ResourceRegistry {
  return new ResourceRegistry(resourceRegistrationsFor(environment));
}
