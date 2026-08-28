/**
 * @trustos/integration-health
 *
 * One question — is the integration layer working? — answered as healthy, warning or critical.
 *
 * Two rules shape it: the worst check wins (an average would be green during an outage), and a
 * check that cannot answer is a warning rather than a pass.
 */
export * from './health';
