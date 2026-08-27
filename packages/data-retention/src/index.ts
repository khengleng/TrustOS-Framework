/**
 * @trustos/data-retention
 *
 * Retention, archival, legal hold and deletion.
 *
 * **A legal hold always wins.** There is no `force`, no `override` and no privileged caller — a
 * hold that can be skipped by an argument gets skipped during exactly the incident it was placed
 * for. Automated deletion is the one governance control that destroys evidence, and it runs
 * unattended.
 *
 * **The longest applicable retention applies.** A record covered by a jurisdiction's seven years
 * and a product's five is kept for seven. Taking the most specific rule deletes it two years
 * early while doing exactly what it was told.
 */
export * from './retention';
