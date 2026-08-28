/**
 * Enterprise governance permissions.
 *
 * Defined here rather than in a package because they span five domains, and a package holding
 * them would have to depend on all thirty — which the architecture check would refuse, correctly.
 *
 * The split that matters runs through every group: **reading a governance record and changing it
 * are different permissions, and changing it is usually two.** Classification, policy activation,
 * access grants and DR activation all separate the person who proposes from the person who
 * approves, because each of them is a way to widen access without touching any data.
 *
 * The reveal permissions are the sharpest example. `DATA_REVEAL` lets somebody ask to see a
 * restricted value; `DATA_REVEAL_APPROVE` lets somebody else agree. A role holding both is a role
 * that can read anything unobserved, and the segregation test in this application refuses one.
 */

export interface EnterprisePermission {
  key: string;
  resource: string;
  action: string;
  description: string;
}

function define(key: string, description: string): EnterprisePermission {
  const segments = key.split('.');
  return {
    key,
    resource: segments.slice(0, -1).join('.'),
    action: segments[segments.length - 1] as string,
    description,
  };
}

export const ENTERPRISE_PERMISSIONS = {
  // --- data governance ------------------------------------------------------
  DATA_CATALOG_READ: define('enterprise.data.catalog.read', 'Browse the data catalog.'),
  DATA_CLASSIFY: define(
    'enterprise.data.classify',
    'Propose a classification for a catalog entry.',
  ),
  /** Deliberately separate: reclassifying downward is how restricted data becomes readable. */
  DATA_CLASSIFY_APPROVE: define(
    'enterprise.data.classify.approve',
    "Approve somebody else's classification change.",
  ),
  DATA_LINEAGE_READ: define('enterprise.data.lineage.read', 'View data lineage.'),
  DATA_RETENTION_READ: define('enterprise.data.retention.read', 'View retention decisions.'),
  DATA_REVEAL: define('enterprise.data.reveal', 'Request to see a masked value.'),
  DATA_REVEAL_APPROVE: define(
    'enterprise.data.reveal.approve',
    'Approve a reveal somebody else requested.',
  ),
  DATA_ACCESS_REVIEW: define('enterprise.data.access.review', 'Review and renew access grants.'),

  // --- policy ---------------------------------------------------------------
  POLICY_READ: define('enterprise.policy.read', 'Read policy documents and their versions.'),
  POLICY_SIMULATE: define(
    'enterprise.policy.simulate',
    'Simulate a policy, including a draft, against attributes.',
  ),
  POLICY_AUTHOR: define('enterprise.policy.author', 'Create and edit draft policies.'),
  /** Never held with POLICY_AUTHOR. Activating your own policy is unreviewed rule-making. */
  POLICY_ACTIVATE: define(
    'enterprise.policy.activate',
    'Activate a policy version somebody else authored.',
  ),
  POLICY_DECISIONS_READ: define('enterprise.policy.decisions.read', 'Read the decision log.'),

  // --- SRE ------------------------------------------------------------------
  SRE_SERVICE_READ: define('enterprise.sre.service.read', 'View the service registry.'),
  SRE_SERVICE_WRITE: define('enterprise.sre.service.write', 'Register and amend services.'),
  SRE_SLO_READ: define('enterprise.sre.slo.read', 'View objectives and error budgets.'),
  SRE_SLO_WRITE: define('enterprise.sre.slo.write', 'Define objectives.'),
  SRE_INCIDENT_READ: define('enterprise.sre.incident.read', 'View incidents.'),
  SRE_INCIDENT_WRITE: define('enterprise.sre.incident.write', 'Declare and update incidents.'),
  SRE_INCIDENT_CLOSE: define(
    'enterprise.sre.incident.close',
    'Close an incident, subject to its postmortem gate.',
  ),

  // --- API management -------------------------------------------------------
  API_CATALOG_READ: define('enterprise.api.catalog.read', 'Browse the API catalog.'),
  API_PUBLISH: define(
    'enterprise.api.publish',
    'Publish an API. In production the catalog additionally refuses an owner publishing their own.',
  ),
  API_CONSUMER_READ: define('enterprise.api.consumer.read', 'View API consumers.'),
  API_CONSUMER_WRITE: define('enterprise.api.consumer.write', 'Grant and revoke entitlements.'),
  API_USAGE_READ: define('enterprise.api.usage.read', 'View API usage and quota consumption.'),

  // --- continuity -----------------------------------------------------------
  CONTINUITY_READ: define(
    'enterprise.continuity.read',
    'View backups, restore tests and DR plans.',
  ),
  CONTINUITY_WRITE: define('enterprise.continuity.write', 'Record restore tests and DR exercises.'),
  /** Activating a DR plan moves production. It is not a read-adjacent action. */
  DR_ACTIVATE: define('enterprise.continuity.dr.activate', 'Activate a disaster recovery plan.'),
} as const;

export type EnterprisePermissionKey =
  (typeof ENTERPRISE_PERMISSIONS)[keyof typeof ENTERPRISE_PERMISSIONS]['key'];

/**
 * Permission pairs that must never be held by one role.
 *
 * Each pair is a proposer and an approver. Holding both collapses a two-person control into one
 * person, and the collapse is invisible in a role definition — it looks like somebody being given
 * the permissions they need to do their job.
 */
export const SEGREGATED_PAIRS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  [ENTERPRISE_PERMISSIONS.DATA_CLASSIFY.key, ENTERPRISE_PERMISSIONS.DATA_CLASSIFY_APPROVE.key],
  [ENTERPRISE_PERMISSIONS.DATA_REVEAL.key, ENTERPRISE_PERMISSIONS.DATA_REVEAL_APPROVE.key],
  [ENTERPRISE_PERMISSIONS.POLICY_AUTHOR.key, ENTERPRISE_PERMISSIONS.POLICY_ACTIVATE.key],
]);

/** Roles that hold both halves of a segregated pair. */
export function segregationViolations(
  roles: ReadonlyArray<{ name: string; permissions: readonly string[] }>,
): Array<{ role: string; pair: readonly [string, string] }> {
  const violations: Array<{ role: string; pair: readonly [string, string] }> = [];

  for (const role of roles) {
    const held = new Set(role.permissions);
    for (const pair of SEGREGATED_PAIRS) {
      if (held.has(pair[0]) && held.has(pair[1])) violations.push({ role: role.name, pair });
    }
  }

  return violations;
}
