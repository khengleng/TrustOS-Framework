/**
 * @trustos/governance-tool-core
 *
 * The Governance Tool's vocabulary: internal application definitions, the three data-access
 * classes, the permission catalog and the ten console templates.
 *
 * One sentence governs the whole package, and every decision in it follows from that sentence:
 * **the Governance Tool is an experience layer, not the system of record.** TrustOS remains
 * authoritative for authentication, authorization, tenancy, workflow, maker-checker, the ledger,
 * product rules, AI governance, audit and security policy. This layer decides what a person
 * *sees*; it never decides what is *true*.
 *
 * Read `access-classes.ts` first. Its three classes are the reason an internal application
 * builder is safe to give to operations, support and finance — and the reason the failure mode
 * everyone else hits (a query editor pointed at production) is not reachable here.
 */
export * from './access-classes';
export * from './permissions';
export * from './application';
export * from './consoles';
export * from './catalog';
