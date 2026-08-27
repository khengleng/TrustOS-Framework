/**
 * SRE console permissions.
 *
 * Reading is generous and writing is not, and the reason is specific to this console rather than
 * general caution: an operations dashboard is most useful when everybody can see it. An engineer
 * who cannot see that a dependency is degraded cannot help, and the cost of hiding it is measured
 * in minutes during an incident.
 *
 * What is guarded is the three things that change what the platform *believes*: registering a
 * service (which decides what is monitored), setting an objective (which decides what counts as
 * broken), and closing an incident (which decides that it is over).
 */

export interface SrePermission {
  key: string;
  description: string;
}

const define = (key: string, description: string): SrePermission => ({ key, description });

export const SRE_PERMISSIONS = {
  READ: define('sre.console.read', 'View service health, objectives, budgets and incidents.'),
  SERVICE_WRITE: define('sre.service.write', 'Register a service or amend its dependencies.'),
  SLO_WRITE: define('sre.slo.write', 'Define or amend an objective.'),
  INCIDENT_DECLARE: define('sre.incident.declare', 'Declare an incident.'),
  INCIDENT_UPDATE: define('sre.incident.update', 'Add to an incident timeline or move its state.'),
  /**
   * Separate from updating.
   *
   * Closing asserts the incident is over and, for a SEV1 or SEV2, that a postmortem exists. It is
   * the assertion, not the mechanics, that wants a second person.
   */
  INCIDENT_CLOSE: define('sre.incident.close', 'Close an incident.'),
  EXPERIMENT_RUN: define('sre.experiment.run', 'Run a resilience experiment.'),
  EXPERIMENT_APPROVE: define(
    'sre.experiment.approve',
    "Approve somebody else's production experiment.",
  ),
} as const;

/** A role holding both halves of this pair can inject faults into production alone. */
export const SEGREGATED_PAIRS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  [SRE_PERMISSIONS.EXPERIMENT_RUN.key, SRE_PERMISSIONS.EXPERIMENT_APPROVE.key],
]);
