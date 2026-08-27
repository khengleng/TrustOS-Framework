import { blockDefinitionSchema, type BlockDefinition, type BlockCategory } from './schema';

/**
 * The approved block catalog.
 *
 * Eighty-four blocks in thirteen categories, and every one of them is **provider-neutral**. There
 * is no Bakong block, no KHQR block, no ABA block and no card-scheme block, and the catalog is
 * the place where that constraint is either kept or lost — a single vendor-named block here
 * would make every product containing it a product for that vendor, which is the coupling the
 * whole layer exists to remove.
 *
 * Eleven of the categories are the ones section 4 of the specification lists. Two are not:
 *
 *   * **loyalty** — the Loyalty Wallet template in section 10 cannot be composed without earn,
 *     redeem and expire, and a template that ships without the blocks it needs is a template
 *     nobody can instantiate.
 *   * **notification** — the reference architecture's worked example ends with "send
 *     notification", and a product that cannot tell a customer what happened is a product whose
 *     channel has to reach around it.
 *
 * The catalog is data and it is local. There is no remote fetch and no plugin resolution, for
 * the same reason `@trustos/module-registry` has none: a block is a capability a product may use
 * without further review, and a capability that can arrive over the network at runtime has not
 * been reviewed.
 *
 * **Every block here is a contract, not an implementation.** The framework ships no handler for
 * any of them. `@trustos/financial-product-runtime` defines the handler interface, a deployment
 * binds each block to `@trustos/wallet`, `@trustos/ledger`, `@trustos/fees` and the rest, and
 * `@trustos/financial-product-sandbox` binds them to mocks. That seam is deliberate: the
 * framework knows what a debit *means* and stays out of deciding which account it lands in.
 */

/**
 * A field, written positionally.
 *
 * Name, type, description, and an optional tail for the two fields that need one — an enum's
 * values and a reference's domain. Positional because the catalog is eighty-four blocks and
 * three hundred fields, and the alternative reads as a wall of `{ name: …, type: … }` in which
 * a wrong type is invisible. The zod schema is what checks it; this is only how it is written.
 */
type FieldSpec = readonly [string, string, string] | readonly [string, string, string, Record<string, unknown>];

interface BlockInput {
  id: string;
  name: string;
  description: string;
  inputs?: FieldSpec[];
  outputs?: FieldSpec[];
  configuration?: FieldSpec[];
  permissions?: string[];
  provider?: string;
  next?: string[];
  after?: BlockCategory[];
  effect?: 'none' | 'reserves' | 'moves';
  idempotent?: boolean;
  compensatedBy?: string;
  audit?: string[];
  events?: string[];
  classification?: 'standard' | 'sensitive' | 'restricted';
}

function field(spec: FieldSpec) {
  const [name, type, description, extra] = spec;
  return { name, type, description, ...(extra ?? {}) };
}

function block(category: BlockCategory, input: BlockInput): BlockDefinition {
  const effect = input.effect ?? 'none';

  return blockDefinitionSchema.parse({
    blockId: `${category}.${input.id}`,
    name: input.name,
    category,
    version: '1.0.0',
    description: input.description,
    inputs: (input.inputs ?? []).map(field),
    outputs: (input.outputs ?? []).map(field),
    configuration: (input.configuration ?? []).map(field),
    requiredPermissions: input.permissions ?? [],
    ...(input.provider ? { providerInterface: input.provider } : {}),
    allowedNext: input.next ?? [],
    requiresPrecedingCategories: input.after ?? [],
    monetaryEffect: effect,
    idempotent: input.idempotent ?? effect !== 'none',
    ...(input.compensatedBy ? { compensatedBy: input.compensatedBy } : {}),
    auditEvents: input.audit ?? [],
    emitsEvents: input.events ?? [],
    securityClassification: input.classification ?? 'standard',
    lifecycleStatus: 'approved',
  });
}

const MONEY_IN: FieldSpec = ['amount', 'money', 'The transaction amount, as minor units plus currency.'];
const CUSTOMER_REF: FieldSpec = ['customerRef', 'id', 'Opaque customer reference. Never a name or a document number.'];
const WALLET_REF: FieldSpec = ['walletRef', 'id', 'The wallet this operation acts on.'];
const IDEMPOTENCY: FieldSpec = ['idempotencyKey', 'string', 'The caller’s key. Scoped to tenant, product and operation.'];

// --- identity ---------------------------------------------------------------

const IDENTITY: BlockDefinition[] = [
  block('identity', {
    id: 'authenticate',
    name: 'Authenticate',
    description:
      'Confirms the caller is who the credential says. Never reads an identifier from the request body.',
    inputs: [['credentialRef', 'id', 'A reference to the credential already verified upstream.']],
    outputs: [['actorRef', 'id', 'The verified actor.'], ['assuranceLevel', 'string', 'How strongly identity was proven.']],
    provider: 'IdentityProvider',
    audit: ['identity.authenticated'],
    classification: 'sensitive',
  }),
  block('identity', {
    id: 'verify_otp',
    name: 'Verify one-time password',
    description: 'Confirms possession of a second factor. Refuses on expiry, reuse and attempt exhaustion alike.',
    inputs: [['challengeRef', 'id', 'The challenge issued earlier.'], ['code', 'string', 'The submitted code.', { pii: false }]],
    outputs: [['verified', 'boolean', 'Whether the factor was proven.']],
    provider: 'IdentityProvider',
    audit: ['identity.otp_verified', 'identity.otp_refused'],
    classification: 'sensitive',
  }),
  block('identity', {
    id: 'kyc_check',
    name: 'KYC check',
    description:
      'Resolves the customer’s verification level. Returns a level, never the underlying documents.',
    inputs: [CUSTOMER_REF],
    outputs: [['kycLevel', 'reference', 'The verification level reached.', { referenceDomain: 'riskLevel' }]],
    provider: 'KycProvider',
    audit: ['identity.kyc_checked'],
    classification: 'sensitive',
  }),
  block('identity', {
    id: 'customer_lookup',
    name: 'Customer lookup',
    description: 'Resolves a customer reference to their status and type. Tenant-scoped by construction.',
    inputs: [CUSTOMER_REF],
    outputs: [
      ['customerType', 'reference', 'Individual, merchant, agent or partner.', { referenceDomain: 'customerType' }],
      ['status', 'string', 'Active, suspended or closed.'],
    ],
    permissions: ['financial.product.execute'],
    classification: 'sensitive',
  }),
  block('identity', {
    id: 'customer_eligibility',
    name: 'Customer eligibility',
    description: 'Decides whether this customer may hold this product, against declared criteria.',
    inputs: [CUSTOMER_REF],
    outputs: [['eligible', 'boolean', 'Whether the customer qualifies.'], ['reasonCode', 'string', 'Why not, when not.']],
    configuration: [['criteria', 'string', 'The eligibility rule set this product applies.']],
  }),
  block('identity', {
    id: 'consent_check',
    name: 'Consent check',
    description: 'Confirms an active consent covers this processing. A missing consent is a refusal, not a warning.',
    inputs: [CUSTOMER_REF, ['purpose', 'string', 'What the data is being used for.']],
    outputs: [['granted', 'boolean', 'Whether consent covers the purpose.']],
    audit: ['identity.consent_checked'],
    classification: 'sensitive',
  }),
  block('identity', {
    id: 'device_check',
    name: 'Device check',
    description: 'Scores the device the request came from. A signal, never an authentication.',
    inputs: [['deviceRef', 'id', 'The device fingerprint reference.']],
    outputs: [['trusted', 'boolean', 'Whether the device is known and unchanged.']],
    provider: 'RiskProvider',
  }),
];

// --- wallet -----------------------------------------------------------------

const WALLET: BlockDefinition[] = [
  block('wallet', {
    id: 'create',
    name: 'Create wallet',
    description: 'Opens a wallet as a view over ledger accounts. A wallet never carries its own balance column.',
    inputs: [CUSTOMER_REF, ['currency', 'string', 'The wallet currency. One wallet, one currency.']],
    outputs: [WALLET_REF],
    permissions: ['financial.product.execute'],
    next: ['wallet.activate', 'limit.*', 'notification.*'],
    audit: ['wallet.created'],
    events: ['financial.product.execution.step_completed'],
  }),
  block('wallet', {
    id: 'activate',
    name: 'Activate wallet',
    description: 'Makes a wallet usable. Separate from creation so a wallet can exist while checks finish.',
    inputs: [WALLET_REF],
    outputs: [['status', 'string', 'The wallet status after activation.']],
    audit: ['wallet.activated'],
  }),
  block('wallet', {
    id: 'freeze',
    name: 'Freeze wallet',
    description: 'Stops movement without closing. Existing holds stand; new debits and credits are refused.',
    inputs: [WALLET_REF, ['reasonCode', 'string', 'Why. Recorded, and shown to whoever unfreezes.']],
    outputs: [['status', 'string', 'The wallet status after freezing.']],
    audit: ['wallet.frozen'],
    classification: 'sensitive',
  }),
  block('wallet', {
    id: 'unfreeze',
    name: 'Unfreeze wallet',
    description: 'Restores movement. Deliberately a separate permission from freezing.',
    inputs: [WALLET_REF],
    outputs: [['status', 'string', 'The wallet status after unfreezing.']],
    audit: ['wallet.unfrozen'],
    classification: 'sensitive',
  }),
  block('wallet', {
    id: 'get_balance',
    name: 'Get balance',
    description:
      'Reads available, held and total. Every downstream check uses **available**: a hold is money that is present and not spendable.',
    inputs: [WALLET_REF],
    outputs: [
      ['available', 'money', 'What may be spent now.'],
      ['held', 'money', 'Present and reserved.'],
      ['total', 'money', 'Available plus held. Never the figure an authorization checks.'],
    ],
  }),
  block('wallet', {
    id: 'hold_funds',
    name: 'Hold funds',
    description: 'Reserves against the available balance. The reservation, not the check, is what closes the race.',
    inputs: [WALLET_REF, MONEY_IN, IDEMPOTENCY],
    outputs: [['holdRef', 'id', 'The reservation.']],
    after: ['limit'],
    effect: 'reserves',
    next: ['wallet.debit', 'wallet.release_hold', 'payment.*', 'transfer.*'],
    audit: ['wallet.hold_placed'],
  }),
  block('wallet', {
    id: 'release_hold',
    name: 'Release hold',
    description: 'Returns reserved funds to available. Releasing a hold that was already captured is refused.',
    inputs: [['holdRef', 'id', 'The reservation to release.'], IDEMPOTENCY],
    outputs: [['released', 'money', 'What returned to available.']],
    after: ['wallet'],
    effect: 'reserves',
    audit: ['wallet.hold_released'],
  }),
  block('wallet', {
    id: 'debit',
    name: 'Debit wallet',
    description: 'Moves money out. Posts through the ledger; the wallet balance is derived, never written.',
    inputs: [WALLET_REF, MONEY_IN, IDEMPOTENCY],
    outputs: [['journalRef', 'id', 'The journal that recorded it.']],
    after: ['limit'],
    effect: 'moves',
    compensatedBy: 'ledger.reverse_journal',
    next: ['ledger.*', 'fee.*', 'settlement.*', 'notification.*'],
    audit: ['wallet.debited'],
    events: ['financial.product.execution.step_completed'],
  }),
  block('wallet', {
    id: 'credit',
    name: 'Credit wallet',
    description: 'Moves money in. A customer wallet is a liability: crediting it increases what the business owes.',
    inputs: [WALLET_REF, MONEY_IN, IDEMPOTENCY],
    outputs: [['journalRef', 'id', 'The journal that recorded it.']],
    after: ['limit'],
    effect: 'moves',
    compensatedBy: 'ledger.reverse_journal',
    next: ['ledger.*', 'fee.*', 'settlement.*', 'notification.*'],
    audit: ['wallet.credited'],
    events: ['financial.product.execution.step_completed'],
  }),
];

// --- payment ----------------------------------------------------------------

const PAYMENT: BlockDefinition[] = [
  block('payment', {
    id: 'create',
    name: 'Create payment',
    description: 'Records a claim on a payer. Every payment request expires; one that does not is a claim forever.',
    inputs: [MONEY_IN, ['payerRef', 'id', 'Who is being asked to pay.'], IDEMPOTENCY],
    outputs: [['paymentRef', 'id', 'The payment request.'], ['expiresAt', 'timestamp', 'When the claim lapses.']],
    next: ['payment.authorize', 'payment.execute', 'payment.cancel', 'risk.*'],
    audit: ['payment.created'],
  }),
  block('payment', {
    id: 'authorize',
    name: 'Authorize payment',
    description: 'Obtains authorization without capturing. Reserves; does not move.',
    inputs: [['paymentRef', 'id', 'The payment to authorize.'], IDEMPOTENCY],
    outputs: [['authorizationRef', 'id', 'The authorization.']],
    provider: 'PaymentProvider',
    after: ['limit', 'risk'],
    effect: 'reserves',
    next: ['payment.execute', 'payment.cancel'],
    audit: ['payment.authorized'],
  }),
  block('payment', {
    id: 'execute',
    name: 'Execute payment',
    description: 'Captures. The step where money actually moves, and the one every control above exists to gate.',
    inputs: [['paymentRef', 'id', 'The payment to capture.'], IDEMPOTENCY],
    outputs: [['transactionRef', 'id', 'The resulting transaction.']],
    provider: 'PaymentProvider',
    after: ['limit'],
    effect: 'moves',
    compensatedBy: 'payment.refund',
    next: ['fee.*', 'ledger.*', 'settlement.*', 'reconciliation.*', 'notification.*'],
    audit: ['payment.executed'],
    events: ['financial.product.execution.step_completed'],
  }),
  block('payment', {
    id: 'verify',
    name: 'Verify payment',
    description: 'Confirms with the counterparty that a payment landed. Read-only, and safe to repeat.',
    inputs: [['paymentRef', 'id', 'The payment to verify.']],
    outputs: [['status', 'string', 'The counterparty’s view of the payment.']],
    provider: 'PaymentProvider',
  }),
  block('payment', {
    id: 'cancel',
    name: 'Cancel payment',
    description: 'Withdraws an unpaid claim and releases anything reserved for it.',
    inputs: [['paymentRef', 'id', 'The payment to cancel.'], IDEMPOTENCY],
    outputs: [['status', 'string', 'The status after cancellation.']],
    after: ['payment'],
    effect: 'reserves',
    audit: ['payment.cancelled'],
  }),
  block('payment', {
    id: 'refund',
    name: 'Refund payment',
    description:
      'Returns value from a captured payment. A new movement, never an edit of the original — the first posting stands.',
    inputs: [['transactionRef', 'id', 'The transaction to refund.'], MONEY_IN, IDEMPOTENCY],
    outputs: [['refundRef', 'id', 'The refund transaction.']],
    provider: 'PaymentProvider',
    after: ['limit'],
    effect: 'moves',
    compensatedBy: 'ledger.reverse_journal',
    next: ['ledger.*', 'settlement.*', 'reconciliation.*', 'notification.*'],
    audit: ['payment.refunded'],
  }),
  block('payment', {
    id: 'query_status',
    name: 'Query payment status',
    description: 'Reads current status. Present so a workflow can poll without a block that moves anything.',
    inputs: [['paymentRef', 'id', 'The payment to read.']],
    outputs: [['status', 'string', 'Current status.']],
  }),
];

// --- transfer ---------------------------------------------------------------

function transferBlock(id: string, name: string, description: string, next: string[]): BlockDefinition {
  return block('transfer', {
    id,
    name,
    description,
    inputs: [['fromRef', 'id', 'The debited position.'], ['toRef', 'id', 'The credited position.'], MONEY_IN, IDEMPOTENCY],
    outputs: [['transactionRef', 'id', 'The resulting transaction.']],
    provider: 'PaymentProvider',
    after: ['limit', 'risk'],
    effect: 'moves',
    compensatedBy: 'ledger.reverse_journal',
    next,
    audit: [`transfer.${id}_executed`],
    events: ['financial.product.execution.step_completed'],
  });
}

const LEDGER_NEXT = ['ledger.*', 'fee.*', 'settlement.*', 'reconciliation.*', 'notification.*'];

const TRANSFER: BlockDefinition[] = [
  transferBlock('p2p', 'Person to person transfer', 'Moves value between two wallets on the platform.', LEDGER_NEXT),
  transferBlock('wallet_to_bank', 'Wallet to bank', 'Moves value out to an external account through a provider interface.', LEDGER_NEXT),
  transferBlock('bank_to_wallet', 'Bank to wallet', 'Moves value in from an external account through a provider interface.', LEDGER_NEXT),
  transferBlock('merchant_payment', 'Merchant payment', 'Moves value from a customer position to a merchant position.', LEDGER_NEXT),
  transferBlock('payout', 'Payout', 'Moves value from a platform position to a beneficiary.', LEDGER_NEXT),
  block('transfer', {
    id: 'bulk',
    name: 'Bulk transfer',
    description:
      'Submits many transfers as one instruction. Partial success is the normal case, and the output reports it per item rather than as a total.',
    inputs: [['batchRef', 'id', 'The submitted batch.'], IDEMPOTENCY],
    outputs: [
      ['acceptedCount', 'integer', 'How many were accepted.'],
      ['rejectedCount', 'integer', 'How many were refused, with reasons per item.'],
    ],
    provider: 'PaymentProvider',
    after: ['limit', 'risk'],
    effect: 'moves',
    compensatedBy: 'ledger.reverse_journal',
    next: LEDGER_NEXT,
    audit: ['transfer.bulk_submitted'],
  }),
];

// --- ledger -----------------------------------------------------------------

const LEDGER: BlockDefinition[] = [
  block('ledger', {
    id: 'create_journal',
    name: 'Create journal',
    description:
      'Posts a balanced journal. Debits equal credits per currency before anything posts, and never net across currencies.',
    inputs: [['entries', 'string', 'The entry set, each with an account, a direction and a positive amount.'], IDEMPOTENCY],
    outputs: [['journalRef', 'id', 'The posted journal.']],
    after: ['limit'],
    effect: 'moves',
    compensatedBy: 'ledger.reverse_journal',
    next: ['ledger.verify_balance', 'settlement.*', 'reconciliation.*', 'notification.*'],
    audit: ['ledger.journal_posted'],
  }),
  block('ledger', {
    id: 'debit_account',
    name: 'Debit account',
    description: 'One side of a movement. Amounts are positive; the direction carries the sign.',
    inputs: [['accountRef', 'id', 'The account.'], MONEY_IN],
    outputs: [['entryRef', 'id', 'The entry.']],
    after: ['limit'],
    effect: 'moves',
    compensatedBy: 'ledger.reverse_journal',
    next: ['ledger.credit_account', 'ledger.create_journal', 'ledger.verify_balance'],
  }),
  block('ledger', {
    id: 'credit_account',
    name: 'Credit account',
    description: 'The other side. A journal containing only one of these will not balance and will not post.',
    inputs: [['accountRef', 'id', 'The account.'], MONEY_IN],
    outputs: [['entryRef', 'id', 'The entry.']],
    after: ['limit'],
    effect: 'moves',
    compensatedBy: 'ledger.reverse_journal',
    next: ['ledger.debit_account', 'ledger.create_journal', 'ledger.verify_balance'],
  }),
  block('ledger', {
    id: 'reverse_journal',
    name: 'Reverse journal',
    description:
      'Corrects by posting the opposite journal. The original stands — there is no update and no delete, here or in the database.',
    inputs: [['journalRef', 'id', 'The journal to reverse.'], ['reasonCode', 'string', 'Why.'], IDEMPOTENCY],
    outputs: [['reversalRef', 'id', 'The reversing journal.']],
    after: ['ledger'],
    effect: 'moves',
    compensatedBy: 'ledger.reverse_journal',
    next: ['ledger.verify_balance', 'reconciliation.*', 'settlement.*', 'notification.*'],
    audit: ['ledger.journal_reversed'],
    classification: 'sensitive',
  }),
  block('ledger', {
    id: 'verify_balance',
    name: 'Verify balance',
    description: 'Recomputes a balance from entries and compares. The check that catches a ledger that has drifted.',
    inputs: [['accountRef', 'id', 'The account.']],
    outputs: [['balanced', 'boolean', 'Whether the recomputation agrees.'], ['difference', 'money', 'By how much, when it does not.']],
  }),
];

// --- fee --------------------------------------------------------------------

function feeBlock(id: string, name: string, description: string, configuration: BlockInput['configuration']): BlockDefinition {
  return block('fee', {
    id,
    name,
    description,
    inputs: [MONEY_IN],
    outputs: [
      ['fee', 'money', 'The computed fee.'],
      ['workings', 'string', 'How it was reached. Present so "why is this 2.47" has an answer nobody re-derives.'],
    ],
    configuration,
    next: ['ledger.*', 'wallet.*', 'payment.*', 'transfer.*', 'settlement.*'],
  });
}

const FEE: BlockDefinition[] = [
  feeBlock('flat', 'Flat fee', 'A fixed amount, independent of the transaction value.', [
    ['amount', 'money', 'The fee charged.'],
  ]),
  feeBlock('percentage', 'Percentage fee', 'A proportion of the transaction. The rate is an integer of hundredths of a basis point, never a float.', [
    ['rate', 'rate', 'Hundredths of a basis point. 0.5% is 5000.'],
  ]),
  feeBlock('tiered', 'Tiered fee', 'A rate that changes by band. Bands ascend, and the first match wins.', [
    ['tiers', 'string', 'Ascending bands, each with a lower bound and a rate or amount.'],
  ]),
  feeBlock('minimum', 'Minimum fee', 'A floor applied after the base calculation.', [
    ['floor', 'money', 'The smallest fee that may be charged.'],
  ]),
  feeBlock('maximum', 'Maximum fee', 'A cap applied after the base calculation.', [
    ['cap', 'money', 'The largest fee that may be charged.'],
  ]),
  feeBlock('waiver', 'Fee waiver', 'Removes a fee that would otherwise apply, and records that it was waived rather than never charged.', [
    ['reasonCode', 'string', 'Why the fee was waived.'],
  ]),
  feeBlock('promotional', 'Promotional fee', 'A time-boxed override. Expires by date; a promotion with no end never ends.', [
    ['rate', 'rate', 'The promotional rate.'],
    ['endsAt', 'timestamp', 'When the promotion stops applying.'],
  ]),
  block('fee', {
    id: 'revenue_share',
    name: 'Revenue share',
    description:
      'Splits a computed fee between counterparties. Allocation sums back to the original exactly — the remainder goes somewhere explicit, never to rounding.',
    inputs: [['fee', 'money', 'The fee to split.']],
    outputs: [['allocations', 'string', 'Each counterparty and its share, summing to the input.']],
    configuration: [['shares', 'string', 'Counterparties and weights.']],
    next: ['ledger.*', 'settlement.*'],
  }),
];

// --- limit ------------------------------------------------------------------

function limitBlock(id: string, name: string, description: string): BlockDefinition {
  return block('limit', {
    id,
    name,
    description,
    inputs: [MONEY_IN, ['subjectRef', 'id', 'Whose limit is being consumed.'], IDEMPOTENCY],
    outputs: [
      ['allowed', 'boolean', 'Whether the amount fits.'],
      ['remaining', 'money', 'What is left in the window after consumption.'],
    ],
    configuration: [['limitCode', 'reference', 'Which configured limit applies.', { referenceDomain: 'limitType' }]],
    after: ['identity'],
    effect: 'reserves',
    next: ['wallet.*', 'payment.*', 'transfer.*', 'ledger.*', 'lending.*', 'loyalty.*', 'fee.*', 'risk.*'],
    audit: ['limit.consumed', 'limit.refused'],
  });
}

const LIMIT: BlockDefinition[] = [
  limitBlock('transaction', 'Transaction limit', 'The largest single amount. Checked and consumed in one step, because checking and then posting reopens the race.'),
  limitBlock('daily', 'Daily limit', 'Cumulative within a calendar day in the tenant’s time zone — never the server’s, or a customer is refused at 00:30 for yesterday.'),
  limitBlock('monthly', 'Monthly limit', 'Cumulative within a calendar month.'),
  limitBlock('velocity', 'Velocity limit', 'A count within a rolling window. Catches the pattern an amount limit does not.'),
  limitBlock('wallet_balance', 'Wallet balance limit', 'The largest balance a wallet may hold. Refuses the credit that would breach it.'),
  limitBlock('product', 'Product limit', 'A ceiling across every customer of one product. The one that protects the platform rather than the customer.'),
];

// --- settlement -------------------------------------------------------------

const SETTLEMENT: BlockDefinition[] = [
  block('settlement', {
    id: 'create',
    name: 'Create settlement',
    description: 'Records an obligation to move money to a counterparty. Money leaves and lands in transit.',
    inputs: [['counterpartyRef', 'id', 'Who is owed.'], MONEY_IN, IDEMPOTENCY],
    outputs: [['settlementRef', 'id', 'The settlement.']],
    after: ['ledger'],
    effect: 'moves',
    compensatedBy: 'settlement.adjustment',
    next: ['settlement.create_batch', 'settlement.execute', 'reconciliation.*'],
    audit: ['settlement.created'],
  }),
  block('settlement', {
    id: 'create_batch',
    name: 'Create settlement batch',
    description: 'Groups settlements for one window. The batch is what a counterparty reconciles against.',
    inputs: [['windowStart', 'timestamp', 'Window opening.'], ['windowEnd', 'timestamp', 'Window closing.']],
    outputs: [['batchRef', 'id', 'The batch.'], ['total', 'money', 'The batch total.']],
    next: ['settlement.execute', 'settlement.status'],
    audit: ['settlement.batch_created'],
  }),
  block('settlement', {
    id: 'execute',
    name: 'Execute settlement',
    description:
      'Instructs the counterparty. Asynchronous by construction — the in-transit balance is exactly what has left and not arrived.',
    inputs: [['batchRef', 'id', 'The batch to settle.'], IDEMPOTENCY],
    outputs: [['instructionRef', 'id', 'The instruction sent.']],
    provider: 'SettlementProvider',
    after: ['settlement'],
    effect: 'moves',
    compensatedBy: 'settlement.adjustment',
    next: ['settlement.status', 'reconciliation.*', 'notification.*'],
    audit: ['settlement.executed'],
  }),
  block('settlement', {
    id: 'status',
    name: 'Settlement status',
    description: 'Reads where an instruction has reached. Safe to repeat, and the normal way a window is watched.',
    inputs: [['instructionRef', 'id', 'The instruction.']],
    outputs: [['status', 'string', 'Where it has reached.']],
    provider: 'SettlementProvider',
  }),
  block('settlement', {
    id: 'adjustment',
    name: 'Settlement adjustment',
    description: 'Corrects a settled amount by posting a new movement. Never by editing the batch.',
    inputs: [['settlementRef', 'id', 'What is being adjusted.'], MONEY_IN, ['reasonCode', 'string', 'Why.'], IDEMPOTENCY],
    outputs: [['adjustmentRef', 'id', 'The adjustment.']],
    after: ['settlement'],
    effect: 'moves',
    compensatedBy: 'settlement.adjustment',
    next: ['ledger.*', 'reconciliation.*', 'settlement.close', 'notification.*'],
    audit: ['settlement.adjusted'],
    classification: 'sensitive',
  }),
  block('settlement', {
    id: 'close',
    name: 'Settlement close',
    description:
      'Closes a window so nothing further posts into it. Refuses while reconciliation exceptions are open, when the policy says so.',
    inputs: [['batchRef', 'id', 'The batch to close.']],
    outputs: [['closed', 'boolean', 'Whether the window closed.'], ['blockingExceptions', 'integer', 'What is holding it open.']],
    after: ['reconciliation'],
    audit: ['settlement.closed'],
  }),
];

// --- reconciliation ---------------------------------------------------------

const RECONCILIATION: BlockDefinition[] = [
  block('reconciliation', {
    id: 'match',
    name: 'Match transaction',
    description:
      'Matches by reference first, then by amount and date within tolerance. Amount-only matching pairs two unrelated payments and reports a clean reconciliation.',
    inputs: [['statementRef', 'id', 'The external record.']],
    outputs: [['matched', 'boolean', 'Whether a counterpart was found.'], ['transactionRef', 'id', 'What it matched.']],
    next: ['reconciliation.identify_exception', 'reconciliation.report', 'settlement.close'],
  }),
  block('reconciliation', {
    id: 'identify_exception',
    name: 'Identify exception',
    description: 'Classifies a difference: missing here, missing there, amount differs, duplicated.',
    inputs: [['statementRef', 'id', 'The unmatched record.']],
    outputs: [['exceptionType', 'string', 'The classification.'], ['difference', 'money', 'By how much.']],
    next: ['reconciliation.queue_exception'],
  }),
  block('reconciliation', {
    id: 'queue_exception',
    name: 'Queue exception',
    description:
      'Puts a difference in front of a person. The output of reconciliation is a queue, not a number — "£3.42 out" is not actionable.',
    inputs: [['exceptionRef', 'id', 'The exception.']],
    outputs: [['queued', 'boolean', 'Whether it was queued.']],
    audit: ['reconciliation.exception_queued'],
  }),
  block('reconciliation', {
    id: 'resolve_exception',
    name: 'Resolve exception',
    description: 'Records how a difference was settled, and by whom. Resolution is a decision, so it is audited as one.',
    inputs: [['exceptionRef', 'id', 'The exception.'], ['resolutionCode', 'string', 'How it was resolved.']],
    outputs: [['resolved', 'boolean', 'Whether it closed.']],
    permissions: ['financial.product.execute'],
    audit: ['reconciliation.exception_resolved'],
    classification: 'sensitive',
  }),
  block('reconciliation', {
    id: 'report',
    name: 'Generate reconciliation report',
    description: 'Summarises a window: matched, unmatched, exceptions open and their ages.',
    inputs: [['windowStart', 'timestamp', 'Window opening.'], ['windowEnd', 'timestamp', 'Window closing.']],
    outputs: [['reportRef', 'id', 'The generated report.']],
  }),
];

// --- lending ----------------------------------------------------------------

const LENDING: BlockDefinition[] = [
  block('lending', {
    id: 'check_eligibility',
    name: 'Check eligibility',
    description: 'Decides whether a borrower may be offered credit under this product’s declared criteria.',
    inputs: [CUSTOMER_REF, MONEY_IN],
    outputs: [['eligible', 'boolean', 'Whether to proceed.'], ['reasonCode', 'string', 'Why not, when not.']],
    after: ['identity'],
    classification: 'sensitive',
  }),
  block('lending', {
    id: 'credit_assessment',
    name: 'Credit assessment hook',
    description:
      'The seam where a credit decision comes from outside. The framework ships no scoring model — one shipped here would be a wrong one everybody believed.',
    inputs: [CUSTOMER_REF],
    outputs: [['score', 'integer', 'The returned score.'], ['band', 'string', 'The band the provider assigned.']],
    provider: 'CreditProvider',
    classification: 'restricted',
  }),
  block('lending', {
    id: 'loan_offer',
    name: 'Loan offer',
    description: 'Produces a priced offer with an expiry. An offer with no expiry is a price guaranteed forever.',
    inputs: [CUSTOMER_REF, MONEY_IN],
    outputs: [['offerRef', 'id', 'The offer.'], ['expiresAt', 'timestamp', 'When the price lapses.']],
    next: ['lending.repayment_schedule', 'lending.disburse', 'risk.*'],
    audit: ['lending.offer_made'],
    classification: 'sensitive',
  }),
  block('lending', {
    id: 'calculate_interest',
    name: 'Calculate interest',
    description: 'Computes interest for a period with an explicit day-count and rounding. Never floating point.',
    inputs: [['principal', 'money', 'The outstanding principal.'], ['days', 'integer', 'The period.']],
    outputs: [['interest', 'money', 'The computed interest.'], ['workings', 'string', 'The day-count and rate used.']],
    configuration: [['rate', 'rate', 'The annual rate, in hundredths of a basis point.']],
  }),
  block('lending', {
    id: 'repayment_schedule',
    name: 'Generate repayment schedule',
    description: 'Produces instalments that sum back to principal plus interest exactly. The remainder lands on a stated instalment.',
    inputs: [['offerRef', 'id', 'The accepted offer.']],
    outputs: [['scheduleRef', 'id', 'The schedule.'], ['instalmentCount', 'integer', 'How many.']],
    next: ['lending.disburse'],
  }),
  block('lending', {
    id: 'disburse',
    name: 'Disburse',
    description: 'Moves the principal to the borrower. The point at which the platform is exposed.',
    inputs: [['offerRef', 'id', 'The accepted offer.'], MONEY_IN, IDEMPOTENCY],
    outputs: [['loanRef', 'id', 'The loan.'], ['transactionRef', 'id', 'The disbursement.']],
    after: ['limit', 'risk'],
    effect: 'moves',
    compensatedBy: 'ledger.reverse_journal',
    next: ['ledger.*', 'notification.*'],
    audit: ['lending.disbursed'],
    classification: 'sensitive',
  }),
  block('lending', {
    id: 'repay',
    name: 'Repay',
    description: 'Applies a repayment against the schedule in a declared order — penalty, interest, principal, or as configured.',
    inputs: [['loanRef', 'id', 'The loan.'], MONEY_IN, IDEMPOTENCY],
    outputs: [['appliedTo', 'string', 'How the payment was allocated.'], ['outstanding', 'money', 'What remains.']],
    after: ['limit'],
    effect: 'moves',
    compensatedBy: 'ledger.reverse_journal',
    next: ['ledger.*', 'lending.apply_penalty', 'notification.*'],
    audit: ['lending.repaid'],
  }),
  block('lending', {
    id: 'apply_penalty',
    name: 'Apply penalty',
    description: 'Charges for a missed instalment, under a declared and capped policy.',
    inputs: [['loanRef', 'id', 'The loan.'], ['daysLate', 'integer', 'How late.']],
    outputs: [['penalty', 'money', 'The charge.']],
    after: ['lending'],
    effect: 'moves',
    compensatedBy: 'ledger.reverse_journal',
    next: ['ledger.*', 'lending.trigger_collection', 'notification.*'],
    audit: ['lending.penalty_applied'],
    classification: 'sensitive',
  }),
  block('lending', {
    id: 'trigger_collection',
    name: 'Trigger collection',
    description:
      'Hands an overdue loan to a collections process. A trigger, not a process — collections is a product, and the rules differ by jurisdiction.',
    inputs: [['loanRef', 'id', 'The loan.']],
    outputs: [['caseRef', 'id', 'The opened case.']],
    audit: ['lending.collection_triggered'],
    classification: 'restricted',
  }),
];

// --- risk -------------------------------------------------------------------

function riskCheck(id: string, name: string, description: string, classification: 'sensitive' | 'restricted'): BlockDefinition {
  return block('risk', {
    id,
    name,
    description,
    inputs: [CUSTOMER_REF, MONEY_IN],
    outputs: [
      ['outcome', 'enum', 'The check result.', { values: ['clear', 'review', 'refuse'] }],
      ['reasonCode', 'string', 'Why, in a stable code the channel can map.'],
    ],
    provider: 'RiskProvider',
    next: ['risk.*', 'payment.*', 'transfer.*', 'wallet.*', 'lending.*', 'limit.*', 'ledger.*'],
    audit: [`risk.${id}_performed`],
    classification,
  });
}

const RISK: BlockDefinition[] = [
  riskCheck('aml_check', 'AML check', 'Screens against the deployment’s anti-money-laundering rules through a provider interface. The framework ships no rule set and no list.', 'restricted'),
  riskCheck('fraud_check', 'Fraud check', 'Scores the transaction for fraud through a provider interface. A score, never a verdict this layer invents.', 'sensitive'),
  riskCheck('sanctions_check', 'Sanctions check', 'Screens against sanctions lists a deployment licenses. Shipping a list here would produce deployments that believed they were screened.', 'restricted'),
  riskCheck('pep_check', 'PEP check', 'Screens for politically exposed persons through a provider interface.', 'restricted'),
  block('risk', {
    id: 'score',
    name: 'Risk score',
    description: 'Combines available signals into a single score. A heuristic, and named as one — it reduces a rate, it does not eliminate anything.',
    inputs: [CUSTOMER_REF, MONEY_IN],
    outputs: [['score', 'integer', 'Zero to one hundred.'], ['level', 'reference', 'The banded level.', { referenceDomain: 'riskLevel' }]],
    provider: 'RiskProvider',
    next: ['risk.*', 'payment.*', 'transfer.*', 'limit.*', 'lending.*'],
    classification: 'sensitive',
  }),
  block('risk', {
    id: 'enhanced_review',
    name: 'Enhanced review',
    description:
      'Holds the execution until a reviewer decides. The execution pauses; it does not proceed optimistically and reverse later.',
    inputs: [['reasonCode', 'string', 'What triggered the review.']],
    outputs: [['decision', 'enum', 'The reviewer’s decision.', { values: ['approved', 'rejected'] }] as never],
    permissions: ['financial.product.approve'],
    next: ['payment.*', 'transfer.*', 'wallet.*', 'lending.*', 'notification.*'],
    audit: ['risk.enhanced_review_decided'],
    events: ['financial.product.review.required'],
    classification: 'sensitive',
  }),
  block('risk', {
    id: 'manual_review',
    name: 'Manual review',
    description: 'A person looks at it. Distinct from enhanced review: a different queue, a different permission, a different SLA.',
    inputs: [['reasonCode', 'string', 'Why it was routed here.']],
    outputs: [['decision', 'enum', 'The reviewer’s decision.', { values: ['approved', 'rejected'] }] as never],
    permissions: ['financial.product.approve'],
    audit: ['risk.manual_review_decided'],
    events: ['financial.product.review.required'],
    classification: 'sensitive',
  }),
  block('risk', {
    id: 'compliance_approval',
    name: 'Compliance approval',
    description: 'A compliance officer signs off. The approver is never the submitter — the runtime refuses it.',
    inputs: [['reasonCode', 'string', 'What needs approving.']],
    outputs: [['decision', 'enum', 'The decision.', { values: ['approved', 'rejected'] }] as never],
    permissions: ['financial.product.approve'],
    audit: ['risk.compliance_approved', 'risk.compliance_rejected'],
    classification: 'restricted',
  }),
];

// --- loyalty ----------------------------------------------------------------

const LOYALTY: BlockDefinition[] = [
  block('loyalty', {
    id: 'member_account',
    name: 'Member account',
    description: 'Opens a points position. Points are a liability like any other customer balance, and are ledgered as one.',
    inputs: [CUSTOMER_REF],
    outputs: [['memberRef', 'id', 'The member position.']],
    next: ['loyalty.*', 'notification.*'],
    audit: ['loyalty.member_created'],
  }),
  block('loyalty', {
    id: 'earn',
    name: 'Earn points',
    description: 'Credits points against a rule. Idempotent, because an earn replayed on a retry doubles somebody’s balance.',
    inputs: [['memberRef', 'id', 'The member.'], ['points', 'integer', 'How many.'], IDEMPOTENCY],
    outputs: [['balance', 'integer', 'The balance after earning.']],
    after: ['limit'],
    effect: 'moves',
    compensatedBy: 'ledger.reverse_journal',
    next: ['ledger.*', 'loyalty.*', 'notification.*'],
    audit: ['loyalty.earned'],
  }),
  block('loyalty', {
    id: 'redeem',
    name: 'Redeem points',
    description: 'Debits points for value. Checks the available balance, never the total — an expiring hold is not spendable.',
    inputs: [['memberRef', 'id', 'The member.'], ['points', 'integer', 'How many.'], IDEMPOTENCY],
    outputs: [['balance', 'integer', 'The balance after redemption.']],
    after: ['limit'],
    effect: 'moves',
    compensatedBy: 'ledger.reverse_journal',
    next: ['ledger.*', 'loyalty.*', 'notification.*'],
    audit: ['loyalty.redeemed'],
  }),
  block('loyalty', {
    id: 'expire',
    name: 'Expire points',
    description: 'Removes points that have aged out, oldest first, and records what expired rather than adjusting a total.',
    inputs: [['memberRef', 'id', 'The member.'], ['asOf', 'timestamp', 'The expiry date being applied.'], IDEMPOTENCY],
    outputs: [['expired', 'integer', 'How many expired.']],
    after: ['limit'],
    effect: 'moves',
    compensatedBy: 'ledger.reverse_journal',
    next: ['ledger.*', 'notification.*'],
    audit: ['loyalty.expired'],
  }),
  block('loyalty', {
    id: 'transfer',
    name: 'Transfer points',
    description: 'Moves points between members. Both sides post, or neither does.',
    inputs: [['fromRef', 'id', 'The sending member.'], ['toRef', 'id', 'The receiving member.'], ['points', 'integer', 'How many.'], IDEMPOTENCY],
    outputs: [['transactionRef', 'id', 'The transfer.']],
    after: ['limit'],
    effect: 'moves',
    compensatedBy: 'ledger.reverse_journal',
    next: ['ledger.*', 'notification.*'],
    audit: ['loyalty.transferred'],
  }),
  block('loyalty', {
    id: 'campaign_reward',
    name: 'Campaign reward',
    description: 'Applies a time-boxed campaign multiplier. Campaigns expire by date; one without an end date never ends.',
    inputs: [['memberRef', 'id', 'The member.'], ['campaignCode', 'string', 'Which campaign.']],
    outputs: [['multiplier', 'rate', 'The applied multiplier.']],
    configuration: [['endsAt', 'timestamp', 'When the campaign stops applying.']],
  }),
];

// --- notification -----------------------------------------------------------

const NOTIFICATION: BlockDefinition[] = [
  block('notification', {
    id: 'send',
    name: 'Send notification',
    description:
      'Tells somebody what happened, through a provider interface. Carries a template code and references — never an amount, a balance or a personal detail, because a notification body reaches a third-party gateway.',
    inputs: [['recipientRef', 'id', 'Who to tell.'], ['templateCode', 'string', 'Which message.']],
    outputs: [['dispatched', 'boolean', 'Whether it was handed off.']],
    provider: 'NotificationProvider',
    next: [],
    audit: ['notification.dispatched'],
  }),
  block('notification', {
    id: 'acknowledge',
    name: 'Acknowledge',
    description: 'Records that a notification was delivered or read. Never blocks an execution — delivery is best effort.',
    inputs: [['notificationRef', 'id', 'The notification.']],
    outputs: [['acknowledged', 'boolean', 'Whether it was acknowledged.']],
  }),
];

/** Every approved block, in catalog order. */
export const BLOCK_CATALOG: readonly BlockDefinition[] = Object.freeze([
  ...IDENTITY,
  ...WALLET,
  ...PAYMENT,
  ...TRANSFER,
  ...LEDGER,
  ...FEE,
  ...LIMIT,
  ...SETTLEMENT,
  ...RECONCILIATION,
  ...LENDING,
  ...RISK,
  ...LOYALTY,
  ...NOTIFICATION,
]);
