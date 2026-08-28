/**
 * The industry template catalog, as data.
 *
 * Every template in `templates/` is generated from one entry here by
 * `scaffold-industry-templates.mjs`. That is a deliberate choice and it is the same argument the
 * framework makes everywhere else: twenty-four hand-written templates are identical on the day
 * they are written and quietly different a year later, and the difference is never the domain —
 * it is the tenant scope somebody forgot, the audit call somebody dropped, the isolation test
 * somebody did not copy.
 *
 * So the *shape* is generated and the *domain* is authored. What is in this file is the part that
 * genuinely differs per industry: the entities, their fields, the permissions, the screens, and
 * what each template deliberately does not do. What is not in this file — the tenant scope, the
 * audit trail, the isolation test, the permission wiring — is generated identically for all of
 * them, because there is exactly one correct version of each.
 *
 * Field types map to Prisma and to the template SDK's form fields:
 *
 *   text · longtext · slug · email · phone · int · money · bool · date · datetime · json
 *   enum:NAME · ref:Entity (a scalar id, never a Prisma relation across the framework boundary)
 *
 * `money` becomes `Decimal @db.Decimal(28, 8)` and a string in TypeScript. Never a Float, never a
 * number — Phase 8's rule, and the validator fails a template that breaks it.
 */

/** Modules every industry template needs on top of the base and tenant sets. */
const SDK = ['template-sdk'];

/** The financial platform, for a template that moves money. */
const MONEY = ['financial-core', 'ledger', 'accounts', 'wallet', 'limits', 'transactions'];

/** The workflow engine and what it reports through. */
const FLOW = [
  'authorization',
  'security-policy',
  'security-events',
  'workflow-core',
  'workflow-definition',
  'workflow-runtime',
  'workflow-approvals',
  'workflow-tasks',
  'workflow-history',
  'workflow-policy',
];

export const TEMPLATE_SPECS = [
  // ===========================================================================
  // Commerce
  // ===========================================================================
  {
    id: 'ecommerce',
    extends: 'merchant',
    displayName: 'TrustOS E-commerce',
    category: 'commerce',
    status: 'experimental',
    owner: 'TrustOS Commerce Team',
    description:
      'Catalog, cart and orders on top of the merchant structure: products, variants, carts, ' +
      'orders and order lines, with an admin console over all of them.',
    modules: [...SDK, 'financial-core'],
    outOfScope: [
      'payment providers',
      'shipping carriers',
      'tax engines',
      'inventory reservation',
      'promotions',
    ],
    migrationNotes:
      'Initial release. Extends merchant, so a generated project has merchants, stores and ' +
      'branches underneath the catalog. Order totals are stored, not recomputed on read — see ' +
      'the comment on Order.total before changing that.',
    entities: [
      {
        name: 'Catalog',
        label: 'Catalogs',
        singular: 'Catalog',
        description: 'A set of products offered by a store.',
        fields: [
          { name: 'storeId', type: 'ref:Store', label: 'Store', required: true },
          { name: 'name', type: 'text', label: 'Name', required: true, search: true },
          { name: 'code', type: 'slug', label: 'Code', required: true, unique: true, immutable: true },
          { name: 'isDefault', type: 'bool', label: 'Default', default: 'false' },
        ],
      },
      {
        name: 'Product',
        label: 'Products',
        singular: 'Product',
        description: 'Something a customer can buy. Variants carry the price.',
        fields: [
          { name: 'catalogId', type: 'ref:Catalog', label: 'Catalog', required: true },
          { name: 'name', type: 'text', label: 'Name', required: true, search: true },
          { name: 'sku', type: 'text', label: 'SKU', required: true, unique: true, search: true, prefix: true },
          { name: 'description', type: 'longtext', label: 'Description' },
          { name: 'status', type: 'enum:ProductStatus', label: 'Status', default: 'DRAFT', filter: true },
        ],
        enums: { ProductStatus: ['DRAFT', 'ACTIVE', 'ARCHIVED'] },
      },
      {
        name: 'ProductVariant',
        label: 'Variants',
        singular: 'Variant',
        description: 'A buyable configuration of a product, with its own price.',
        fields: [
          { name: 'productId', type: 'ref:Product', label: 'Product', required: true },
          { name: 'name', type: 'text', label: 'Variant', required: true },
          { name: 'sku', type: 'text', label: 'SKU', required: true, unique: true },
          { name: 'price', type: 'money', label: 'Price', required: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true, default: '"USD"' },
          { name: 'isActive', type: 'bool', label: 'Active', default: 'true', filter: true },
        ],
      },
      {
        name: 'Order',
        label: 'Orders',
        singular: 'Order',
        description:
          'A customer purchase. `total` is stored rather than summed on read: an order is what ' +
          'was agreed at the time, and recomputing it from current prices rewrites history.',
        fields: [
          { name: 'storeId', type: 'ref:Store', label: 'Store', required: true },
          { name: 'reference', type: 'text', label: 'Reference', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'customerName', type: 'text', label: 'Customer', required: true, search: true },
          { name: 'customerPhone', type: 'phone', label: 'Phone' },
          { name: 'status', type: 'enum:OrderStatus', label: 'Status', default: 'PENDING', filter: true },
          { name: 'total', type: 'money', label: 'Total', required: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true, default: '"USD"' },
          { name: 'placedAt', type: 'datetime', label: 'Placed', required: true, filter: true },
        ],
        enums: { OrderStatus: ['PENDING', 'CONFIRMED', 'FULFILLED', 'CANCELLED', 'REFUNDED'] },
      },
      {
        name: 'OrderLine',
        label: 'Order lines',
        singular: 'Order line',
        description:
          'One product on an order, priced as it was when the order was placed. The variant may ' +
          'change afterwards; the line does not.',
        fields: [
          { name: 'orderId', type: 'ref:Order', label: 'Order', required: true },
          { name: 'variantId', type: 'ref:ProductVariant', label: 'Variant', required: true },
          { name: 'description', type: 'text', label: 'Description', required: true },
          { name: 'quantity', type: 'int', label: 'Quantity', required: true, default: '1' },
          { name: 'unitPrice', type: 'money', label: 'Unit price', required: true },
          { name: 'lineTotal', type: 'money', label: 'Line total', required: true },
        ],
      },
    ],
  },

  {
    id: 'marketplace',
    extends: 'ecommerce',
    displayName: 'TrustOS Marketplace',
    category: 'commerce',
    status: 'experimental',
    owner: 'TrustOS Commerce Team',
    description:
      'Multi-seller commerce on top of the e-commerce catalog: sellers, listings, commission ' +
      'rules, seller payouts and disputes.',
    modules: [...SDK, 'financial-core', 'fees'],
    outOfScope: [
      'payment providers',
      'seller KYC providers',
      'shipping carriers',
      'ratings and reviews',
      'automated payout execution',
    ],
    migrationNotes:
      'Initial release. Extends e-commerce, which extends merchant. A payout is recorded, not ' +
      'executed — wiring an actual disbursement is a product decision, and the seam is ' +
      'SellerPayout.status.',
    entities: [
      {
        name: 'Seller',
        label: 'Sellers',
        singular: 'Seller',
        description: 'A third party selling through the marketplace.',
        fields: [
          { name: 'merchantId', type: 'ref:Merchant', label: 'Merchant', required: true },
          { name: 'displayName', type: 'text', label: 'Seller', required: true, search: true },
          { name: 'code', type: 'slug', label: 'Code', required: true, unique: true, immutable: true },
          { name: 'status', type: 'enum:SellerStatus', label: 'Status', default: 'ONBOARDING', filter: true },
          { name: 'commissionRate', type: 'text', label: 'Commission', required: true, default: '"0.1000"' },
          { name: 'payoutCurrency', type: 'text', label: 'Currency', required: true, default: '"USD"' },
        ],
        enums: { SellerStatus: ['ONBOARDING', 'ACTIVE', 'SUSPENDED', 'CLOSED'] },
      },
      {
        name: 'Listing',
        label: 'Listings',
        singular: 'Listing',
        description: 'A seller offering a product variant at their own price.',
        fields: [
          { name: 'sellerId', type: 'ref:Seller', label: 'Seller', required: true },
          { name: 'variantId', type: 'ref:ProductVariant', label: 'Variant', required: true },
          { name: 'price', type: 'money', label: 'Price', required: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true, default: '"USD"' },
          { name: 'stockOnHand', type: 'int', label: 'Stock', default: '0' },
          { name: 'isActive', type: 'bool', label: 'Active', default: 'true', filter: true },
        ],
      },
      {
        name: 'SellerPayout',
        label: 'Payouts',
        singular: 'Payout',
        description:
          'What is owed to a seller for a period. Recorded here and executed elsewhere — the ' +
          'framework has a settlement package for the execution, and this template does not ' +
          'assume which rail.',
        fields: [
          { name: 'sellerId', type: 'ref:Seller', label: 'Seller', required: true },
          { name: 'reference', type: 'text', label: 'Reference', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'periodStart', type: 'date', label: 'From', required: true },
          { name: 'periodEnd', type: 'date', label: 'To', required: true },
          { name: 'grossAmount', type: 'money', label: 'Gross', required: true },
          { name: 'commissionAmount', type: 'money', label: 'Commission', required: true },
          { name: 'netAmount', type: 'money', label: 'Net', required: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true, default: '"USD"' },
          { name: 'status', type: 'enum:PayoutStatus', label: 'Status', default: 'DRAFT', filter: true },
        ],
        enums: { PayoutStatus: ['DRAFT', 'APPROVED', 'PAID', 'FAILED'] },
      },
      {
        name: 'Dispute',
        label: 'Disputes',
        singular: 'Dispute',
        description: 'A buyer contesting an order.',
        fields: [
          { name: 'orderId', type: 'ref:Order', label: 'Order', required: true },
          { name: 'sellerId', type: 'ref:Seller', label: 'Seller', required: true },
          { name: 'reason', type: 'longtext', label: 'Reason', required: true },
          { name: 'status', type: 'enum:DisputeStatus', label: 'Status', default: 'OPEN', filter: true },
          { name: 'resolutionNote', type: 'longtext', label: 'Resolution' },
          { name: 'openedAt', type: 'datetime', label: 'Opened', required: true },
        ],
        enums: { DisputeStatus: ['OPEN', 'INVESTIGATING', 'RESOLVED', 'REJECTED'] },
      },
    ],
  },

  {
    id: 'gold-shop',
    displayName: 'TrustOS Gold Shop',
    category: 'commerce',
    status: 'experimental',
    owner: 'TrustOS Commerce Team',
    description:
      'Gold retail: weighted inventory, a pricing interface fed by whatever quote source a ' +
      'deployment has, customer orders, invoices and transaction history.',
    modules: [...SDK, 'financial-core'],
    outOfScope: [
      'live gold price feeds',
      'payment providers',
      'assay certification',
      'hedging',
      'customs and export documentation',
    ],
    migrationNotes:
      'Initial release. GoldPrice is a *recorded quote*, not a feed: a deployment writes rows ' +
      'from whatever source it has, and every order references the quote it was priced at. ' +
      'Weights are Decimal for the same reason amounts are — a gram of gold is worth enough that ' +
      'a rounding error is a real loss.',
    entities: [
      {
        name: 'GoldPrice',
        label: 'Price quotes',
        singular: 'Price quote',
        description:
          'A quote at a moment. Immutable once written: an order priced against a quote that ' +
          'was later edited cannot be reconciled with anything.',
        fields: [
          { name: 'karat', type: 'enum:GoldKarat', label: 'Karat', required: true, filter: true },
          { name: 'pricePerGram', type: 'money', label: 'Price / gram', required: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true, default: '"USD"' },
          { name: 'source', type: 'text', label: 'Source', required: true },
          { name: 'quotedAt', type: 'datetime', label: 'Quoted at', required: true, filter: true },
        ],
        enums: { GoldKarat: ['K10', 'K14', 'K18', 'K21', 'K22', 'K24'] },
      },
      {
        name: 'GoldItem',
        label: 'Inventory',
        singular: 'Item',
        description: 'A physical piece held in stock, identified by its tag.',
        fields: [
          { name: 'tag', type: 'text', label: 'Tag', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'name', type: 'text', label: 'Item', required: true, search: true },
          { name: 'karat', type: 'enum:GoldKarat', label: 'Karat', required: true, filter: true },
          { name: 'grossWeightGrams', type: 'money', label: 'Gross (g)', required: true },
          { name: 'goldWeightGrams', type: 'money', label: 'Gold (g)', required: true },
          { name: 'labourCost', type: 'money', label: 'Labour', required: true, default: '0' },
          { name: 'currency', type: 'text', label: 'Currency', required: true, default: '"USD"' },
          { name: 'status', type: 'enum:GoldItemStatus', label: 'Status', default: 'IN_STOCK', filter: true },
        ],
        enums: { GoldItemStatus: ['IN_STOCK', 'RESERVED', 'SOLD', 'MELTED'] },
      },
      {
        name: 'GoldOrder',
        label: 'Orders',
        singular: 'Order',
        description: 'A customer buying or selling back a piece, priced against a recorded quote.',
        fields: [
          { name: 'reference', type: 'text', label: 'Reference', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'itemId', type: 'ref:GoldItem', label: 'Item', required: true },
          { name: 'priceId', type: 'ref:GoldPrice', label: 'Quote', required: true },
          { name: 'direction', type: 'enum:GoldOrderDirection', label: 'Direction', required: true, filter: true },
          { name: 'customerName', type: 'text', label: 'Customer', required: true, search: true },
          { name: 'customerPhone', type: 'phone', label: 'Phone' },
          { name: 'goldValue', type: 'money', label: 'Gold value', required: true },
          { name: 'labourCost', type: 'money', label: 'Labour', required: true, default: '0' },
          { name: 'total', type: 'money', label: 'Total', required: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true, default: '"USD"' },
          { name: 'status', type: 'enum:GoldOrderStatus', label: 'Status', default: 'DRAFT', filter: true },
        ],
        enums: {
          GoldOrderDirection: ['SELL_TO_CUSTOMER', 'BUY_FROM_CUSTOMER'],
          GoldOrderStatus: ['DRAFT', 'CONFIRMED', 'SETTLED', 'CANCELLED'],
        },
      },
      {
        name: 'GoldInvoice',
        label: 'Invoices',
        singular: 'Invoice',
        description: 'The document issued for an order.',
        fields: [
          { name: 'orderId', type: 'ref:GoldOrder', label: 'Order', required: true },
          { name: 'number', type: 'text', label: 'Number', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'issuedAt', type: 'datetime', label: 'Issued', required: true, filter: true },
          { name: 'total', type: 'money', label: 'Total', required: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true, default: '"USD"' },
          { name: 'status', type: 'enum:GoldInvoiceStatus', label: 'Status', default: 'ISSUED', filter: true },
        ],
        enums: { GoldInvoiceStatus: ['ISSUED', 'PAID', 'VOID'] },
      },
    ],
  },

  // ===========================================================================
  // Financial services
  // ===========================================================================
  {
    id: 'wallet',
    displayName: 'TrustOS Wallet',
    category: 'financial-services',
    status: 'experimental',
    owner: 'TrustOS Financial Team',
    description:
      'Customer wallets over the framework ledger: wallet profiles, transfers, transfer limits ' +
      'and history. Balances come from @trustos/wallet — this template stores no balance column.',
    modules: [...SDK, ...MONEY],
    outOfScope: [
      'payment providers',
      'card issuing',
      'cash-in and cash-out networks',
      'FX execution',
      'interest and rewards',
    ],
    migrationNotes:
      'Initial release. There is deliberately no balance column anywhere in this schema: ' +
      '@trustos/wallet computes it from the ledger, and a cached copy is the one thing that ' +
      'makes two sources of truth. WalletProfile is the *product* record; the money lives in the ' +
      'framework.',
    entities: [
      {
        name: 'WalletProfile',
        label: 'Wallets',
        singular: 'Wallet',
        description:
          'The product-side record of a wallet. `walletId` points at the framework wallet that ' +
          'owns the money; everything financial is read through @trustos/wallet.',
        fields: [
          { name: 'walletId', type: 'text', label: 'Wallet id', required: true, unique: true, immutable: true },
          { name: 'ownerName', type: 'text', label: 'Owner', required: true, search: true },
          { name: 'ownerPhone', type: 'phone', label: 'Phone', search: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true, immutable: true, filter: true },
          { name: 'tier', type: 'enum:WalletTier', label: 'Tier', default: 'BASIC', filter: true },
          { name: 'status', type: 'enum:WalletProfileStatus', label: 'Status', default: 'ACTIVE', filter: true },
        ],
        enums: {
          WalletTier: ['BASIC', 'VERIFIED', 'PREMIUM'],
          WalletProfileStatus: ['ACTIVE', 'FROZEN', 'CLOSED'],
        },
      },
      {
        name: 'WalletTransfer',
        label: 'Transfers',
        singular: 'Transfer',
        description:
          'A movement between two wallets. The journal is written by @trustos/ledger; this row ' +
          'is the product-level record of *why*, and `journalId` is the link between them.',
        fields: [
          { name: 'reference', type: 'text', label: 'Reference', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'fromProfileId', type: 'ref:WalletProfile', label: 'From', required: true },
          { name: 'toProfileId', type: 'ref:WalletProfile', label: 'To', required: true },
          { name: 'amount', type: 'money', label: 'Amount', required: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true },
          { name: 'journalId', type: 'text', label: 'Journal', immutable: true },
          { name: 'status', type: 'enum:TransferStatus', label: 'Status', default: 'PENDING', filter: true },
          { name: 'note', type: 'text', label: 'Note' },
        ],
        enums: { TransferStatus: ['PENDING', 'POSTED', 'FAILED', 'REVERSED'] },
      },
      {
        name: 'TransferLimitProfile',
        label: 'Limit profiles',
        singular: 'Limit profile',
        description:
          'Which framework limit keys apply to a wallet tier. The ceilings themselves live in ' +
          '@trustos/limits — this maps tiers onto them so a tier change is one row, not a ' +
          'migration.',
        fields: [
          { name: 'tier', type: 'enum:WalletTier', label: 'Tier', required: true, unique: true },
          { name: 'limitKey', type: 'text', label: 'Limit key', required: true },
          { name: 'description', type: 'text', label: 'Description', required: true },
        ],
      },
    ],
  },

  {
    id: 'digital-bank',
    extends: 'wallet',
    displayName: 'TrustOS Digital Bank',
    category: 'financial-services',
    status: 'experimental',
    owner: 'TrustOS Financial Team',
    description:
      'A retail banking front end over the wallet template: customers, accounts, statements and ' +
      'notification preferences. No core banking system is implemented or assumed.',
    modules: [...SDK, ...MONEY, 'financial-reporting'],
    outOfScope: [
      'core banking',
      'card issuing',
      'clearing and settlement rails',
      'credit scoring',
      'regulatory reporting',
    ],
    migrationNotes:
      'Initial release. Extends wallet. A BankAccount is a customer-facing wrapper over a ' +
      'framework wallet — it holds the account number and the product terms, never a balance. ' +
      'Statements are generated from the ledger on demand, which is why AccountStatement stores ' +
      'a window and a total rather than a list of lines.',
    entities: [
      {
        name: 'BankCustomer',
        label: 'Customers',
        singular: 'Customer',
        description: 'A person or business the bank holds a relationship with.',
        fields: [
          { name: 'customerNumber', type: 'text', label: 'Customer no.', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'fullName', type: 'text', label: 'Name', required: true, search: true },
          { name: 'email', type: 'email', label: 'Email' },
          { name: 'phone', type: 'phone', label: 'Phone', search: true },
          { name: 'segment', type: 'enum:CustomerSegment', label: 'Segment', default: 'RETAIL', filter: true },
          { name: 'status', type: 'enum:BankCustomerStatus', label: 'Status', default: 'ACTIVE', filter: true },
          { name: 'onboardedAt', type: 'datetime', label: 'Onboarded', required: true },
        ],
        enums: {
          CustomerSegment: ['RETAIL', 'SME', 'CORPORATE'],
          BankCustomerStatus: ['PENDING', 'ACTIVE', 'DORMANT', 'CLOSED'],
        },
      },
      {
        name: 'BankAccount',
        label: 'Accounts',
        singular: 'Account',
        description:
          'A customer-facing account. The money is in the framework wallet named by ' +
          '`profileId`; this row carries the account number and the product terms.',
        fields: [
          { name: 'customerId', type: 'ref:BankCustomer', label: 'Customer', required: true },
          { name: 'profileId', type: 'ref:WalletProfile', label: 'Wallet', required: true },
          { name: 'accountNumber', type: 'text', label: 'Account no.', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'productName', type: 'text', label: 'Product', required: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true, immutable: true, filter: true },
          { name: 'status', type: 'enum:BankAccountStatus', label: 'Status', default: 'ACTIVE', filter: true },
          { name: 'openedAt', type: 'datetime', label: 'Opened', required: true },
        ],
        enums: { BankAccountStatus: ['ACTIVE', 'FROZEN', 'DORMANT', 'CLOSED'] },
      },
      {
        name: 'AccountStatement',
        label: 'Statements',
        singular: 'Statement',
        description:
          'A generated statement for a window. Half-open `[from, to)`, the same convention the ' +
          'ledger uses for accounting periods — an inclusive end double-counts the boundary.',
        fields: [
          { name: 'accountId', type: 'ref:BankAccount', label: 'Account', required: true },
          { name: 'periodStart', type: 'datetime', label: 'From', required: true },
          { name: 'periodEnd', type: 'datetime', label: 'To', required: true },
          { name: 'openingBalance', type: 'money', label: 'Opening', required: true },
          { name: 'closingBalance', type: 'money', label: 'Closing', required: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true },
          { name: 'generatedAt', type: 'datetime', label: 'Generated', required: true },
          { name: 'status', type: 'enum:StatementStatus', label: 'Status', default: 'GENERATED', filter: true },
        ],
        enums: { StatementStatus: ['GENERATED', 'DELIVERED', 'FAILED'] },
      },
      {
        name: 'CustomerNotificationPreference',
        label: 'Notification preferences',
        singular: 'Preference',
        description:
          'Which channels a customer has muted. Security notifications ignore this — see the ' +
          '`optional` flag in @trustos/template-sdk.',
        fields: [
          { name: 'customerId', type: 'ref:BankCustomer', label: 'Customer', required: true },
          { name: 'channel', type: 'enum:NotificationChannelName', label: 'Channel', required: true },
          { name: 'muted', type: 'bool', label: 'Muted', default: 'false' },
        ],
        enums: { NotificationChannelName: ['IN_APP', 'EMAIL', 'SMS', 'PUSH'] },
      },
    ],
  },

  {
    id: 'microloan',
    displayName: 'TrustOS Microloan',
    category: 'financial-services',
    status: 'experimental',
    owner: 'TrustOS Lending Team',
    description:
      'Small-ticket lending: borrowers, loan products, an application under the framework ' +
      'approval workflow, disbursed loan accounts and a repayment schedule.',
    modules: [...SDK, ...MONEY, ...FLOW],
    outOfScope: [
      'credit bureau integration',
      'credit scoring models',
      'payment providers',
      'collections field operations',
      'regulatory reporting',
    ],
    migrationNotes:
      'Initial release. The approval path is a @trustos/workflow-definition document in ' +
      'workflows/ — edit it there and validate with `trustos workflow validate`, rather than ' +
      'adding status columns here. The repayment schedule is generated once at disbursement and ' +
      'never recomputed; a restructure writes a new schedule and supersedes the old one.',
    entities: [
      {
        name: 'Borrower',
        label: 'Borrowers',
        singular: 'Borrower',
        description: 'A person or business that can hold a loan.',
        fields: [
          { name: 'borrowerNumber', type: 'text', label: 'Borrower no.', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'fullName', type: 'text', label: 'Name', required: true, search: true },
          { name: 'phone', type: 'phone', label: 'Phone', search: true },
          { name: 'addressLine', type: 'text', label: 'Address' },
          { name: 'status', type: 'enum:BorrowerStatus', label: 'Status', default: 'ACTIVE', filter: true },
        ],
        enums: { BorrowerStatus: ['ACTIVE', 'BLOCKED', 'CLOSED'] },
      },
      {
        name: 'LoanProduct',
        label: 'Loan products',
        singular: 'Loan product',
        description:
          'The terms a loan can be written on. Rates are stored as decimal strings, never ' +
          'floats — a rate multiplied in binary floating point is wrong by the third instalment.',
        fields: [
          { name: 'code', type: 'slug', label: 'Code', required: true, unique: true, immutable: true },
          { name: 'name', type: 'text', label: 'Product', required: true, search: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true, default: '"USD"' },
          { name: 'minPrincipal', type: 'money', label: 'Min principal', required: true },
          { name: 'maxPrincipal', type: 'money', label: 'Max principal', required: true },
          { name: 'annualRate', type: 'money', label: 'Annual rate', required: true },
          { name: 'termMonths', type: 'int', label: 'Term (months)', required: true },
          { name: 'isActive', type: 'bool', label: 'Active', default: 'true', filter: true },
        ],
      },
      {
        name: 'LoanApplication',
        label: 'Applications',
        singular: 'Application',
        description:
          'A request for a loan, governed by the framework approval workflow. `workflowInstanceId` ' +
          'is where the decision actually lives — this row must not grow its own approval columns.',
        fields: [
          { name: 'reference', type: 'text', label: 'Reference', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'borrowerId', type: 'ref:Borrower', label: 'Borrower', required: true },
          { name: 'productId', type: 'ref:LoanProduct', label: 'Product', required: true },
          { name: 'requestedPrincipal', type: 'money', label: 'Requested', required: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true },
          { name: 'purpose', type: 'longtext', label: 'Purpose' },
          { name: 'workflowInstanceId', type: 'text', label: 'Workflow' },
          { name: 'status', type: 'enum:ApplicationStatus', label: 'Status', default: 'SUBMITTED', filter: true },
          { name: 'submittedAt', type: 'datetime', label: 'Submitted', required: true, filter: true },
        ],
        enums: { ApplicationStatus: ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'WITHDRAWN'] },
      },
      {
        name: 'LoanAccount',
        label: 'Loans',
        singular: 'Loan',
        description:
          'A disbursed loan. The outstanding balance is derived from the ledger, not stored — ' +
          'the same rule as a wallet, for the same reason.',
        fields: [
          { name: 'applicationId', type: 'ref:LoanApplication', label: 'Application', required: true },
          { name: 'borrowerId', type: 'ref:Borrower', label: 'Borrower', required: true },
          { name: 'accountNumber', type: 'text', label: 'Loan no.', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'principal', type: 'money', label: 'Principal', required: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true },
          { name: 'annualRate', type: 'money', label: 'Rate', required: true },
          { name: 'termMonths', type: 'int', label: 'Term', required: true },
          { name: 'disbursedAt', type: 'datetime', label: 'Disbursed', required: true, filter: true },
          { name: 'status', type: 'enum:LoanStatus', label: 'Status', default: 'ACTIVE', filter: true },
        ],
        enums: { LoanStatus: ['ACTIVE', 'IN_ARREARS', 'CLOSED', 'WRITTEN_OFF', 'RESTRUCTURED'] },
      },
      {
        name: 'RepaymentInstalment',
        label: 'Instalments',
        singular: 'Instalment',
        description:
          'One scheduled payment. Generated at disbursement and never recomputed: a schedule ' +
          'that changes retroactively cannot be reconciled against what the borrower was told.',
        fields: [
          { name: 'loanId', type: 'ref:LoanAccount', label: 'Loan', required: true },
          { name: 'sequence', type: 'int', label: '#', required: true },
          { name: 'dueDate', type: 'date', label: 'Due', required: true, filter: true },
          { name: 'principalDue', type: 'money', label: 'Principal', required: true },
          { name: 'interestDue', type: 'money', label: 'Interest', required: true },
          { name: 'totalDue', type: 'money', label: 'Total', required: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true },
          { name: 'status', type: 'enum:InstalmentStatus', label: 'Status', default: 'DUE', filter: true },
        ],
        enums: { InstalmentStatus: ['DUE', 'PAID', 'PARTIAL', 'OVERDUE', 'WAIVED'] },
      },
      {
        name: 'Repayment',
        label: 'Repayments',
        singular: 'Repayment',
        description: 'Money received against a loan, linked to the ledger journal that moved it.',
        fields: [
          { name: 'loanId', type: 'ref:LoanAccount', label: 'Loan', required: true },
          { name: 'reference', type: 'text', label: 'Reference', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'amount', type: 'money', label: 'Amount', required: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true },
          { name: 'receivedAt', type: 'datetime', label: 'Received', required: true, filter: true },
          { name: 'journalId', type: 'text', label: 'Journal', immutable: true },
          { name: 'method', type: 'enum:RepaymentMethod', label: 'Method', default: 'CASH', filter: true },
        ],
        enums: { RepaymentMethod: ['CASH', 'WALLET', 'BANK_TRANSFER', 'ADJUSTMENT'] },
      },
    ],
  },

  {
    id: 'collection',
    displayName: 'TrustOS Collections',
    category: 'financial-services',
    status: 'experimental',
    owner: 'TrustOS Lending Team',
    description:
      'Debt collection operations: cases, collectors, assignments, payment promises, field ' +
      'visits and the reports a collections manager runs each morning.',
    modules: [...SDK, 'financial-core', 'case-management', 'workflow-core', 'scheduler'],
    outOfScope: [
      'dialler and telephony integration',
      'SMS and messaging providers',
      'geolocation tracking',
      'credit bureau reporting',
      'automated legal action',
    ],
    migrationNotes:
      'Initial release. A promise is a commitment with a date, and it is *kept or broken* rather ' +
      'than edited — a promise whose date can be moved is a promise that is never broken, and a ' +
      'collections report built on that number says everything is fine.',
    entities: [
      {
        name: 'Collector',
        label: 'Collectors',
        singular: 'Collector',
        description: 'A person working cases. Authorization comes from framework RBAC.',
        fields: [
          { name: 'userId', type: 'text', label: 'User', required: true, unique: true },
          { name: 'displayName', type: 'text', label: 'Collector', required: true, search: true },
          { name: 'team', type: 'text', label: 'Team', filter: true },
          { name: 'isActive', type: 'bool', label: 'Active', default: 'true', filter: true },
        ],
      },
      {
        name: 'CollectionCase',
        label: 'Cases',
        singular: 'Case',
        description: 'An overdue obligation being worked.',
        fields: [
          { name: 'reference', type: 'text', label: 'Reference', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'debtorName', type: 'text', label: 'Debtor', required: true, search: true },
          { name: 'debtorPhone', type: 'phone', label: 'Phone', search: true },
          { name: 'externalAccountRef', type: 'text', label: 'Account', search: true },
          { name: 'outstandingAmount', type: 'money', label: 'Outstanding', required: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true },
          { name: 'daysPastDue', type: 'int', label: 'DPD', default: '0', filter: true },
          { name: 'bucket', type: 'enum:CollectionBucket', label: 'Bucket', default: 'B0', filter: true },
          { name: 'status', type: 'enum:CaseStatus', label: 'Status', default: 'OPEN', filter: true },
        ],
        enums: {
          CollectionBucket: ['B0', 'B1', 'B2', 'B3', 'B4_PLUS'],
          CaseStatus: ['OPEN', 'IN_PROGRESS', 'PROMISED', 'SETTLED', 'ESCALATED', 'CLOSED'],
        },
      },
      {
        name: 'CaseAssignment',
        label: 'Assignments',
        singular: 'Assignment',
        description:
          'Who is working a case, from when. History is kept: reassigning writes a new row and ' +
          'ends the old one, so "who had this case in March" has an answer.',
        fields: [
          { name: 'caseId', type: 'ref:CollectionCase', label: 'Case', required: true },
          { name: 'collectorId', type: 'ref:Collector', label: 'Collector', required: true },
          { name: 'assignedAt', type: 'datetime', label: 'Assigned', required: true, filter: true },
          { name: 'endedAt', type: 'datetime', label: 'Ended' },
          { name: 'reason', type: 'text', label: 'Reason' },
        ],
      },
      {
        name: 'PaymentPromise',
        label: 'Promises',
        singular: 'Promise',
        description:
          'A debtor committing to pay by a date. Kept or broken, never rescheduled in place — ' +
          'see the migration note.',
        fields: [
          { name: 'caseId', type: 'ref:CollectionCase', label: 'Case', required: true },
          { name: 'collectorId', type: 'ref:Collector', label: 'Taken by', required: true },
          { name: 'promisedAmount', type: 'money', label: 'Amount', required: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true },
          { name: 'promisedFor', type: 'date', label: 'Promised for', required: true, filter: true },
          { name: 'takenAt', type: 'datetime', label: 'Taken', required: true },
          { name: 'status', type: 'enum:PromiseStatus', label: 'Status', default: 'OPEN', filter: true },
          { name: 'note', type: 'longtext', label: 'Note' },
        ],
        enums: { PromiseStatus: ['OPEN', 'KEPT', 'BROKEN', 'CANCELLED'] },
      },
      {
        name: 'FieldVisit',
        label: 'Visits',
        singular: 'Visit',
        description: 'A scheduled or completed visit to a debtor.',
        fields: [
          { name: 'caseId', type: 'ref:CollectionCase', label: 'Case', required: true },
          { name: 'collectorId', type: 'ref:Collector', label: 'Collector', required: true },
          { name: 'scheduledFor', type: 'datetime', label: 'Scheduled', required: true, filter: true },
          { name: 'completedAt', type: 'datetime', label: 'Completed' },
          { name: 'outcome', type: 'enum:VisitOutcome', label: 'Outcome', filter: true },
          { name: 'notes', type: 'longtext', label: 'Notes' },
        ],
        enums: { VisitOutcome: ['NOT_VISITED', 'MET', 'NOT_FOUND', 'REFUSED', 'RELOCATED'] },
      },
    ],
  },

  {
    id: 'insurance',
    displayName: 'TrustOS Insurance',
    category: 'financial-services',
    status: 'experimental',
    owner: 'TrustOS Financial Team',
    description:
      'Policy administration and claims: policyholders, products, policies, premiums and a ' +
      'claim assessed through the framework approval workflow.',
    modules: [...SDK, 'financial-core', ...FLOW],
    outOfScope: [
      'actuarial pricing',
      'reinsurance',
      'payment providers',
      'medical underwriting rules',
      'regulatory reporting',
    ],
    migrationNotes:
      'Initial release. Claim assessment runs on the framework workflow engine; the claim row ' +
      'holds the facts and the workflow holds the decision. Premium amounts are Decimal, and the ' +
      'sum insured is stored on the policy at issue so a later product change cannot alter cover ' +
      'that was already sold.',
    entities: [
      {
        name: 'PolicyHolder',
        label: 'Policyholders',
        singular: 'Policyholder',
        description: 'Whoever the policy is issued to.',
        fields: [
          { name: 'holderNumber', type: 'text', label: 'Holder no.', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'fullName', type: 'text', label: 'Name', required: true, search: true },
          { name: 'email', type: 'email', label: 'Email' },
          { name: 'phone', type: 'phone', label: 'Phone', search: true },
          { name: 'dateOfBirth', type: 'date', label: 'Date of birth' },
        ],
      },
      {
        name: 'InsuranceProduct',
        label: 'Products',
        singular: 'Product',
        description: 'A cover that can be sold.',
        fields: [
          { name: 'code', type: 'slug', label: 'Code', required: true, unique: true, immutable: true },
          { name: 'name', type: 'text', label: 'Product', required: true, search: true },
          { name: 'category', type: 'enum:InsuranceCategory', label: 'Category', required: true, filter: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true, default: '"USD"' },
          { name: 'basePremium', type: 'money', label: 'Base premium', required: true },
          { name: 'defaultSumInsured', type: 'money', label: 'Default cover', required: true },
          { name: 'isActive', type: 'bool', label: 'Active', default: 'true', filter: true },
        ],
        enums: { InsuranceCategory: ['LIFE', 'HEALTH', 'MOTOR', 'PROPERTY', 'TRAVEL'] },
      },
      {
        name: 'Policy',
        label: 'Policies',
        singular: 'Policy',
        description:
          'Cover sold to a holder. `sumInsured` is copied from the product at issue — cover that ' +
          'was sold cannot be changed by editing the product later.',
        fields: [
          { name: 'policyNumber', type: 'text', label: 'Policy no.', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'holderId', type: 'ref:PolicyHolder', label: 'Holder', required: true },
          { name: 'productId', type: 'ref:InsuranceProduct', label: 'Product', required: true },
          { name: 'sumInsured', type: 'money', label: 'Sum insured', required: true, immutable: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true, immutable: true },
          { name: 'startsOn', type: 'date', label: 'Starts', required: true },
          { name: 'endsOn', type: 'date', label: 'Ends', required: true, filter: true },
          { name: 'status', type: 'enum:PolicyStatus', label: 'Status', default: 'QUOTED', filter: true },
        ],
        enums: { PolicyStatus: ['QUOTED', 'ACTIVE', 'LAPSED', 'CANCELLED', 'EXPIRED'] },
      },
      {
        name: 'Premium',
        label: 'Premiums',
        singular: 'Premium',
        description: 'A premium due or received on a policy.',
        fields: [
          { name: 'policyId', type: 'ref:Policy', label: 'Policy', required: true },
          { name: 'dueOn', type: 'date', label: 'Due', required: true, filter: true },
          { name: 'amount', type: 'money', label: 'Amount', required: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true },
          { name: 'paidAt', type: 'datetime', label: 'Paid' },
          { name: 'status', type: 'enum:PremiumStatus', label: 'Status', default: 'DUE', filter: true },
        ],
        enums: { PremiumStatus: ['DUE', 'PAID', 'OVERDUE', 'WAIVED'] },
      },
      {
        name: 'Claim',
        label: 'Claims',
        singular: 'Claim',
        description:
          'A request against a policy. The assessment decision lives in the workflow instance, ' +
          'not in a column here.',
        fields: [
          { name: 'claimNumber', type: 'text', label: 'Claim no.', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'policyId', type: 'ref:Policy', label: 'Policy', required: true },
          { name: 'incidentOn', type: 'date', label: 'Incident', required: true, filter: true },
          { name: 'reportedAt', type: 'datetime', label: 'Reported', required: true },
          { name: 'claimedAmount', type: 'money', label: 'Claimed', required: true },
          { name: 'approvedAmount', type: 'money', label: 'Approved' },
          { name: 'currency', type: 'text', label: 'Currency', required: true },
          { name: 'workflowInstanceId', type: 'text', label: 'Workflow' },
          { name: 'status', type: 'enum:ClaimStatus', label: 'Status', default: 'REPORTED', filter: true },
          { name: 'summary', type: 'longtext', label: 'Summary' },
        ],
        enums: { ClaimStatus: ['REPORTED', 'ASSESSING', 'APPROVED', 'REJECTED', 'PAID', 'WITHDRAWN'] },
      },
    ],
  },

  // ===========================================================================
  // Business operations
  // ===========================================================================
  {
    id: 'crm',
    displayName: 'TrustOS CRM',
    category: 'business-operations',
    status: 'experimental',
    owner: 'TrustOS Platform Team',
    description:
      'Customer relationship management: customers, leads, contacts, activities, tasks and a ' +
      'configurable pipeline over opportunities.',
    modules: [...SDK, 'financial-core'],
    outOfScope: [
      'email and calendar integration',
      'telephony',
      'marketing automation',
      'lead scoring models',
      'document generation',
    ],
    migrationNotes:
      'Initial release. Pipeline stages are rows rather than an enum, because every deployment ' +
      'renames them within a month and an enum change is a migration. The trade is that a stage ' +
      'can be deleted while opportunities point at it — the service refuses that, and there is a ' +
      'test for it.',
    entities: [
      {
        name: 'Customer',
        label: 'Customers',
        singular: 'Customer',
        description: 'An organization or person you do business with.',
        fields: [
          { name: 'name', type: 'text', label: 'Customer', required: true, search: true },
          { name: 'code', type: 'slug', label: 'Code', required: true, unique: true, immutable: true },
          { name: 'industry', type: 'text', label: 'Industry', filter: true },
          { name: 'website', type: 'text', label: 'Website' },
          { name: 'status', type: 'enum:CustomerStatus', label: 'Status', default: 'PROSPECT', filter: true },
        ],
        enums: { CustomerStatus: ['PROSPECT', 'ACTIVE', 'DORMANT', 'LOST'] },
      },
      {
        name: 'Contact',
        label: 'Contacts',
        singular: 'Contact',
        description: 'A person at a customer.',
        fields: [
          { name: 'customerId', type: 'ref:Customer', label: 'Customer', required: true },
          { name: 'fullName', type: 'text', label: 'Name', required: true, search: true },
          { name: 'title', type: 'text', label: 'Title' },
          { name: 'email', type: 'email', label: 'Email', search: true },
          { name: 'phone', type: 'phone', label: 'Phone' },
          { name: 'isPrimary', type: 'bool', label: 'Primary', default: 'false' },
        ],
      },
      {
        name: 'Lead',
        label: 'Leads',
        singular: 'Lead',
        description: 'An unqualified opportunity. Becomes a customer and a contact when it converts.',
        fields: [
          { name: 'fullName', type: 'text', label: 'Name', required: true, search: true },
          { name: 'company', type: 'text', label: 'Company', search: true },
          { name: 'email', type: 'email', label: 'Email' },
          { name: 'phone', type: 'phone', label: 'Phone' },
          { name: 'source', type: 'enum:LeadSource', label: 'Source', default: 'OTHER', filter: true },
          { name: 'status', type: 'enum:LeadStatus', label: 'Status', default: 'NEW', filter: true },
          { name: 'ownerUserId', type: 'text', label: 'Owner' },
        ],
        enums: {
          LeadSource: ['WEB', 'REFERRAL', 'EVENT', 'OUTBOUND', 'PARTNER', 'OTHER'],
          LeadStatus: ['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'DISQUALIFIED'],
        },
      },
      {
        name: 'PipelineStage',
        label: 'Pipeline stages',
        singular: 'Stage',
        description:
          'A column on the board. A row rather than an enum — see the migration note.',
        fields: [
          { name: 'name', type: 'text', label: 'Stage', required: true },
          { name: 'code', type: 'slug', label: 'Code', required: true, unique: true, immutable: true },
          { name: 'position', type: 'int', label: 'Position', required: true, default: '0' },
          { name: 'isWon', type: 'bool', label: 'Won', default: 'false' },
          { name: 'isClosed', type: 'bool', label: 'Closed', default: 'false' },
        ],
      },
      {
        name: 'Opportunity',
        label: 'Opportunities',
        singular: 'Opportunity',
        description: 'A deal in the pipeline.',
        fields: [
          { name: 'customerId', type: 'ref:Customer', label: 'Customer', required: true },
          { name: 'stageId', type: 'ref:PipelineStage', label: 'Stage', required: true },
          { name: 'name', type: 'text', label: 'Opportunity', required: true, search: true },
          { name: 'amount', type: 'money', label: 'Amount', required: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true, default: '"USD"' },
          { name: 'expectedCloseOn', type: 'date', label: 'Expected close', filter: true },
          { name: 'ownerUserId', type: 'text', label: 'Owner' },
        ],
      },
      {
        name: 'Activity',
        label: 'Activities',
        singular: 'Activity',
        description: 'Something that happened: a call, a meeting, a note.',
        fields: [
          { name: 'customerId', type: 'ref:Customer', label: 'Customer' },
          { name: 'leadId', type: 'ref:Lead', label: 'Lead' },
          { name: 'kind', type: 'enum:ActivityKind', label: 'Kind', required: true, filter: true },
          { name: 'subject', type: 'text', label: 'Subject', required: true, search: true },
          { name: 'body', type: 'longtext', label: 'Detail' },
          { name: 'occurredAt', type: 'datetime', label: 'When', required: true, filter: true },
          { name: 'actorUserId', type: 'text', label: 'By' },
        ],
        enums: { ActivityKind: ['CALL', 'MEETING', 'EMAIL', 'NOTE', 'VISIT'] },
      },
      {
        name: 'CrmTask',
        label: 'Tasks',
        singular: 'Task',
        description: 'Something somebody has to do.',
        fields: [
          { name: 'customerId', type: 'ref:Customer', label: 'Customer' },
          { name: 'opportunityId', type: 'ref:Opportunity', label: 'Opportunity' },
          { name: 'title', type: 'text', label: 'Task', required: true, search: true },
          { name: 'dueOn', type: 'date', label: 'Due', filter: true },
          { name: 'assigneeUserId', type: 'text', label: 'Assignee' },
          { name: 'status', type: 'enum:TaskStatus', label: 'Status', default: 'OPEN', filter: true },
        ],
        enums: { TaskStatus: ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'] },
      },
    ],
  },

  {
    id: 'erp',
    displayName: 'TrustOS ERP',
    category: 'business-operations',
    status: 'experimental',
    owner: 'TrustOS Platform Team',
    description:
      'Internal operations: departments, employees, projects, and interfaces for inventory and ' +
      'purchasing that a deployment fills in against its own systems.',
    modules: [...SDK, 'financial-core', ...FLOW],
    outOfScope: [
      'general ledger accounting',
      'payroll',
      'manufacturing planning',
      'warehouse management systems',
      'supplier portals',
    ],
    migrationNotes:
      'Initial release. Inventory and purchasing are interfaces, not implementations: ' +
      'InventoryItem records what is held and PurchaseRequest records what was asked for, and ' +
      'both are meant to be reconciled against a system of record the deployment already has. A ' +
      'purchase request is approved through the framework workflow, not through a status column.',
    entities: [
      {
        name: 'Department',
        label: 'Departments',
        singular: 'Department',
        description: 'An organizational unit. Nests via `parentId`.',
        fields: [
          { name: 'name', type: 'text', label: 'Department', required: true, search: true },
          { name: 'code', type: 'slug', label: 'Code', required: true, unique: true, immutable: true },
          { name: 'parentId', type: 'ref:Department', label: 'Parent' },
          { name: 'costCentre', type: 'text', label: 'Cost centre', filter: true },
        ],
      },
      {
        name: 'Employee',
        label: 'Employees',
        singular: 'Employee',
        description:
          'A person working for the organization. `userId` links to the framework identity; ' +
          'authorization is RBAC, never a job title.',
        fields: [
          { name: 'employeeNumber', type: 'text', label: 'Employee no.', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'userId', type: 'text', label: 'User' },
          { name: 'departmentId', type: 'ref:Department', label: 'Department', required: true },
          { name: 'fullName', type: 'text', label: 'Name', required: true, search: true },
          { name: 'jobTitle', type: 'text', label: 'Job title' },
          { name: 'email', type: 'email', label: 'Email' },
          { name: 'startedOn', type: 'date', label: 'Started', required: true },
          { name: 'status', type: 'enum:EmploymentStatus', label: 'Status', default: 'ACTIVE', filter: true },
        ],
        enums: { EmploymentStatus: ['ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'LEFT'] },
      },
      {
        name: 'Project',
        label: 'Projects',
        singular: 'Project',
        description: 'A piece of work with a budget and an owner.',
        fields: [
          { name: 'code', type: 'slug', label: 'Code', required: true, unique: true, immutable: true },
          { name: 'name', type: 'text', label: 'Project', required: true, search: true },
          { name: 'departmentId', type: 'ref:Department', label: 'Department', required: true },
          { name: 'managerEmployeeId', type: 'ref:Employee', label: 'Manager' },
          { name: 'budget', type: 'money', label: 'Budget', required: true, default: '0' },
          { name: 'currency', type: 'text', label: 'Currency', required: true, default: '"USD"' },
          { name: 'startsOn', type: 'date', label: 'Starts' },
          { name: 'endsOn', type: 'date', label: 'Ends' },
          { name: 'status', type: 'enum:ProjectStatus', label: 'Status', default: 'PLANNED', filter: true },
        ],
        enums: { ProjectStatus: ['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'] },
      },
      {
        name: 'InventoryItem',
        label: 'Inventory',
        singular: 'Item',
        description:
          'What is held, where. An *interface* to whatever system actually owns stock — see the ' +
          'migration note before treating this as a warehouse system.',
        fields: [
          { name: 'sku', type: 'text', label: 'SKU', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'name', type: 'text', label: 'Item', required: true, search: true },
          { name: 'unit', type: 'text', label: 'Unit', required: true, default: '"each"' },
          { name: 'quantityOnHand', type: 'int', label: 'On hand', default: '0' },
          { name: 'reorderLevel', type: 'int', label: 'Reorder at', default: '0' },
          { name: 'location', type: 'text', label: 'Location', filter: true },
          { name: 'unitCost', type: 'money', label: 'Unit cost', required: true, default: '0' },
          { name: 'currency', type: 'text', label: 'Currency', required: true, default: '"USD"' },
        ],
      },
      {
        name: 'PurchaseRequest',
        label: 'Purchase requests',
        singular: 'Purchase request',
        description:
          'A request to buy something, approved through the framework workflow. The decision is ' +
          'in the workflow instance; this row holds what was asked for.',
        fields: [
          { name: 'reference', type: 'text', label: 'Reference', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'departmentId', type: 'ref:Department', label: 'Department', required: true },
          { name: 'requestedByEmployeeId', type: 'ref:Employee', label: 'Requested by', required: true },
          { name: 'projectId', type: 'ref:Project', label: 'Project' },
          { name: 'description', type: 'longtext', label: 'Description', required: true },
          { name: 'estimatedAmount', type: 'money', label: 'Estimate', required: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true, default: '"USD"' },
          { name: 'workflowInstanceId', type: 'text', label: 'Workflow' },
          { name: 'status', type: 'enum:PurchaseStatus', label: 'Status', default: 'DRAFT', filter: true },
          { name: 'neededBy', type: 'date', label: 'Needed by', filter: true },
        ],
        enums: { PurchaseStatus: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'ORDERED', 'RECEIVED', 'CANCELLED'] },
      },
    ],
  },

  {
    id: 'helpdesk',
    displayName: 'TrustOS Helpdesk',
    category: 'business-operations',
    status: 'experimental',
    owner: 'TrustOS Platform Team',
    description:
      'Support ticketing: tickets, comments, agents, queues and SLA policies driven by the ' +
      'framework SLA engine.',
    modules: [...SDK, 'case-management', 'workflow-core', 'workflow-sla', 'workflow-escalation', 'scheduler'],
    outOfScope: [
      'email ingestion',
      'live chat',
      'telephony',
      'knowledge base search',
      'customer satisfaction surveys',
    ],
    migrationNotes:
      'Initial release. SLA timing is computed by @trustos/workflow-sla rather than stored as a ' +
      'deadline column: a deadline written at creation is wrong the moment the calendar or the ' +
      'priority changes, and the ticket that silently missed its SLA is the one nobody can ' +
      'explain afterwards.',
    entities: [
      {
        name: 'TicketQueue',
        label: 'Queues',
        singular: 'Queue',
        description: 'Where tickets land before somebody picks them up.',
        fields: [
          { name: 'name', type: 'text', label: 'Queue', required: true },
          { name: 'code', type: 'slug', label: 'Code', required: true, unique: true, immutable: true },
          { name: 'description', type: 'text', label: 'Description' },
          { name: 'isActive', type: 'bool', label: 'Active', default: 'true', filter: true },
        ],
      },
      {
        name: 'SupportAgent',
        label: 'Agents',
        singular: 'Agent',
        description: 'Somebody who works tickets.',
        fields: [
          { name: 'userId', type: 'text', label: 'User', required: true, unique: true },
          { name: 'displayName', type: 'text', label: 'Agent', required: true, search: true },
          { name: 'queueId', type: 'ref:TicketQueue', label: 'Primary queue' },
          { name: 'isAvailable', type: 'bool', label: 'Available', default: 'true', filter: true },
        ],
      },
      {
        name: 'SlaPolicy',
        label: 'SLA policies',
        singular: 'SLA policy',
        description:
          'Response and resolution targets per priority. Read by @trustos/workflow-sla; this ' +
          'template stores the numbers, not the clock.',
        fields: [
          { name: 'name', type: 'text', label: 'Policy', required: true },
          { name: 'priority', type: 'enum:TicketPriority', label: 'Priority', required: true, unique: true },
          { name: 'firstResponseMinutes', type: 'int', label: 'First response (min)', required: true },
          { name: 'resolutionMinutes', type: 'int', label: 'Resolution (min)', required: true },
          { name: 'businessHoursOnly', type: 'bool', label: 'Business hours', default: 'true' },
        ],
        enums: { TicketPriority: ['LOW', 'NORMAL', 'HIGH', 'URGENT'] },
      },
      {
        name: 'Ticket',
        label: 'Tickets',
        singular: 'Ticket',
        description: 'A request for help.',
        fields: [
          { name: 'reference', type: 'text', label: 'Reference', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'queueId', type: 'ref:TicketQueue', label: 'Queue', required: true },
          { name: 'assigneeId', type: 'ref:SupportAgent', label: 'Assignee' },
          { name: 'requesterName', type: 'text', label: 'Requester', required: true, search: true },
          { name: 'requesterEmail', type: 'email', label: 'Email', search: true },
          { name: 'subject', type: 'text', label: 'Subject', required: true, search: true },
          { name: 'body', type: 'longtext', label: 'Description', required: true },
          { name: 'priority', type: 'enum:TicketPriority', label: 'Priority', default: 'NORMAL', filter: true },
          { name: 'status', type: 'enum:TicketStatus', label: 'Status', default: 'NEW', filter: true },
          { name: 'openedAt', type: 'datetime', label: 'Opened', required: true, filter: true },
          { name: 'firstRespondedAt', type: 'datetime', label: 'First response' },
          { name: 'resolvedAt', type: 'datetime', label: 'Resolved' },
        ],
        enums: { TicketStatus: ['NEW', 'OPEN', 'PENDING', 'RESOLVED', 'CLOSED'] },
      },
      {
        name: 'TicketComment',
        label: 'Comments',
        singular: 'Comment',
        description:
          'A message on a ticket. `isInternal` keeps a note away from the requester — and the ' +
          'API must filter on it, because a comment hidden only in the UI is still in the ' +
          'payload.',
        fields: [
          { name: 'ticketId', type: 'ref:Ticket', label: 'Ticket', required: true },
          { name: 'authorUserId', type: 'text', label: 'Author' },
          { name: 'body', type: 'longtext', label: 'Comment', required: true },
          { name: 'isInternal', type: 'bool', label: 'Internal', default: 'false', filter: true },
          { name: 'postedAt', type: 'datetime', label: 'Posted', required: true },
        ],
      },
    ],
  },

  // ===========================================================================
  // Education
  // ===========================================================================
  {
    id: 'education',
    displayName: 'TrustOS Education',
    category: 'education',
    status: 'experimental',
    owner: 'TrustOS Learn Team',
    description:
      'A learning platform: courses, lessons, quizzes, assignments, enrolments, teachers and ' +
      'certificates, with an AI tutor hook that ships unwired.',
    modules: [...SDK],
    outOfScope: [
      'external AI providers',
      'video hosting and streaming',
      'payment providers',
      'proctoring',
      'SCORM and xAPI',
    ],
    migrationNotes:
      'Initial release. The AI tutor is a *hook*, not an integration: TutorSession records what ' +
      'was asked and what was answered, and the answering is done by whatever the deployment ' +
      'wires into @trustos/ai-gateway. Nothing here calls a model, and nothing here should.',
    entities: [
      {
        name: 'Teacher',
        label: 'Teachers',
        singular: 'Teacher',
        description: 'Somebody who teaches. `userId` is the framework identity.',
        fields: [
          { name: 'userId', type: 'text', label: 'User', required: true, unique: true },
          { name: 'displayName', type: 'text', label: 'Teacher', required: true, search: true },
          { name: 'email', type: 'email', label: 'Email' },
          { name: 'bio', type: 'longtext', label: 'Bio' },
          { name: 'isActive', type: 'bool', label: 'Active', default: 'true', filter: true },
        ],
      },
      {
        name: 'Student',
        label: 'Students',
        singular: 'Student',
        description: 'Somebody who learns.',
        fields: [
          { name: 'userId', type: 'text', label: 'User', required: true, unique: true },
          { name: 'displayName', type: 'text', label: 'Student', required: true, search: true },
          { name: 'email', type: 'email', label: 'Email', search: true },
          { name: 'enrolledOn', type: 'date', label: 'Joined', required: true },
          { name: 'status', type: 'enum:StudentStatus', label: 'Status', default: 'ACTIVE', filter: true },
        ],
        enums: { StudentStatus: ['ACTIVE', 'PAUSED', 'GRADUATED', 'WITHDRAWN'] },
      },
      {
        name: 'Course',
        label: 'Courses',
        singular: 'Course',
        description: 'A body of material a student can enrol in.',
        fields: [
          { name: 'code', type: 'slug', label: 'Code', required: true, unique: true, immutable: true },
          { name: 'title', type: 'text', label: 'Course', required: true, search: true },
          { name: 'summary', type: 'longtext', label: 'Summary' },
          { name: 'teacherId', type: 'ref:Teacher', label: 'Teacher', required: true },
          { name: 'level', type: 'enum:CourseLevel', label: 'Level', default: 'BEGINNER', filter: true },
          { name: 'status', type: 'enum:CourseStatus', label: 'Status', default: 'DRAFT', filter: true },
        ],
        enums: {
          CourseLevel: ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'],
          CourseStatus: ['DRAFT', 'PUBLISHED', 'ARCHIVED'],
        },
      },
      {
        name: 'Lesson',
        label: 'Lessons',
        singular: 'Lesson',
        description: 'One unit of a course.',
        fields: [
          { name: 'courseId', type: 'ref:Course', label: 'Course', required: true },
          { name: 'title', type: 'text', label: 'Lesson', required: true, search: true },
          { name: 'position', type: 'int', label: 'Position', required: true, default: '0' },
          { name: 'body', type: 'longtext', label: 'Content' },
          { name: 'durationMinutes', type: 'int', label: 'Duration', default: '0' },
          { name: 'isPublished', type: 'bool', label: 'Published', default: 'false', filter: true },
        ],
      },
      {
        name: 'Quiz',
        label: 'Quizzes',
        singular: 'Quiz',
        description: 'A set of questions attached to a lesson or a course.',
        fields: [
          { name: 'courseId', type: 'ref:Course', label: 'Course', required: true },
          { name: 'lessonId', type: 'ref:Lesson', label: 'Lesson' },
          { name: 'title', type: 'text', label: 'Quiz', required: true, search: true },
          { name: 'passMarkPercent', type: 'int', label: 'Pass mark %', required: true, default: '60' },
          { name: 'timeLimitMinutes', type: 'int', label: 'Time limit', default: '0' },
          { name: 'isPublished', type: 'bool', label: 'Published', default: 'false', filter: true },
        ],
      },
      {
        name: 'QuizQuestion',
        label: 'Questions',
        singular: 'Question',
        description:
          'One question. `correctOption` is never returned to a student — the service strips it, ' +
          'and there is a test that proves it.',
        fields: [
          { name: 'quizId', type: 'ref:Quiz', label: 'Quiz', required: true },
          { name: 'position', type: 'int', label: 'Position', required: true, default: '0' },
          { name: 'prompt', type: 'longtext', label: 'Question', required: true },
          { name: 'options', type: 'json', label: 'Options', required: true },
          { name: 'correctOption', type: 'int', label: 'Correct option', required: true, sensitive: true },
          { name: 'marks', type: 'int', label: 'Marks', required: true, default: '1' },
        ],
      },
      {
        name: 'Enrollment',
        label: 'Enrolments',
        singular: 'Enrolment',
        description: 'A student on a course.',
        fields: [
          { name: 'courseId', type: 'ref:Course', label: 'Course', required: true },
          { name: 'studentId', type: 'ref:Student', label: 'Student', required: true },
          { name: 'enrolledAt', type: 'datetime', label: 'Enrolled', required: true, filter: true },
          { name: 'completedAt', type: 'datetime', label: 'Completed' },
          { name: 'progressPercent', type: 'int', label: 'Progress %', default: '0' },
          { name: 'status', type: 'enum:EnrollmentStatus', label: 'Status', default: 'ACTIVE', filter: true },
        ],
        enums: { EnrollmentStatus: ['ACTIVE', 'COMPLETED', 'DROPPED'] },
      },
      {
        name: 'Assignment',
        label: 'Assignments',
        singular: 'Assignment',
        description: 'Work a student submits and a teacher marks.',
        fields: [
          { name: 'courseId', type: 'ref:Course', label: 'Course', required: true },
          { name: 'title', type: 'text', label: 'Assignment', required: true, search: true },
          { name: 'instructions', type: 'longtext', label: 'Instructions' },
          { name: 'dueAt', type: 'datetime', label: 'Due', filter: true },
          { name: 'maxMarks', type: 'int', label: 'Max marks', required: true, default: '100' },
        ],
      },
      {
        name: 'AssignmentSubmission',
        label: 'Submissions',
        singular: 'Submission',
        description: 'A student handing work in.',
        fields: [
          { name: 'assignmentId', type: 'ref:Assignment', label: 'Assignment', required: true },
          { name: 'studentId', type: 'ref:Student', label: 'Student', required: true },
          { name: 'submittedAt', type: 'datetime', label: 'Submitted', required: true, filter: true },
          { name: 'body', type: 'longtext', label: 'Answer' },
          { name: 'marksAwarded', type: 'int', label: 'Marks' },
          { name: 'feedback', type: 'longtext', label: 'Feedback' },
          { name: 'status', type: 'enum:SubmissionStatus', label: 'Status', default: 'SUBMITTED', filter: true },
        ],
        enums: { SubmissionStatus: ['DRAFT', 'SUBMITTED', 'MARKED', 'RETURNED', 'LATE'] },
      },
      {
        name: 'Certificate',
        label: 'Certificates',
        singular: 'Certificate',
        description:
          'Proof a student finished a course. `serial` is what a third party verifies against, ' +
          'so it is immutable and unique.',
        fields: [
          { name: 'enrollmentId', type: 'ref:Enrollment', label: 'Enrolment', required: true },
          { name: 'serial', type: 'text', label: 'Serial', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'issuedAt', type: 'datetime', label: 'Issued', required: true, filter: true },
          { name: 'revokedAt', type: 'datetime', label: 'Revoked' },
          { name: 'revocationReason', type: 'text', label: 'Reason' },
        ],
      },
      {
        name: 'TutorSession',
        label: 'Tutor sessions',
        singular: 'Tutor session',
        description:
          'The AI tutor hook. Records the question, the answer and which model answered — and ' +
          'calls nothing. Wiring a provider is a deployment decision made through ' +
          '@trustos/ai-gateway.',
        fields: [
          { name: 'studentId', type: 'ref:Student', label: 'Student', required: true },
          { name: 'courseId', type: 'ref:Course', label: 'Course' },
          { name: 'prompt', type: 'longtext', label: 'Question', required: true },
          { name: 'response', type: 'longtext', label: 'Answer' },
          { name: 'modelId', type: 'text', label: 'Model' },
          { name: 'askedAt', type: 'datetime', label: 'Asked', required: true, filter: true },
          { name: 'status', type: 'enum:TutorSessionStatus', label: 'Status', default: 'PENDING', filter: true },
        ],
        enums: { TutorSessionStatus: ['PENDING', 'ANSWERED', 'FAILED', 'BLOCKED'] },
      },
    ],
  },

  {
    id: 'school',
    extends: 'education',
    displayName: 'TrustOS School',
    category: 'education',
    status: 'experimental',
    owner: 'TrustOS Learn Team',
    description:
      'School administration on top of the education platform: academic terms, class groups, ' +
      'attendance, grades and guardians.',
    modules: [...SDK],
    outOfScope: [
      'timetabling algorithms',
      'payment providers',
      'transport management',
      'government reporting formats',
      'biometric attendance devices',
    ],
    migrationNotes:
      'Initial release. Extends education, so courses, lessons, quizzes and certificates are ' +
      'already there. Attendance is one row per student per session — denormalizing it into a ' +
      'daily summary loses the ability to answer "which period did they miss", which is the ' +
      'question that actually gets asked.',
    entities: [
      {
        name: 'AcademicTerm',
        label: 'Terms',
        singular: 'Term',
        description:
          'A teaching period. Half-open `[startsOn, endsOn)`, so two consecutive terms tile ' +
          'without the boundary day belonging to both.',
        fields: [
          { name: 'name', type: 'text', label: 'Term', required: true },
          { name: 'code', type: 'slug', label: 'Code', required: true, unique: true, immutable: true },
          { name: 'startsOn', type: 'date', label: 'Starts', required: true },
          { name: 'endsOn', type: 'date', label: 'Ends', required: true },
          { name: 'isCurrent', type: 'bool', label: 'Current', default: 'false', filter: true },
        ],
      },
      {
        name: 'ClassGroup',
        label: 'Classes',
        singular: 'Class',
        description: 'A set of students taught together for a term.',
        fields: [
          { name: 'termId', type: 'ref:AcademicTerm', label: 'Term', required: true },
          { name: 'courseId', type: 'ref:Course', label: 'Course', required: true },
          { name: 'teacherId', type: 'ref:Teacher', label: 'Teacher', required: true },
          { name: 'name', type: 'text', label: 'Class', required: true, search: true },
          { name: 'room', type: 'text', label: 'Room' },
          { name: 'capacity', type: 'int', label: 'Capacity', default: '30' },
        ],
      },
      {
        name: 'Attendance',
        label: 'Attendance',
        singular: 'Attendance record',
        description: 'One student, one session. See the migration note before summarizing it.',
        fields: [
          { name: 'classGroupId', type: 'ref:ClassGroup', label: 'Class', required: true },
          { name: 'studentId', type: 'ref:Student', label: 'Student', required: true },
          { name: 'sessionOn', type: 'date', label: 'Date', required: true, filter: true },
          { name: 'period', type: 'int', label: 'Period', required: true, default: '1' },
          { name: 'state', type: 'enum:AttendanceState', label: 'State', required: true, filter: true },
          { name: 'note', type: 'text', label: 'Note' },
        ],
        enums: { AttendanceState: ['PRESENT', 'ABSENT', 'LATE', 'EXCUSED'] },
      },
      {
        name: 'Grade',
        label: 'Grades',
        singular: 'Grade',
        description: 'A mark for a student in a class, for a term.',
        fields: [
          { name: 'classGroupId', type: 'ref:ClassGroup', label: 'Class', required: true },
          { name: 'studentId', type: 'ref:Student', label: 'Student', required: true },
          { name: 'component', type: 'text', label: 'Component', required: true },
          { name: 'marksAwarded', type: 'int', label: 'Marks', required: true },
          { name: 'maxMarks', type: 'int', label: 'Out of', required: true, default: '100' },
          { name: 'recordedAt', type: 'datetime', label: 'Recorded', required: true },
        ],
      },
      {
        name: 'Guardian',
        label: 'Guardians',
        singular: 'Guardian',
        description:
          'A parent or carer. Contact details are personal data — the API returns them only to ' +
          'roles holding the PII permission.',
        fields: [
          { name: 'studentId', type: 'ref:Student', label: 'Student', required: true },
          { name: 'fullName', type: 'text', label: 'Guardian', required: true, search: true },
          { name: 'relationship', type: 'text', label: 'Relationship', required: true },
          { name: 'phone', type: 'phone', label: 'Phone' },
          { name: 'email', type: 'email', label: 'Email' },
          { name: 'isPrimaryContact', type: 'bool', label: 'Primary', default: 'false' },
        ],
      },
    ],
  },

  // ===========================================================================
  // Health
  // ===========================================================================
  {
    id: 'clinic',
    displayName: 'TrustOS Clinic',
    category: 'health',
    status: 'experimental',
    owner: 'TrustOS Health Team',
    description:
      'Outpatient clinic administration: patients, doctors, appointments, medical record ' +
      'entries and invoices. No clinical logic of any kind.',
    modules: [...SDK, 'financial-core'],
    outOfScope: [
      'clinical decision support',
      'diagnosis and treatment logic',
      'drug interaction checking',
      'lab and imaging device integration',
      'insurance claim submission',
      'HL7 and FHIR',
    ],
    migrationNotes:
      'Initial release. There is no clinical logic here and there must not be: a MedicalRecordEntry ' +
      'is free text with an author and a timestamp, and anything that interprets it belongs in a ' +
      'regulated system, not in a template. Patient contact details and record bodies are behind ' +
      'their own PII permissions rather than the general read permission.',
    entities: [
      {
        name: 'Patient',
        label: 'Patients',
        singular: 'Patient',
        description:
          'A person receiving care. Contact fields are sensitive: they sit behind ' +
          '`clinic.patient.pii.read`, not the general read permission.',
        fields: [
          { name: 'patientNumber', type: 'text', label: 'Patient no.', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'fullName', type: 'text', label: 'Name', required: true, search: true },
          { name: 'dateOfBirth', type: 'date', label: 'Date of birth', pii: true },
          { name: 'sex', type: 'enum:PatientSex', label: 'Sex', filter: true },
          { name: 'phone', type: 'phone', label: 'Phone', pii: true },
          { name: 'addressLine', type: 'text', label: 'Address', pii: true },
          { name: 'status', type: 'enum:PatientStatus', label: 'Status', default: 'ACTIVE', filter: true },
        ],
        enums: {
          PatientSex: ['FEMALE', 'MALE', 'OTHER', 'UNDISCLOSED'],
          PatientStatus: ['ACTIVE', 'INACTIVE', 'DECEASED'],
        },
      },
      {
        name: 'Practitioner',
        label: 'Doctors',
        singular: 'Doctor',
        description: 'A clinician. `userId` is the framework identity.',
        fields: [
          { name: 'userId', type: 'text', label: 'User', required: true, unique: true },
          { name: 'displayName', type: 'text', label: 'Doctor', required: true, search: true },
          { name: 'speciality', type: 'text', label: 'Speciality', filter: true },
          { name: 'licenceNumber', type: 'text', label: 'Licence no.' },
          { name: 'isAcceptingPatients', type: 'bool', label: 'Accepting', default: 'true', filter: true },
        ],
      },
      {
        name: 'Appointment',
        label: 'Appointments',
        singular: 'Appointment',
        description: 'A booked slot.',
        fields: [
          { name: 'patientId', type: 'ref:Patient', label: 'Patient', required: true },
          { name: 'practitionerId', type: 'ref:Practitioner', label: 'Doctor', required: true },
          { name: 'reference', type: 'text', label: 'Reference', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'scheduledFor', type: 'datetime', label: 'Scheduled', required: true, filter: true },
          { name: 'durationMinutes', type: 'int', label: 'Duration', required: true, default: '30' },
          { name: 'reason', type: 'text', label: 'Reason' },
          { name: 'status', type: 'enum:AppointmentStatus', label: 'Status', default: 'BOOKED', filter: true },
        ],
        enums: { AppointmentStatus: ['BOOKED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'] },
      },
      {
        name: 'MedicalRecordEntry',
        label: 'Medical records',
        singular: 'Record entry',
        description:
          'A note against a patient. Free text with an author and a time — nothing here ' +
          'interprets it, and nothing here should. Behind its own permission.',
        fields: [
          { name: 'patientId', type: 'ref:Patient', label: 'Patient', required: true },
          { name: 'appointmentId', type: 'ref:Appointment', label: 'Appointment' },
          { name: 'authorPractitionerId', type: 'ref:Practitioner', label: 'Author', required: true },
          { name: 'kind', type: 'enum:RecordKind', label: 'Kind', required: true, filter: true },
          { name: 'body', type: 'longtext', label: 'Entry', required: true, pii: true },
          { name: 'recordedAt', type: 'datetime', label: 'Recorded', required: true, filter: true },
        ],
        enums: { RecordKind: ['CONSULTATION', 'OBSERVATION', 'PRESCRIPTION', 'REFERRAL', 'ATTACHMENT'] },
      },
      {
        name: 'ClinicInvoice',
        label: 'Invoices',
        singular: 'Invoice',
        description: 'What the visit cost.',
        fields: [
          { name: 'patientId', type: 'ref:Patient', label: 'Patient', required: true },
          { name: 'appointmentId', type: 'ref:Appointment', label: 'Appointment' },
          { name: 'number', type: 'text', label: 'Number', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'issuedAt', type: 'datetime', label: 'Issued', required: true, filter: true },
          { name: 'total', type: 'money', label: 'Total', required: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true, default: '"USD"' },
          { name: 'status', type: 'enum:ClinicInvoiceStatus', label: 'Status', default: 'ISSUED', filter: true },
        ],
        enums: { ClinicInvoiceStatus: ['DRAFT', 'ISSUED', 'PAID', 'VOID'] },
      },
    ],
  },

  {
    id: 'hospital',
    extends: 'clinic',
    displayName: 'TrustOS Hospital',
    category: 'health',
    status: 'experimental',
    owner: 'TrustOS Health Team',
    description:
      'Inpatient administration on top of the clinic template: departments, wards, beds and ' +
      'admissions. Still no clinical logic.',
    modules: [...SDK, 'financial-core'],
    outOfScope: [
      'clinical decision support',
      'diagnosis and treatment logic',
      'theatre scheduling optimization',
      'pharmacy stock management',
      'HL7 and FHIR',
      'insurance claim submission',
    ],
    migrationNotes:
      'Initial release. Extends clinic, so patients, doctors, appointments, records and invoices ' +
      'are already there. A bed can hold one admission at a time and the service enforces it — ' +
      'the check belongs in a database constraint too, and the generated migration is the place ' +
      'to add it.',
    entities: [
      {
        name: 'HospitalDepartment',
        label: 'Departments',
        singular: 'Department',
        description: 'A clinical department.',
        fields: [
          { name: 'name', type: 'text', label: 'Department', required: true, search: true },
          { name: 'code', type: 'slug', label: 'Code', required: true, unique: true, immutable: true },
          { name: 'headPractitionerId', type: 'ref:Practitioner', label: 'Head' },
          { name: 'isActive', type: 'bool', label: 'Active', default: 'true', filter: true },
        ],
      },
      {
        name: 'Ward',
        label: 'Wards',
        singular: 'Ward',
        description: 'A group of beds within a department.',
        fields: [
          { name: 'departmentId', type: 'ref:HospitalDepartment', label: 'Department', required: true },
          { name: 'name', type: 'text', label: 'Ward', required: true, search: true },
          { name: 'code', type: 'slug', label: 'Code', required: true, unique: true, immutable: true },
          { name: 'bedCount', type: 'int', label: 'Beds', required: true, default: '0' },
        ],
      },
      {
        name: 'Bed',
        label: 'Beds',
        singular: 'Bed',
        description: 'One bed. Occupied by at most one admission at a time.',
        fields: [
          { name: 'wardId', type: 'ref:Ward', label: 'Ward', required: true },
          { name: 'label', type: 'text', label: 'Bed', required: true },
          { name: 'status', type: 'enum:BedStatus', label: 'Status', default: 'AVAILABLE', filter: true },
        ],
        enums: { BedStatus: ['AVAILABLE', 'OCCUPIED', 'CLEANING', 'OUT_OF_SERVICE'] },
      },
      {
        name: 'Admission',
        label: 'Admissions',
        singular: 'Admission',
        description: 'A patient staying in.',
        fields: [
          { name: 'patientId', type: 'ref:Patient', label: 'Patient', required: true },
          { name: 'bedId', type: 'ref:Bed', label: 'Bed', required: true },
          { name: 'admittingPractitionerId', type: 'ref:Practitioner', label: 'Admitted by', required: true },
          { name: 'reference', type: 'text', label: 'Reference', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'admittedAt', type: 'datetime', label: 'Admitted', required: true, filter: true },
          { name: 'dischargedAt', type: 'datetime', label: 'Discharged' },
          { name: 'status', type: 'enum:AdmissionStatus', label: 'Status', default: 'ADMITTED', filter: true },
        ],
        enums: { AdmissionStatus: ['ADMITTED', 'TRANSFERRED', 'DISCHARGED'] },
      },
    ],
  },

  // ===========================================================================
  // Public and social
  // ===========================================================================
  {
    id: 'ngo',
    displayName: 'TrustOS NGO',
    category: 'public-sector',
    status: 'experimental',
    owner: 'TrustOS Platform Team',
    description:
      'Programme delivery for a non-profit: programmes, projects, donors, donations, ' +
      'beneficiaries and field reports.',
    modules: [...SDK, 'financial-core', 'export'],
    outOfScope: [
      'payment providers',
      'donor CRM automation',
      'grant management portals',
      'accounting systems',
      'donor-specific reporting formats',
    ],
    migrationNotes:
      'Initial release. Beneficiary identity is the sensitive part of this domain: names and ' +
      'contact details sit behind their own PII permission, and a report exported for a donor ' +
      'must not carry them. The export path in @trustos/export is where that filtering belongs.',
    entities: [
      {
        name: 'Programme',
        label: 'Programmes',
        singular: 'Programme',
        description: 'A long-running area of work.',
        fields: [
          { name: 'code', type: 'slug', label: 'Code', required: true, unique: true, immutable: true },
          { name: 'name', type: 'text', label: 'Programme', required: true, search: true },
          { name: 'summary', type: 'longtext', label: 'Summary' },
          { name: 'status', type: 'enum:ProgrammeStatus', label: 'Status', default: 'PLANNED', filter: true },
        ],
        enums: { ProgrammeStatus: ['PLANNED', 'ACTIVE', 'CLOSED'] },
      },
      {
        name: 'NgoProject',
        label: 'Projects',
        singular: 'Project',
        description: 'A funded piece of work inside a programme.',
        fields: [
          { name: 'programmeId', type: 'ref:Programme', label: 'Programme', required: true },
          { name: 'code', type: 'slug', label: 'Code', required: true, unique: true, immutable: true },
          { name: 'name', type: 'text', label: 'Project', required: true, search: true },
          { name: 'location', type: 'text', label: 'Location', filter: true },
          { name: 'budget', type: 'money', label: 'Budget', required: true, default: '0' },
          { name: 'currency', type: 'text', label: 'Currency', required: true, default: '"USD"' },
          { name: 'startsOn', type: 'date', label: 'Starts' },
          { name: 'endsOn', type: 'date', label: 'Ends' },
          { name: 'status', type: 'enum:NgoProjectStatus', label: 'Status', default: 'PLANNED', filter: true },
        ],
        enums: { NgoProjectStatus: ['PLANNED', 'ACTIVE', 'SUSPENDED', 'COMPLETED'] },
      },
      {
        name: 'Donor',
        label: 'Donors',
        singular: 'Donor',
        description: 'Somebody who funds the work.',
        fields: [
          { name: 'name', type: 'text', label: 'Donor', required: true, search: true },
          { name: 'code', type: 'slug', label: 'Code', required: true, unique: true, immutable: true },
          { name: 'kind', type: 'enum:DonorKind', label: 'Kind', default: 'INDIVIDUAL', filter: true },
          { name: 'email', type: 'email', label: 'Email', pii: true },
          { name: 'phone', type: 'phone', label: 'Phone', pii: true },
        ],
        enums: { DonorKind: ['INDIVIDUAL', 'CORPORATE', 'FOUNDATION', 'GOVERNMENT', 'MULTILATERAL'] },
      },
      {
        name: 'Donation',
        label: 'Donations',
        singular: 'Donation',
        description: 'Money given, optionally earmarked for a project.',
        fields: [
          { name: 'donorId', type: 'ref:Donor', label: 'Donor', required: true },
          { name: 'projectId', type: 'ref:NgoProject', label: 'Project' },
          { name: 'reference', type: 'text', label: 'Reference', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'amount', type: 'money', label: 'Amount', required: true },
          { name: 'currency', type: 'text', label: 'Currency', required: true, default: '"USD"' },
          { name: 'receivedOn', type: 'date', label: 'Received', required: true, filter: true },
          { name: 'isRestricted', type: 'bool', label: 'Restricted', default: 'false', filter: true },
        ],
      },
      {
        name: 'Beneficiary',
        label: 'Beneficiaries',
        singular: 'Beneficiary',
        description:
          'Somebody the work reaches. The most sensitive records in the schema — see the ' +
          'migration note before exporting any of it.',
        fields: [
          { name: 'projectId', type: 'ref:NgoProject', label: 'Project', required: true },
          { name: 'reference', type: 'text', label: 'Reference', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'fullName', type: 'text', label: 'Name', required: true, pii: true },
          { name: 'phone', type: 'phone', label: 'Phone', pii: true },
          { name: 'village', type: 'text', label: 'Village', filter: true },
          { name: 'householdSize', type: 'int', label: 'Household', default: '1' },
          { name: 'enrolledOn', type: 'date', label: 'Enrolled', required: true },
        ],
      },
      {
        name: 'FieldReport',
        label: 'Field reports',
        singular: 'Field report',
        description: 'What happened on the ground, and when.',
        fields: [
          { name: 'projectId', type: 'ref:NgoProject', label: 'Project', required: true },
          { name: 'title', type: 'text', label: 'Report', required: true, search: true },
          { name: 'body', type: 'longtext', label: 'Report', required: true },
          { name: 'reportedOn', type: 'date', label: 'Reported', required: true, filter: true },
          { name: 'authorUserId', type: 'text', label: 'Author' },
          { name: 'peopleReached', type: 'int', label: 'People reached', default: '0' },
        ],
      },
    ],
  },

  {
    id: 'government',
    displayName: 'TrustOS Government Services',
    category: 'public-sector',
    status: 'experimental',
    owner: 'TrustOS Public Sector Team',
    description:
      'Citizen-facing service delivery: citizen records, service catalogue, applications running ' +
      'on the framework workflow engine, appointments and public notices.',
    modules: [...SDK, ...FLOW],
    outOfScope: [
      'national ID system integration',
      'government payment rails',
      'e-signature providers',
      'inter-agency data exchange',
      'country-specific legal workflows',
    ],
    migrationNotes:
      'Initial release. Deliberately generic: there is no national ID validation, no ministry ' +
      'taxonomy and no country-specific form. An application is routed by a ' +
      '@trustos/workflow-definition document the deployment writes, which is the seam that lets ' +
      'one template serve agencies whose processes have nothing in common.',
    entities: [
      {
        name: 'Citizen',
        label: 'Citizens',
        singular: 'Citizen',
        description:
          'A person known to the agency. `nationalIdRef` is an opaque reference, never a ' +
          'validated national identifier — validating one means encoding a country, and this ' +
          'template does not.',
        fields: [
          { name: 'citizenNumber', type: 'text', label: 'Citizen no.', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'fullName', type: 'text', label: 'Name', required: true, search: true },
          { name: 'nationalIdRef', type: 'text', label: 'National ID ref', pii: true },
          { name: 'dateOfBirth', type: 'date', label: 'Date of birth', pii: true },
          { name: 'phone', type: 'phone', label: 'Phone', pii: true },
          { name: 'addressLine', type: 'text', label: 'Address', pii: true },
          { name: 'status', type: 'enum:CitizenStatus', label: 'Status', default: 'ACTIVE', filter: true },
        ],
        enums: { CitizenStatus: ['ACTIVE', 'INACTIVE', 'DECEASED'] },
      },
      {
        name: 'GovernmentService',
        label: 'Services',
        singular: 'Service',
        description: 'Something a citizen can apply for.',
        fields: [
          { name: 'code', type: 'slug', label: 'Code', required: true, unique: true, immutable: true },
          { name: 'name', type: 'text', label: 'Service', required: true, search: true },
          { name: 'description', type: 'longtext', label: 'Description' },
          { name: 'workflowDefinitionId', type: 'text', label: 'Workflow' },
          { name: 'processingDays', type: 'int', label: 'Processing days', default: '0' },
          { name: 'isActive', type: 'bool', label: 'Active', default: 'true', filter: true },
        ],
      },
      {
        name: 'ServiceApplication',
        label: 'Applications',
        singular: 'Application',
        description:
          'A citizen applying. The decision lives in the workflow instance; this row holds what ' +
          'was submitted.',
        fields: [
          { name: 'reference', type: 'text', label: 'Reference', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'citizenId', type: 'ref:Citizen', label: 'Citizen', required: true },
          { name: 'serviceId', type: 'ref:GovernmentService', label: 'Service', required: true },
          { name: 'submittedAt', type: 'datetime', label: 'Submitted', required: true, filter: true },
          { name: 'payload', type: 'json', label: 'Form data' },
          { name: 'workflowInstanceId', type: 'text', label: 'Workflow' },
          { name: 'status', type: 'enum:ServiceApplicationStatus', label: 'Status', default: 'SUBMITTED', filter: true },
          { name: 'decidedAt', type: 'datetime', label: 'Decided' },
        ],
        enums: {
          ServiceApplicationStatus: ['DRAFT', 'SUBMITTED', 'IN_REVIEW', 'INFORMATION_REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN'],
        },
      },
      {
        name: 'ServiceAppointment',
        label: 'Appointments',
        singular: 'Appointment',
        description: 'A slot booked at an office.',
        fields: [
          { name: 'applicationId', type: 'ref:ServiceApplication', label: 'Application' },
          { name: 'citizenId', type: 'ref:Citizen', label: 'Citizen', required: true },
          { name: 'office', type: 'text', label: 'Office', required: true, filter: true },
          { name: 'scheduledFor', type: 'datetime', label: 'Scheduled', required: true, filter: true },
          { name: 'status', type: 'enum:ServiceAppointmentStatus', label: 'Status', default: 'BOOKED', filter: true },
        ],
        enums: { ServiceAppointmentStatus: ['BOOKED', 'ATTENDED', 'MISSED', 'CANCELLED'] },
      },
      {
        name: 'PublicNotice',
        label: 'Notices',
        singular: 'Notice',
        description: 'Something the agency publishes.',
        fields: [
          { name: 'title', type: 'text', label: 'Notice', required: true, search: true },
          { name: 'body', type: 'longtext', label: 'Body', required: true },
          { name: 'publishedAt', type: 'datetime', label: 'Published', filter: true },
          { name: 'expiresAt', type: 'datetime', label: 'Expires' },
          { name: 'audience', type: 'enum:NoticeAudience', label: 'Audience', default: 'PUBLIC', filter: true },
        ],
        enums: { NoticeAudience: ['PUBLIC', 'REGISTERED', 'INTERNAL'] },
      },
    ],
  },

  // ===========================================================================
  // Messaging mini apps
  // ===========================================================================
  {
    id: 'telegram-miniapp',
    displayName: 'TrustOS Telegram Mini App',
    category: 'messaging',
    status: 'experimental',
    owner: 'TrustOS Platform Team',
    description:
      'A messaging mini app: platform sign-in, deep links, a menu, a profile and notification ' +
      'settings. The platform handshake is behind a verifier port, so the same shape serves ' +
      'WhatsApp and Messenger.',
    modules: [...SDK],
    apps: ['api', 'admin', 'miniapp'],
    outOfScope: [
      'Telegram Bot API calls',
      'Meta Graph API calls',
      'payment providers',
      'push notification services',
      'chatbot conversation design',
    ],
    migrationNotes:
      'Initial release, and the base for the WhatsApp and Messenger templates. The one thing ' +
      'that differs between the three platforms is how an initial payload is verified, so that ' +
      'is a port — MiniAppVerifier — and everything else is shared. Nothing here calls a ' +
      'platform API: the framework is provider-neutral, and a template that shipped a Bot API ' +
      'client would not be.',
    entities: [
      {
        name: 'MiniAppUser',
        label: 'Users',
        singular: 'User',
        description:
          'Somebody who opened the mini app. `platformUserId` is the id the platform gave them ' +
          'and it is opaque — it is not an email, it is not stable across platforms, and it must ' +
          'not be used as a display name.',
        fields: [
          { name: 'platform', type: 'enum:MiniAppPlatform', label: 'Platform', required: true, immutable: true, filter: true },
          { name: 'platformUserId', type: 'text', label: 'Platform id', required: true, immutable: true, unique: true },
          { name: 'userId', type: 'text', label: 'Framework user' },
          { name: 'displayName', type: 'text', label: 'Name', required: true, search: true },
          { name: 'languageCode', type: 'text', label: 'Language', default: '"en"' },
          { name: 'status', type: 'enum:MiniAppUserStatus', label: 'Status', default: 'ACTIVE', filter: true },
        ],
        enums: {
          MiniAppPlatform: ['TELEGRAM', 'WHATSAPP', 'MESSENGER'],
          MiniAppUserStatus: ['ACTIVE', 'BLOCKED'],
        },
      },
      {
        name: 'MiniAppSession',
        label: 'Sessions',
        singular: 'Session',
        description:
          'A verified sign-in. Short-lived by design: a mini app session that outlives the chat ' +
          'it was opened from is a session nobody can revoke from the app.',
        fields: [
          { name: 'miniAppUserId', type: 'ref:MiniAppUser', label: 'User', required: true },
          { name: 'startedAt', type: 'datetime', label: 'Started', required: true, filter: true },
          { name: 'expiresAt', type: 'datetime', label: 'Expires', required: true },
          { name: 'endedAt', type: 'datetime', label: 'Ended' },
          { name: 'launchParam', type: 'text', label: 'Launch parameter' },
        ],
      },
      {
        name: 'DeepLink',
        label: 'Deep links',
        singular: 'Deep link',
        description:
          'A named entry point. The `target` is resolved against a whitelist rather than ' +
          'redirected to — an open redirect inside a messaging client is a phishing primitive ' +
          'with the platform’s branding on it.',
        fields: [
          { name: 'code', type: 'slug', label: 'Code', required: true, unique: true, immutable: true },
          { name: 'label', type: 'text', label: 'Label', required: true },
          { name: 'target', type: 'text', label: 'Target path', required: true },
          { name: 'isActive', type: 'bool', label: 'Active', default: 'true', filter: true },
          { name: 'openCount', type: 'int', label: 'Opens', default: '0' },
        ],
      },
      {
        name: 'MenuEntry',
        label: 'Menu',
        singular: 'Menu entry',
        description: 'One item in the mini app menu. Filtered by permission before it is sent.',
        fields: [
          { name: 'label', type: 'text', label: 'Label', required: true },
          { name: 'href', type: 'text', label: 'Path', required: true },
          { name: 'icon', type: 'text', label: 'Icon' },
          { name: 'position', type: 'int', label: 'Position', required: true, default: '0' },
          { name: 'requiredPermission', type: 'text', label: 'Permission' },
          { name: 'isActive', type: 'bool', label: 'Active', default: 'true', filter: true },
        ],
      },
      {
        name: 'MiniAppNotificationSetting',
        label: 'Notification settings',
        singular: 'Notification setting',
        description:
          'What a user has muted. Security notifications ignore this — see @trustos/template-sdk.',
        fields: [
          { name: 'miniAppUserId', type: 'ref:MiniAppUser', label: 'User', required: true },
          { name: 'notificationKey', type: 'text', label: 'Notification', required: true },
          { name: 'muted', type: 'bool', label: 'Muted', default: 'false' },
        ],
      },
    ],
  },

  {
    id: 'whatsapp-miniapp',
    extends: 'telegram-miniapp',
    displayName: 'TrustOS WhatsApp Mini App',
    category: 'messaging',
    status: 'experimental',
    owner: 'TrustOS Platform Team',
    description:
      'The mini app shape with a WhatsApp verifier: the same users, sessions, deep links, menu ' +
      'and settings, and a different platform handshake.',
    modules: [...SDK],
    apps: ['api', 'admin', 'miniapp'],
    outOfScope: [
      'Meta Graph API calls',
      'WhatsApp Business API provisioning',
      'payment providers',
      'template message approval',
      'chatbot conversation design',
    ],
    migrationNotes:
      'Initial release. Extends telegram-miniapp and overrides only the verifier and the ' +
      'platform default. If you find yourself copying an entity across from the parent, the ' +
      'entity belongs in the parent.',
    entities: [
      {
        name: 'WhatsAppProfile',
        label: 'WhatsApp profiles',
        singular: 'WhatsApp profile',
        description:
          'The WhatsApp-specific facts about a mini app user. The phone number is the account ' +
          'identifier on this platform, which makes it both the key and personal data.',
        fields: [
          { name: 'miniAppUserId', type: 'ref:MiniAppUser', label: 'User', required: true, unique: true },
          { name: 'waId', type: 'text', label: 'WhatsApp id', required: true, unique: true, immutable: true },
          { name: 'phone', type: 'phone', label: 'Phone', required: true, pii: true },
          { name: 'businessAccountRef', type: 'text', label: 'Business account' },
        ],
      },
    ],
  },

  {
    id: 'messenger-miniapp',
    extends: 'telegram-miniapp',
    displayName: 'TrustOS Messenger Mini App',
    category: 'messaging',
    status: 'experimental',
    owner: 'TrustOS Platform Team',
    description:
      'The mini app shape with a Messenger verifier: the same users, sessions, deep links, menu ' +
      'and settings, and a different platform handshake.',
    modules: [...SDK],
    apps: ['api', 'admin', 'miniapp'],
    outOfScope: [
      'Meta Graph API calls',
      'Facebook page provisioning',
      'payment providers',
      'push notification services',
      'chatbot conversation design',
    ],
    migrationNotes:
      'Initial release. Extends telegram-miniapp and overrides only the verifier and the ' +
      'platform default.',
    entities: [
      {
        name: 'MessengerProfile',
        label: 'Messenger profiles',
        singular: 'Messenger profile',
        description:
          'The Messenger-specific facts about a mini app user. A page-scoped id is only ' +
          'meaningful for one page — storing it without the page it belongs to makes it ' +
          'unresolvable later.',
        fields: [
          { name: 'miniAppUserId', type: 'ref:MiniAppUser', label: 'User', required: true, unique: true },
          { name: 'pageScopedId', type: 'text', label: 'Page-scoped id', required: true, unique: true, immutable: true },
          { name: 'pageRef', type: 'text', label: 'Page', required: true },
        ],
      },
    ],
  },

  // ===========================================================================
  // Portals
  // ===========================================================================
  {
    id: 'admin-portal',
    displayName: 'TrustOS Admin Portal',
    category: 'portal',
    status: 'experimental',
    owner: 'TrustOS Platform Team',
    description:
      'An internal back office over the framework itself: users, roles, permissions, system ' +
      'health, audit and configuration. Almost no domain of its own, by design.',
    modules: [...SDK, 'service-accounts', 'api-keys'],
    outOfScope: [
      'business domain entities',
      'external monitoring systems',
      'log aggregation',
      'incident management',
      'secret storage backends',
    ],
    migrationNotes:
      'Initial release. This template is mostly *wiring*, and that is the point: users, roles, ' +
      'permissions, health and audit already exist as framework packages, so the portal reads ' +
      'them rather than reimplementing them. The only tables it adds are the two things the ' +
      'framework genuinely does not have — a settings store and an operator note.',
    entities: [
      {
        name: 'SystemSetting',
        label: 'Configuration',
        singular: 'Setting',
        description:
          'A runtime-editable setting. `isSecret` values are never returned by the API and never ' +
          'written to the audit trail — only the fact that they changed is.',
        fields: [
          { name: 'key', type: 'slug', label: 'Key', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'value', type: 'longtext', label: 'Value', required: true, sensitive: true },
          { name: 'description', type: 'text', label: 'Description', required: true },
          { name: 'category', type: 'text', label: 'Category', required: true, filter: true },
          { name: 'isSecret', type: 'bool', label: 'Secret', default: 'false', filter: true },
        ],
      },
      {
        name: 'OperatorNote',
        label: 'Operator notes',
        singular: 'Note',
        description:
          'What an operator did and why, attached to whatever they did it to. The gap the audit ' +
          'trail cannot fill: audit records the change, this records the reason.',
        fields: [
          { name: 'subjectType', type: 'text', label: 'Subject type', required: true, filter: true },
          { name: 'subjectId', type: 'text', label: 'Subject', required: true, search: true },
          { name: 'body', type: 'longtext', label: 'Note', required: true },
          { name: 'authorUserId', type: 'text', label: 'Author' },
          { name: 'pinnedUntil', type: 'datetime', label: 'Pinned until' },
        ],
      },
    ],
  },

  {
    id: 'customer-portal',
    displayName: 'TrustOS Customer Portal',
    category: 'portal',
    status: 'experimental',
    owner: 'TrustOS Platform Team',
    description:
      'A self-service portal: profile, notifications, documents, settings and support requests.',
    modules: [...SDK],
    outOfScope: [
      'payment providers',
      'live chat',
      'document e-signing',
      'identity verification providers',
      'cloud storage backends',
    ],
    migrationNotes:
      'Initial release. Every endpoint in this template is scoped to *the calling customer*, not ' +
      'just to the organization — a customer portal that only applies the tenant scope shows one ' +
      'customer another customer’s documents inside the same tenant. The generated service takes ' +
      'the subject id explicitly for that reason, and the isolation test covers both scopes.',
    entities: [
      {
        name: 'PortalProfile',
        label: 'Profiles',
        singular: 'Profile',
        description: 'What a customer can see and edit about themselves.',
        fields: [
          { name: 'userId', type: 'text', label: 'User', required: true, unique: true, immutable: true },
          { name: 'displayName', type: 'text', label: 'Name', required: true, search: true },
          { name: 'email', type: 'email', label: 'Email', pii: true },
          { name: 'phone', type: 'phone', label: 'Phone', pii: true },
          { name: 'locale', type: 'text', label: 'Language', default: '"en"' },
          { name: 'timezone', type: 'text', label: 'Timezone', default: '"Asia/Phnom_Penh"' },
        ],
      },
      {
        name: 'PortalDocument',
        label: 'Documents',
        singular: 'Document',
        description:
          'A file made available to a customer. `storageKey` is opaque and never a filename the ' +
          'customer supplied — see the upload guidance in @trustos/template-sdk.',
        fields: [
          { name: 'ownerUserId', type: 'text', label: 'Owner', required: true },
          { name: 'title', type: 'text', label: 'Document', required: true, search: true },
          { name: 'storageKey', type: 'text', label: 'Storage key', required: true, immutable: true, sensitive: true },
          { name: 'contentType', type: 'text', label: 'Type', required: true },
          { name: 'sizeBytes', type: 'int', label: 'Size', required: true },
          { name: 'category', type: 'enum:DocumentCategory', label: 'Category', default: 'OTHER', filter: true },
          { name: 'availableFrom', type: 'datetime', label: 'Available from', required: true, filter: true },
        ],
        enums: { DocumentCategory: ['STATEMENT', 'CONTRACT', 'INVOICE', 'IDENTITY', 'OTHER'] },
      },
      {
        name: 'PortalNotification',
        label: 'Notifications',
        singular: 'Notification',
        description: 'Something the customer should see when they next log in.',
        fields: [
          { name: 'recipientUserId', type: 'text', label: 'Recipient', required: true },
          { name: 'notificationKey', type: 'text', label: 'Key', required: true, filter: true },
          { name: 'subject', type: 'text', label: 'Subject', required: true },
          { name: 'body', type: 'longtext', label: 'Body', required: true },
          { name: 'href', type: 'text', label: 'Link' },
          { name: 'sentAt', type: 'datetime', label: 'Sent', required: true, filter: true },
          { name: 'readAt', type: 'datetime', label: 'Read' },
        ],
      },
      {
        name: 'SupportRequest',
        label: 'Support requests',
        singular: 'Support request',
        description: 'A customer asking for help.',
        fields: [
          { name: 'requesterUserId', type: 'text', label: 'Requester', required: true },
          { name: 'reference', type: 'text', label: 'Reference', required: true, unique: true, immutable: true, search: true, prefix: true },
          { name: 'subject', type: 'text', label: 'Subject', required: true, search: true },
          { name: 'body', type: 'longtext', label: 'Detail', required: true },
          { name: 'status', type: 'enum:SupportStatus', label: 'Status', default: 'OPEN', filter: true },
          { name: 'openedAt', type: 'datetime', label: 'Opened', required: true, filter: true },
          { name: 'closedAt', type: 'datetime', label: 'Closed' },
        ],
        enums: { SupportStatus: ['OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED'] },
      },
    ],
  },

  {
    id: 'staff-portal',
    displayName: 'TrustOS Staff Portal',
    category: 'portal',
    status: 'experimental',
    owner: 'TrustOS Platform Team',
    description:
      'An internal workspace: my tasks, approvals waiting on me, notifications, saved searches ' +
      'and the reports a team runs.',
    modules: [...SDK, 'workflow-core', 'workflow-approvals', 'workflow-tasks', 'authorization', 'security-policy', 'security-events'],
    outOfScope: [
      'HR systems',
      'payroll',
      'calendar integration',
      'business intelligence tools',
      'document management systems',
    ],
    migrationNotes:
      'Initial release. Approvals are not stored here: @trustos/workflow-approvals owns them, ' +
      'and this template holds only the *view* — which saved search a person uses, which report ' +
      'they run. A portal that copied approval state would be a second source of truth for ' +
      'whether something was approved.',
    entities: [
      {
        name: 'StaffProfile',
        label: 'Staff',
        singular: 'Staff member',
        description: 'A colleague. Authorization is RBAC, never the job title in this row.',
        fields: [
          { name: 'userId', type: 'text', label: 'User', required: true, unique: true, immutable: true },
          { name: 'displayName', type: 'text', label: 'Name', required: true, search: true },
          { name: 'team', type: 'text', label: 'Team', filter: true },
          { name: 'jobTitle', type: 'text', label: 'Job title' },
          { name: 'isAvailable', type: 'bool', label: 'Available', default: 'true', filter: true },
        ],
      },
      {
        name: 'StaffTask',
        label: 'Tasks',
        singular: 'Task',
        description:
          'Something assigned to a person. A task originating from a workflow carries ' +
          '`workflowTaskId` and is *read* from the engine — completing it here must go through ' +
          'the engine, not around it.',
        fields: [
          { name: 'assigneeUserId', type: 'text', label: 'Assignee', required: true, filter: true },
          { name: 'title', type: 'text', label: 'Task', required: true, search: true },
          { name: 'detail', type: 'longtext', label: 'Detail' },
          { name: 'workflowTaskId', type: 'text', label: 'Workflow task', immutable: true },
          { name: 'dueAt', type: 'datetime', label: 'Due', filter: true },
          { name: 'priority', type: 'enum:StaffTaskPriority', label: 'Priority', default: 'NORMAL', filter: true },
          { name: 'status', type: 'enum:StaffTaskStatus', label: 'Status', default: 'OPEN', filter: true },
        ],
        enums: {
          StaffTaskPriority: ['LOW', 'NORMAL', 'HIGH'],
          StaffTaskStatus: ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'],
        },
      },
      {
        name: 'SavedSearch',
        label: 'Saved searches',
        singular: 'Saved search',
        description:
          'A stored filter set. Stored as declared filters, not as a raw query — a saved search ' +
          'that replayed arbitrary query text would be a stored injection.',
        fields: [
          { name: 'ownerUserId', type: 'text', label: 'Owner', required: true },
          { name: 'name', type: 'text', label: 'Name', required: true, search: true },
          { name: 'resourceKey', type: 'text', label: 'Resource', required: true, filter: true },
          { name: 'filters', type: 'json', label: 'Filters', required: true },
          { name: 'isShared', type: 'bool', label: 'Shared', default: 'false', filter: true },
        ],
      },
      {
        name: 'StaffNotification',
        label: 'Notifications',
        singular: 'Notification',
        description: 'Something a colleague should look at.',
        fields: [
          { name: 'recipientUserId', type: 'text', label: 'Recipient', required: true, filter: true },
          { name: 'subject', type: 'text', label: 'Subject', required: true },
          { name: 'body', type: 'longtext', label: 'Body', required: true },
          { name: 'href', type: 'text', label: 'Link' },
          { name: 'sentAt', type: 'datetime', label: 'Sent', required: true, filter: true },
          { name: 'readAt', type: 'datetime', label: 'Read' },
        ],
      },
    ],
  },

  {
    id: 'developer-portal',
    displayName: 'TrustOS Developer Portal',
    category: 'portal',
    status: 'experimental',
    owner: 'TrustOS Platform Team',
    description:
      'A portal for API consumers: applications, API keys issued through the framework, usage ' +
      'records, worked examples, SDK downloads and service health.',
    modules: [...SDK, 'api-keys', 'webhooks', 'service-accounts'],
    outOfScope: [
      'API gateway implementation',
      'billing and metering providers',
      'OAuth authorization server',
      'package registry hosting',
      'external status page services',
    ],
    migrationNotes:
      'Initial release. Keys are issued and verified by @trustos/api-keys — this template stores ' +
      'the *record* of a key (its prefix, its owner, when it was last used) and never the key ' +
      'itself. A portal that could show a key again after issuing it would be a portal that ' +
      'stores it in a readable form, which defeats the whole design.',
    entities: [
      {
        name: 'ApiApplication',
        label: 'Applications',
        singular: 'Application',
        description: 'A consumer of the API. Keys belong to an application, not to a person.',
        fields: [
          { name: 'name', type: 'text', label: 'Application', required: true, search: true },
          { name: 'slug', type: 'slug', label: 'Slug', required: true, unique: true, immutable: true },
          { name: 'ownerUserId', type: 'text', label: 'Owner', required: true },
          { name: 'description', type: 'longtext', label: 'Description' },
          { name: 'environment', type: 'enum:ApiEnvironment', label: 'Environment', default: 'SANDBOX', filter: true },
          { name: 'status', type: 'enum:ApiApplicationStatus', label: 'Status', default: 'PENDING', filter: true },
        ],
        enums: {
          ApiEnvironment: ['SANDBOX', 'PRODUCTION'],
          ApiApplicationStatus: ['PENDING', 'APPROVED', 'SUSPENDED', 'REVOKED'],
        },
      },
      {
        name: 'ApiKeyRecord',
        label: 'API keys',
        singular: 'API key',
        description:
          'The record of a key issued by @trustos/api-keys. Holds the prefix so a developer can ' +
          'recognize it and never the secret — see the migration note.',
        fields: [
          { name: 'applicationId', type: 'ref:ApiApplication', label: 'Application', required: true },
          { name: 'apiKeyId', type: 'text', label: 'Key id', required: true, unique: true, immutable: true },
          { name: 'label', type: 'text', label: 'Label', required: true },
          { name: 'keyPrefix', type: 'text', label: 'Prefix', required: true, immutable: true, search: true, prefix: true },
          { name: 'issuedAt', type: 'datetime', label: 'Issued', required: true, filter: true },
          { name: 'lastUsedAt', type: 'datetime', label: 'Last used' },
          { name: 'revokedAt', type: 'datetime', label: 'Revoked' },
        ],
      },
      {
        name: 'ApiUsageRecord',
        label: 'Usage',
        singular: 'Usage record',
        description:
          'Calls per application per day. A daily roll-up rather than a row per request: a ' +
          'portal that stored every call would need a retention policy and a bigger database ' +
          'than the product it documents.',
        fields: [
          { name: 'applicationId', type: 'ref:ApiApplication', label: 'Application', required: true },
          { name: 'usageOn', type: 'date', label: 'Date', required: true, filter: true },
          { name: 'endpoint', type: 'text', label: 'Endpoint', required: true, filter: true },
          { name: 'callCount', type: 'int', label: 'Calls', required: true, default: '0' },
          { name: 'errorCount', type: 'int', label: 'Errors', required: true, default: '0' },
        ],
      },
      {
        name: 'CodeExample',
        label: 'Examples',
        singular: 'Example',
        description: 'A worked example shown alongside the API documentation.',
        fields: [
          { name: 'slug', type: 'slug', label: 'Slug', required: true, unique: true, immutable: true },
          { name: 'title', type: 'text', label: 'Example', required: true, search: true },
          { name: 'language', type: 'enum:ExampleLanguage', label: 'Language', required: true, filter: true },
          { name: 'body', type: 'longtext', label: 'Code', required: true },
          { name: 'endpoint', type: 'text', label: 'Endpoint', filter: true },
          { name: 'position', type: 'int', label: 'Position', default: '0' },
        ],
        enums: { ExampleLanguage: ['CURL', 'TYPESCRIPT', 'PYTHON', 'GO', 'PHP', 'JAVA'] },
      },
      {
        name: 'SdkRelease',
        label: 'SDK downloads',
        singular: 'SDK release',
        description:
          'A published client library. `checksum` is what a developer verifies the download ' +
          'against, so a release without one is worse than no release.',
        fields: [
          { name: 'language', type: 'enum:ExampleLanguage', label: 'Language', required: true, filter: true },
          { name: 'version', type: 'text', label: 'Version', required: true },
          { name: 'downloadUrl', type: 'text', label: 'Download', required: true },
          { name: 'checksum', type: 'text', label: 'SHA-256', required: true },
          { name: 'releasedAt', type: 'datetime', label: 'Released', required: true, filter: true },
          { name: 'isCurrent', type: 'bool', label: 'Current', default: 'false', filter: true },
        ],
      },
    ],
  },
];
