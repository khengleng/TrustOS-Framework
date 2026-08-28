import { z } from 'zod';

/**
 * The provider interfaces, and the operations each one offers.
 *
 * This file is the reason a bank can be replaced without reopening a product. A block declares
 * that it needs a `PaymentProvider`; a connector says that some external system implements
 * `PaymentProvider.execute`; nothing in a product definition ever names a vendor. Swapping the
 * rail underneath is a connector change, reviewed by security and operations, and the product's
 * approved definition does not move.
 *
 * Seven interfaces, and the operation lists are **closed**. That is the part that does the work:
 * an open interface would let a connector declare `PaymentProvider.doAnythingWeNeed`, and within
 * a year the products would be calling vendor-shaped operations through a vendor-neutral name,
 * which is the same coupling wearing a disguise.
 *
 * The framework ships **no implementation of any of these**. Not one, deliberately — the seam is
 * the deliverable, and an adapter here is an adapter every deployment carries. A product built on
 * this brings its own, wired through `@trustos/adapter-framework`.
 */

export const PROVIDER_INTERFACES = {
  PaymentProvider: {
    description: 'Moves money over an external rail: authorize, capture, refund, query.',
    operations: ['authorize', 'execute', 'capture', 'refund', 'cancel', 'status'],
  },
  IdentityProvider: {
    description: 'Proves who somebody is: credential verification and second factors.',
    operations: ['authenticate', 'challenge', 'verify', 'revoke'],
  },
  KycProvider: {
    description: 'Resolves a customer’s verification level. Returns a level, never documents.',
    operations: ['submit', 'status', 'level'],
  },
  RiskProvider: {
    description: 'Screening and scoring: AML, sanctions, PEP, fraud, device.',
    operations: ['screen', 'score', 'decision', 'feedback'],
  },
  SettlementProvider: {
    description: 'Instructs and reports on settlement to a counterparty.',
    operations: ['instruct', 'status', 'statement', 'cancel'],
  },
  NotificationProvider: {
    description: 'Delivers a message. Template code and references only, never an amount.',
    operations: ['send', 'status'],
  },
  CreditProvider: {
    description:
      'The seam where a credit decision comes from outside. No scoring model ships here.',
    operations: ['assess', 'status', 'report'],
  },
} as const;

export type ProviderInterfaceName = keyof typeof PROVIDER_INTERFACES;

export const PROVIDER_INTERFACE_NAMES = Object.keys(PROVIDER_INTERFACES) as ProviderInterfaceName[];

export function isProviderInterface(value: string): value is ProviderInterfaceName {
  return Object.prototype.hasOwnProperty.call(PROVIDER_INTERFACES, value);
}

export function operationsOf(name: ProviderInterfaceName): readonly string[] {
  return PROVIDER_INTERFACES[name].operations;
}

/**
 * Names that must never appear in a connector id, a description or an operation.
 *
 * A deliberately short list of the specific vendors and schemes this phase is constrained to stay
 * away from, checked mechanically rather than left to review. The check is a *shape* check as
 * much as a name check: an id like `aba-payments-v2` is a product decision leaking into the
 * framework, and it reads as harmless until four more arrive.
 *
 * A deployment's own connector registry will and should name its providers — that is what a
 * connector is for. This list guards the **framework's** catalog, which ships empty.
 */
export const FRAMEWORK_FORBIDDEN_PROVIDER_NAMES: readonly string[] = [
  'bakong',
  'khqr',
  'aba',
  'wing',
  'acleda',
  'visa',
  'mastercard',
  'swift',
  'iso20022',
  'paykh',
  'dbank',
];

export const providerInterfaceSchema = z.string().refine(isProviderInterface, {
  message:
    `Unknown provider interface. One of: ${PROVIDER_INTERFACE_NAMES.join(', ')}. A product ` +
    'never names a vendor; it names an interface, and a connector binds the interface to ' +
    'something outside.',
});
