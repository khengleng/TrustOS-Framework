/**
 * @trustos/accounts
 *
 * The account tree: customer, merchant, system, settlement, suspense, fee and reserve accounts.
 *
 * An account's **type** is what makes its balance mean something. The most important line in the
 * package is that a customer wallet is a *liability* — money the business owes, credited when the
 * customer deposits. A system that models it as an asset reports its own obligations as its own
 * money.
 */
export * from './account';
export * from './service';
export * from './testing';
