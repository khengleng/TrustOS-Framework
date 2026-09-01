/**
 * @trustsystem/workflow-policy
 *
 * Workflow separation of duties, as policies on the phase 4 authorization engine.
 *
 * Every policy here can only *refuse* — none returns `allow` — so the set inherits
 * default-deny and adding a policy can only make the system stricter. That is the
 * reason these are policies rather than checks inside the runtime: a check covers one
 * call path, a policy covers every route that declares a workflow action, including
 * ones written later.
 *
 * Build the resource with `workflowResource()`. A policy that cannot find the field it
 * needs *abstains*, and an abstaining separation-of-duty policy is a control that
 * silently does not run.
 */
export * from './policies';
