/**
 * Validation evidence for a registered application.
 *
 * The catalog reports an application's validation state from this, and nothing else can
 * set it. The distinction matters: a status field on a descriptor is a claim its author
 * makes about their own application, and every such field eventually says "pass".
 *
 * A record here is written by a validation run — `npm run validate:approval-workbench`
 * and its siblings — and carries what is needed to check the claim: which environment,
 * which suite, which commit, and how many checks actually ran. A reviewer who does not
 * believe it can re-run the suite named in it.
 *
 * `lifecycle` is deliberately absent. Passing validation is not promotion: an application
 * that works is still `draft` until somebody with the authority to say so decides
 * otherwise, and conflating the two is how a test result becomes a release.
 */
export interface ApplicationValidationEvidence {
  appId: string;
  status: 'not_tested' | 'partial' | 'pass' | 'fail';
  /** Where the evidence was gathered. Never promoted across environments. */
  environment: string;
  /** The command that produced it. */
  suite: string;
  /** The commit the suite ran against. */
  commit: string;
  validatedAt: string;
  checks: { total: number; passed: number; failed: number };
  /** Where the machine-readable result lives. */
  evidenceRef: string;
}

export type ApplicationEvidenceIndex = Readonly<Record<string, ApplicationValidationEvidence>>;

export const NO_APPLICATION_EVIDENCE: ApplicationEvidenceIndex = Object.freeze({});

/**
 * The validation state of an application, from evidence.
 *
 * Absent evidence is `not_tested` — the honest answer, and the one that stays correct
 * when somebody adds a descriptor and forgets to validate it.
 *
 * Evidence gathered in one environment does not describe another, so a caller asking
 * about PROD is told `not_tested` for a DEV result rather than being handed it. A pass
 * in DEV is a pass in DEV.
 */
export function validationStatusFor(
  appId: string,
  evidence: ApplicationEvidenceIndex,
  environment?: string,
): ApplicationValidationEvidence['status'] {
  const record = evidence[appId];
  if (!record) return 'not_tested';
  if (environment && record.environment !== environment) return 'not_tested';
  return record.status;
}
