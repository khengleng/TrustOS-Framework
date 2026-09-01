import {
  END_NODES,
  START_NODE,
  type ReferenceDomain,
  type ProductDefinition,
  type ProductBlock,
  type ReferenceDataRegistry,
} from '@trustsystem/financial-product-core';
import {
  APPROVED_BLOCKS,
  type BlockCategory,
  type BlockRegistry,
} from '@trustsystem/financial-block-registry';
import { ConnectorRegistry } from '@trustsystem/connector-registry';
import { validateRules } from '@trustsystem/financial-product-rules';

/**
 * Product validation.
 *
 * The schema in `@trustsystem/financial-product-core` checks that a definition is well-formed. This
 * checks that it is *correct*, which is a different question and the one that matters: every
 * finding below describes a product that parses, validates against the schema, deploys, and moves
 * money wrongly.
 *
 * The findings are grouped by what they catch, and the third group is the reason the package
 * exists.
 *
 * **Resolution.** Does every block exist in the approved catalog? Is every provider-dependent
 * block bound to a connector implementing the right interface? These are the easy ones, and they
 * are still worth automating: a typo in a block id becomes a runtime failure on a live
 * transaction, at the block, after the earlier blocks have already run.
 *
 * **Graph.** Is every block reachable? Does every block lead somewhere? Is there a cycle? A block
 * nobody can reach is dead configuration that reads as a control; a block that leads nowhere is
 * an execution that stops halfway with money moved and nothing to say about it.
 *
 * **Ordering.** This is the group that catches the composition which is *individually valid and
 * collectively wrong*. Eight correct blocks in the wrong order is a product that debits before it
 * checks a limit — every block approved, every transition legal, and the same money authorized
 * twice. The check is a dataflow analysis: for each block, what has definitely run on **every**
 * path that reaches it. "On some path" is not enough, and a validator that accepted it would pass
 * the exact composition where the limit check sits on the branch that is not taken.
 */

export interface ValidationFinding {
  severity: 'error' | 'warning';
  code: ValidationCode;
  /** The block, transition or rule the finding is about. */
  subject: string;
  message: string;
  remediation: string;
}

export type ValidationCode =
  | 'unknown_block'
  | 'block_not_composable'
  | 'block_deprecated'
  | 'provider_unbound'
  | 'connector_mismatch'
  | 'connector_deprecated'
  | 'unreachable_block'
  | 'dead_end_block'
  | 'cycle'
  | 'no_entry'
  | 'multiple_entries'
  | 'no_success_path'
  | 'transition_not_allowed'
  | 'missing_prerequisite'
  | 'missing_error_path'
  | 'missing_compensation'
  | 'compensation_mismatch'
  | 'currency_not_supported'
  | 'unknown_reference'
  | 'rule_finding'
  | 'unused_configuration'
  | 'unknown_entry_block'
  | 'retry_on_non_idempotent';

export interface ValidationResult {
  valid: boolean;
  findings: ValidationFinding[];
  /** Blocks in a legal execution order, when the graph is acyclic. Empty when it is not. */
  executionOrder: string[];
}

export interface ValidateProductOptions {
  blocks?: BlockRegistry;
  connectors?: ConnectorRegistry;
  /** Tenant the connectors belong to. Required when a connector registry is supplied. */
  organizationId?: string | null;
  referenceData?: ReferenceDataRegistry;
}

export function validateProduct(
  definition: ProductDefinition,
  options: ValidateProductOptions = {},
): ValidationResult {
  const blocks = options.blocks ?? APPROVED_BLOCKS;
  const findings: ValidationFinding[] = [];

  const resolved = resolveBlocks(definition, blocks, findings);
  findings.push(...connectorFindings(definition, resolved, options));

  const graph = buildGraph(definition);
  findings.push(...graphFindings(definition, graph));
  findings.push(...transitionFindings(definition, resolved, blocks));

  const order = graph.cyclic ? [] : topologicalOrder(definition, graph);
  if (!graph.cyclic) findings.push(...orderingFindings(definition, resolved, graph));

  findings.push(...failureFindings(definition, resolved));
  findings.push(...currencyFindings(definition));
  findings.push(...referenceFindings(definition, options.referenceData));
  findings.push(...ruleFindings(definition));
  findings.push(...exposureFindings(definition));

  return {
    valid: !findings.some((finding) => finding.severity === 'error'),
    findings,
    executionOrder: order,
  };
}

// --- resolution ------------------------------------------------------------

type ResolvedBlocks = Map<
  string,
  { node: ProductBlock; category: BlockCategory; catalog: ReturnType<BlockRegistry['all']>[number] }
>;

function resolveBlocks(
  definition: ProductDefinition,
  registry: BlockRegistry,
  findings: ValidationFinding[],
): ResolvedBlocks {
  const resolved: ResolvedBlocks = new Map();

  for (const node of definition.blocks) {
    const catalog = registry.find(node.blockId, node.blockVersion);

    if (!catalog) {
      findings.push({
        severity: 'error',
        code: 'unknown_block',
        subject: node.key,
        message:
          `Block "${node.key}" uses ${node.blockId}@${node.blockVersion}, which is not in the ` +
          'approved catalog. A typo here becomes a runtime failure on a live transaction, after ' +
          'the earlier blocks have already run.',
        remediation: 'Use an approved block id and an exact version from the catalog.',
      });
      continue;
    }

    if (catalog.lifecycleStatus === 'draft' || catalog.lifecycleStatus === 'withdrawn') {
      findings.push({
        severity: 'error',
        code: 'block_not_composable',
        subject: node.key,
        message: `Block ${node.blockId}@${node.blockVersion} is ${catalog.lifecycleStatus}.`,
        remediation: 'Use an approved version.',
      });
      continue;
    }

    if (catalog.lifecycleStatus === 'deprecated') {
      findings.push({
        severity: 'warning',
        code: 'block_deprecated',
        subject: node.key,
        message:
          `Block ${node.blockId}@${node.blockVersion} is deprecated` +
          (catalog.supersededBy ? `; use ${catalog.supersededBy}.` : '.'),
        remediation: catalog.supersededBy
          ? `Replace it with ${catalog.supersededBy} in the next version.`
          : 'Plan a replacement before it is withdrawn.',
      });
    }

    if (node.retry && !catalog.idempotent) {
      findings.push({
        severity: 'error',
        code: 'retry_on_non_idempotent',
        subject: node.key,
        message:
          `Block "${node.key}" configures retries and ${node.blockId} is not idempotent. ` +
          'Retrying it runs it twice, and for anything that touches money the second run is ' +
          'invisible to the caller.',
        remediation: 'Remove the retry, or use an idempotent block.',
      });
    }

    resolved.set(node.key, { node, category: catalog.category, catalog });
  }

  return resolved;
}

function connectorFindings(
  definition: ProductDefinition,
  resolved: ResolvedBlocks,
  options: ValidateProductOptions,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  for (const [key, entry] of resolved) {
    const required = entry.catalog.providerInterface;
    if (!required) continue;

    const connectorId =
      entry.node.connectorId ??
      definition.providers.find((provider) => provider.providerInterface === required)?.connectorId;

    if (!connectorId) {
      /*
       * Unbound is a to-do without a connector registry and a defect with one.
       *
       * A template deliberately binds nothing — it names `PaymentProvider` and leaves the rail to
       * the deployment, which is the entire point of the layer. Validating one in the abstract
       * has no way to know which connectors exist, so "nothing is bound" is a note.
       *
       * Publication passes a registry. At that point the deployment's connectors are known, the
       * binding is possible, and an unbound interface means the product fails at this block on a
       * live transaction with the earlier blocks already run.
       */
      findings.push({
        severity: options.connectors ? 'error' : 'warning',
        code: 'provider_unbound',
        subject: key,
        message: options.connectors
          ? `Block "${key}" needs a ${required} and nothing binds one. The product would fail at ` +
            'this block, on a live transaction, with earlier blocks already run.'
          : `Block "${key}" needs a ${required} and nothing binds one yet. Bind a connector ` +
            'before publication.',
        remediation:
          `Bind a connector on the block, or declare one for ${required} in the product's ` +
          'providers list.',
      });
      continue;
    }

    if (!options.connectors) continue;

    const connector = options.connectors.find(options.organizationId ?? null, connectorId);

    if (!connector) {
      findings.push({
        severity: 'error',
        code: 'connector_mismatch',
        subject: key,
        message: `Connector "${connectorId}" is not approved for this tenant.`,
        remediation: 'Register and approve the connector, or bind one that is already approved.',
      });
      continue;
    }

    if (connector.providerInterface !== required) {
      findings.push({
        severity: 'error',
        code: 'connector_mismatch',
        subject: key,
        message:
          `Block "${key}" needs a ${required} and "${connectorId}" implements ` +
          `${connector.providerInterface}. Binding it would call an operation the block has no ` +
          'contract for.',
        remediation: `Bind a connector implementing ${required}.`,
      });
    }

    if (connector.lifecycleStatus === 'deprecated') {
      findings.push({
        severity: 'warning',
        code: 'connector_deprecated',
        subject: key,
        message: `Connector "${connectorId}" is deprecated.`,
        remediation: connector.supersededBy
          ? `Move to "${connector.supersededBy}".`
          : 'Plan a replacement.',
      });
    }
  }

  return findings;
}

// --- graph -----------------------------------------------------------------

interface Graph {
  successors: Map<string, string[]>;
  predecessors: Map<string, string[]>;
  cyclic: boolean;
  reachable: Set<string>;
}

function buildGraph(definition: ProductDefinition): Graph {
  const successors = new Map<string, string[]>();
  const predecessors = new Map<string, string[]>();

  for (const transition of definition.transitions) {
    successors.set(transition.from, [...(successors.get(transition.from) ?? []), transition.to]);
    predecessors.set(transition.to, [...(predecessors.get(transition.to) ?? []), transition.from]);
  }

  /*
   * Reachability, including through compensation.
   *
   * A compensating block is deliberately *off* the happy path — nothing transitions to
   * `reverse-posting` on success, and it exists to be run when something upstream fails. A
   * reachability check that only followed transitions would report every compensator as dead
   * configuration, and the fix somebody would reach for is to delete them.
   */
  const reachable = new Set<string>([START_NODE]);
  const queue: string[] = [
    START_NODE,
    ...definition.blocks.flatMap((block) => block.compensateWith),
  ];
  for (const seed of queue) reachable.add(seed);

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of successors.get(current) ?? []) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      queue.push(next);
    }
  }

  return { successors, predecessors, cyclic: hasCycle(definition, successors), reachable };
}

function hasCycle(definition: ProductDefinition, successors: Map<string, string[]>): boolean {
  const visiting = new Set<string>();
  const done = new Set<string>();

  const walk = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (done.has(node)) return false;

    visiting.add(node);
    for (const next of successors.get(node) ?? []) {
      if (walk(next)) return true;
    }
    visiting.delete(node);
    done.add(node);
    return false;
  };

  return walk(START_NODE) || definition.blocks.some((block) => walk(block.key));
}

function graphFindings(definition: ProductDefinition, graph: Graph): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const entries = graph.successors.get(START_NODE) ?? [];

  if (entries.length === 0) {
    findings.push({
      severity: 'error',
      code: 'no_entry',
      subject: START_NODE,
      message: 'Nothing leaves `start`. The product cannot begin.',
      remediation: 'Add a transition from `start` to the first block.',
    });
  }

  if (entries.length > 1) {
    findings.push({
      severity: 'error',
      code: 'multiple_entries',
      subject: START_NODE,
      message:
        `${entries.length} transitions leave \`start\`. Which one runs would be decided by ` +
        'declaration order, and declaration order changes when somebody sorts a file.',
      remediation: 'Leave one transition from `start`, and branch with a conditional after it.',
    });
  }

  if (graph.cyclic) {
    findings.push({
      severity: 'error',
      code: 'cycle',
      subject: 'transitions',
      message:
        'The graph contains a cycle. An execution entering it never terminates, and a ' +
        'money-moving block inside one runs repeatedly.',
      remediation:
        'Model a retry with the block’s retry configuration, which is bounded, rather than with ' +
        'a loop in the graph, which is not.',
    });
  }

  for (const block of definition.blocks) {
    if (!graph.reachable.has(block.key)) {
      findings.push({
        severity: 'error',
        code: 'unreachable_block',
        subject: block.key,
        message:
          `Block "${block.key}" cannot be reached from \`start\`. Dead configuration that reads ` +
          'as a control is worse than no control, because the runbook says it is there.',
        remediation: 'Connect it, or remove it.',
      });
    }

    const outgoing = graph.successors.get(block.key) ?? [];
    if (outgoing.length === 0) {
      findings.push({
        severity: 'error',
        code: 'dead_end_block',
        subject: block.key,
        message:
          `Block "${block.key}" leads nowhere. An execution reaching it stops halfway, with ` +
          'whatever it has already moved left moved.',
        remediation: 'Add a transition to the next block, to `completed`, or to `failed`.',
      });
    }
  }

  const reachesSuccess = graph.reachable.has('completed');
  if (!reachesSuccess) {
    findings.push({
      severity: 'error',
      code: 'no_success_path',
      subject: 'transitions',
      message: 'No path reaches `completed`. Every execution of this product fails.',
      remediation: 'Add a transition to `completed` from the final block.',
    });
  }

  return findings;
}

function transitionFindings(
  definition: ProductDefinition,
  resolved: ResolvedBlocks,
  registry: BlockRegistry,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  for (const transition of definition.transitions) {
    if (transition.from === START_NODE) continue;
    if ((END_NODES as readonly string[]).includes(transition.to)) continue;

    const from = resolved.get(transition.from);
    const to = resolved.get(transition.to);
    if (!from || !to) continue;

    /*
     * A failure path is exempt from the successor allow-list.
     *
     * The allow-list describes what may legitimately follow a block in the *success* case — a
     * debit may be followed by a ledger posting, not by an authentication. On failure the
     * product is unwinding, and the block it unwinds to is chosen by the compensation, not by
     * the happy-path ordering.
     */
    if (transition.kind === 'on_failure') continue;

    if (!registry.transitionAllowed(from.node.blockId, from.node.blockVersion, to.node.blockId)) {
      findings.push({
        severity: 'error',
        code: 'transition_not_allowed',
        subject: `${transition.from} -> ${transition.to}`,
        message:
          `${from.node.blockId} does not permit ${to.node.blockId} to follow it. Allowed: ` +
          `${from.catalog.allowedNext.join(', ') || 'any'}.`,
        remediation:
          'Insert the block the catalog expects between them, or pick another successor.',
      });
    }
  }

  return findings;
}

/**
 * Blocks in a legal execution order.
 *
 * Kahn's algorithm over the block nodes. Used by the simulator to walk a product without
 * executing it, by the designer to lay out a canvas left to right, and by the CLI to print what
 * a transaction does.
 *
 * Compensating blocks sort **last** among the ready set, and that tiebreak is presentational
 * rather than structural. A compensator has no graph predecessor — nothing transitions to it on
 * success — so a plain Kahn's algorithm emits it first, and the printed order opens with three
 * reversal blocks before the product has done anything. It is a legal topological order and it
 * reads as nonsense, which is enough to make somebody distrust the rest of the output.
 */
function topologicalOrder(definition: ProductDefinition, graph: Graph): string[] {
  const keys = new Set(definition.blocks.map((block) => block.key));
  const compensators = compensatingBlocks(definition);
  const indegree = new Map<string, number>();

  for (const key of keys) {
    indegree.set(key, (graph.predecessors.get(key) ?? []).filter((from) => keys.has(from)).length);
  }

  const sortReady = (left: string, right: string): number => {
    const leftCompensates = compensators.has(left) ? 1 : 0;
    const rightCompensates = compensators.has(right) ? 1 : 0;
    return leftCompensates - rightCompensates || left.localeCompare(right);
  };

  const ready = [...keys].filter((key) => indegree.get(key) === 0).sort(sortReady);
  const order: string[] = [];

  while (ready.length > 0) {
    const current = ready.shift() as string;
    order.push(current);

    for (const next of graph.successors.get(current) ?? []) {
      if (!keys.has(next)) continue;
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
    ready.sort(sortReady);
  }

  return order;
}

// --- ordering --------------------------------------------------------------

/**
 * What has definitely run before each block, on every path.
 *
 * A fixpoint over the graph: the categories guaranteed at a node are the **intersection** across
 * its predecessors of what was guaranteed at each one plus what that predecessor itself did.
 *
 * The intersection is the whole point. A union would answer "has a limit check happened on some
 * path", and a product whose limit check sits on the branch that is not taken would pass. The
 * question worth asking is whether it has happened on *every* path, and the only composition
 * that satisfies that is one where the check precedes the branch.
 */
function guaranteedCategories(
  definition: ProductDefinition,
  resolved: ResolvedBlocks,
  graph: Graph,
): Map<string, Set<BlockCategory>> {
  const guaranteed = new Map<string, Set<BlockCategory>>();
  guaranteed.set(START_NODE, new Set());

  const order = topologicalOrder(definition, graph);

  for (const key of order) {
    const predecessors = (graph.predecessors.get(key) ?? []).filter(
      (from) => from === START_NODE || resolved.has(from),
    );

    if (predecessors.length === 0) {
      guaranteed.set(key, new Set());
      continue;
    }

    let intersection: Set<BlockCategory> | undefined;

    for (const from of predecessors) {
      const upstream = new Set<BlockCategory>(guaranteed.get(from) ?? []);
      const fromCategory = resolved.get(from)?.category;
      if (fromCategory) upstream.add(fromCategory);

      if (intersection === undefined) {
        intersection = upstream;
        continue;
      }

      const kept = new Set<BlockCategory>();
      intersection.forEach((category) => {
        if (upstream.has(category)) kept.add(category);
      });
      intersection = kept;
    }

    guaranteed.set(key, intersection ?? new Set<BlockCategory>());
  }

  return guaranteed;
}

function orderingFindings(
  definition: ProductDefinition,
  resolved: ResolvedBlocks,
  graph: Graph,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const guaranteed = guaranteedCategories(definition, resolved, graph);
  const compensators = compensatingBlocks(definition);

  for (const [key, entry] of resolved) {
    const required = entry.catalog.requiresPrecedingCategories;
    if (required.length === 0) continue;
    if (!graph.reachable.has(key)) continue;

    /*
     * A compensating block runs after the block it undoes, by construction.
     *
     * `ledger.reverse_journal` requires a preceding `ledger` block, and it has one — the posting
     * it is reversing. It reaches that state through the compensation path rather than through a
     * transition, so the dataflow analysis sees no predecessors at all and would report a
     * prerequisite that is structurally guaranteed. Exempting it here is what stops the
     * validator from being wrong in the one place a product author cannot fix.
     */
    if (compensators.has(key)) continue;

    const seen: Set<BlockCategory> = guaranteed.get(key) ?? new Set<BlockCategory>();
    const missing = required.filter((category) => !seen.has(category as BlockCategory));

    if (missing.length === 0) continue;

    findings.push({
      severity: 'error',
      code: 'missing_prerequisite',
      subject: key,
      message:
        `Block "${key}" (${entry.node.blockId}) requires ${missing.join(', ')} to have run on ` +
        'every path that reaches it, and on at least one path it has not. Every block here is ' +
        'approved and every transition is legal; the order is what is wrong, and a debit with ' +
        'no preceding limit consumption authorizes the same money twice.',
      remediation:
        `Move a ${missing[0]} block before "${key}" — before any branch, so it is on every path ` +
        'rather than on the one that happens to be taken.',
    });
  }

  return findings;
}

// --- failure handling ------------------------------------------------------

/** Blocks that exist to undo another block, rather than to run on the happy path. */
function compensatingBlocks(definition: ProductDefinition): Set<string> {
  return new Set(definition.blocks.flatMap((block) => block.compensateWith));
}

function failureFindings(
  definition: ProductDefinition,
  resolved: ResolvedBlocks,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const keys = new Set(definition.blocks.map((block) => block.key));
  const compensators = compensatingBlocks(definition);

  for (const [key, entry] of resolved) {
    const node = entry.node;

    if (node.onFailure === 'route') {
      const hasFailurePath = definition.transitions.some(
        (transition) => transition.from === key && transition.kind === 'on_failure',
      );

      if (!hasFailurePath) {
        findings.push({
          severity: 'error',
          code: 'missing_error_path',
          subject: key,
          message:
            `Block "${key}" routes on failure and declares no \`on_failure\` transition. The ` +
            'runtime has nowhere to send it.',
          remediation: 'Add an `on_failure` transition, or change the failure mode to `fail`.',
        });
      }
    }

    if (node.onFailure === 'compensate' && node.compensateWith.length === 0) {
      findings.push({
        severity: 'error',
        code: 'missing_compensation',
        subject: key,
        message: `Block "${key}" compensates on failure and names nothing to compensate with.`,
        remediation: 'List the blocks that undo it, in the order they were applied.',
      });
    }

    for (const compensator of node.compensateWith) {
      if (!keys.has(compensator)) {
        findings.push({
          severity: 'error',
          code: 'missing_compensation',
          subject: key,
          message: `Block "${key}" compensates with "${compensator}", which this product does not contain.`,
          remediation: 'Add the block, or name one that exists.',
        });
        continue;
      }

      /*
       * The compensator must be the block the catalog says undoes this one.
       *
       * `wallet.debit` is undone by `ledger.reverse_journal` and by nothing else. A product that
       * compensated a debit with a notification would validate against every other check here —
       * it names a block that exists, in a product that reaches it — and would leave the money
       * moved while reporting that it had unwound.
       */
      const expected = entry.catalog.compensatedBy;
      const actual = resolved.get(compensator)?.node.blockId;

      if (expected && actual && actual !== expected) {
        findings.push({
          severity: 'error',
          code: 'compensation_mismatch',
          subject: key,
          message:
            `Block "${key}" (${entry.node.blockId}) compensates with "${compensator}" ` +
            `(${actual}), and the catalog says it is undone by ${expected}. The product would ` +
            'report that it unwound and leave the money moved.',
          remediation: `Compensate with a ${expected} block.`,
        });
      }
    }

    /*
     * A money-moving block that fails without compensating.
     *
     * A warning rather than an error, because a single-block product genuinely has nothing to
     * unwind and refusing it outright would make the validator something people work around.
     */
    if (
      entry.catalog.monetaryEffect === 'moves' &&
      node.onFailure === 'fail' &&
      !compensators.has(key)
    ) {
      findings.push({
        severity: 'warning',
        code: 'missing_compensation',
        subject: key,
        message:
          `Block "${key}" moves money and fails without compensating. A failure leaves the ` +
          'movement in place for somebody to unwind by hand.',
        remediation: `Set onFailure to \`compensate\` and name ${entry.catalog.compensatedBy}.`,
      });
    }
  }

  return findings;
}

// --- configuration ---------------------------------------------------------

function currencyFindings(definition: ProductDefinition): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const supported = new Set(definition.supportedCurrencies);

  const check = (currency: string, subject: string): void => {
    if (supported.has(currency)) return;
    findings.push({
      severity: 'error',
      code: 'currency_not_supported',
      subject,
      message:
        `${subject} is denominated in ${currency}, which this product does not support. The ` +
        'amount would be compared against a balance in another currency.',
      remediation: `Add ${currency} to supportedCurrencies, or restate the amount.`,
    });
  };

  for (const fee of definition.fees) {
    if (fee.flat) check(fee.flat.currency, `Fee ${fee.code}`);
    if (fee.cap) check(fee.cap.currency, `Fee ${fee.code} cap`);
    if (fee.floor) check(fee.floor.currency, `Fee ${fee.code} floor`);
  }

  for (const limit of definition.limits) {
    if (limit.amount) check(limit.amount.currency, `Limit ${limit.code}`);
  }

  if (definition.riskPolicy.enhancedReviewAbove) {
    check(definition.riskPolicy.enhancedReviewAbove.currency, 'The enhanced-review threshold');
  }

  if (definition.settlementPolicy?.minimumBatch) {
    check(definition.settlementPolicy.minimumBatch.currency, 'The minimum settlement batch');
  }

  return findings;
}

function referenceFindings(
  definition: ProductDefinition,
  registry: ReferenceDataRegistry | undefined,
): ValidationFinding[] {
  if (!registry) return [];

  const findings: ValidationFinding[] = [];

  const check = (domain: ReferenceDomain, code: string, subject: string): void => {
    if (registry.get(domain, code)) return;
    findings.push({
      severity: 'error',
      code: 'unknown_reference',
      subject,
      message:
        `${subject} references the ${domain} code "${code}", which is not centrally governed. ` +
        'Four products each defining what it means is four products that disagree.',
      remediation: `Register "${code}" in the ${domain} reference domain first.`,
    });
  };

  for (const country of definition.supportedCountries) check('country', country, 'The product');
  for (const fee of definition.fees) check('feeType', fee.feeType, `Fee ${fee.code}`);
  for (const limit of definition.limits) check('limitType', limit.limitType, `Limit ${limit.code}`);
  for (const level of definition.riskPolicy.prohibitedRiskLevels) {
    check('riskLevel', level, 'The risk policy');
  }
  if (definition.settlementPolicy) {
    check('settlementCalendar', definition.settlementPolicy.calendar, 'The settlement policy');
  }

  return findings;
}

function ruleFindings(definition: ProductDefinition): ValidationFinding[] {
  const result = validateRules(definition.rules, {
    blockKeys: definition.blocks.map((block) => block.key),
    feeCodes: definition.fees.map((fee) => fee.code),
    limitCodes: definition.limits.map((limit) => limit.code),
  });

  return result.findings.map((finding) => ({
    severity: finding.severity,
    code: 'rule_finding' as const,
    subject: finding.ruleId,
    message: finding.message,
    remediation: finding.remediation,
  }));
}

function exposureFindings(definition: ProductDefinition): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const keys = new Set(definition.blocks.map((block) => block.key));

  for (const operation of definition.apiExposurePolicy.operations) {
    if (operation.entryBlock && !keys.has(operation.entryBlock)) {
      findings.push({
        severity: 'error',
        code: 'unknown_entry_block',
        subject: operation.operationId,
        message:
          `Operation "${operation.operationId}" enters at "${operation.entryBlock}", which this ` +
          'product does not contain.',
        remediation: `Enter at one of: ${[...keys].join(', ')}.`,
      });
    }
  }

  const referencedFees = new Set(
    definition.rules.flatMap((rule) =>
      rule.then.filter((outcome) => outcome.kind === 'set_fee').map((outcome) => outcome.feeCode),
    ),
  );

  for (const fee of definition.fees) {
    const usedByBlock = definition.blocks.some((block) => block.configuration.feeCode === fee.code);
    if (referencedFees.has(fee.code) || usedByBlock) continue;

    findings.push({
      severity: 'warning',
      code: 'unused_configuration',
      subject: fee.code,
      message:
        `Fee "${fee.code}" is declared and nothing applies it. It reads as a charge the product ` +
        'makes and is not one.',
      remediation: 'Reference it from a fee block’s configuration or from a rule, or remove it.',
    });
  }

  return findings;
}
