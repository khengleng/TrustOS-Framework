/**
 * @trustsystem/financial-risk
 *
 * Risk and compliance extension points: AML, fraud, velocity, sanctions, PEP, KYC, travel rule.
 *
 * **No detection engine, and no regulator-specific rules.** Both are products: one needs licensed
 * lists and trained models, the other changes by regulation rather than by release. A framework
 * that shipped either would ship a wrong one — and a deployment would believe it was screened.
 */
export * from './risk';
export * from './compliance';
