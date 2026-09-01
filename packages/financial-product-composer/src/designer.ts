import { END_NODES, START_NODE, type ProductDefinition } from '@trustsystem/financial-product-core';
import {
  APPROVED_BLOCKS,
  BLOCK_CATEGORIES,
  type BlockRegistry,
} from '@trustsystem/financial-block-registry';
import { validateProduct, type ValidationFinding } from './validate';

/**
 * The visual designer, as descriptors.
 *
 * The designer's *data* lives here and its pixels do not, for the same reason
 * `@trustsystem/template-sdk` is headless: the admin application renders a canvas, the CLI renders a
 * tree, and a comparison view renders a diff — three renderers over one description. A designer
 * that owned its own model would be a designer whose products the CLI could not validate, and the
 * two would disagree on the first field either of them added.
 *
 * What the browser gets from here is: a **palette** of what may be dragged, a **canvas** of what
 * has been, a **inspector** description of what a selected block can be configured with, and the
 * **findings** attached to the node they concern. That last one is the part that makes the
 * designer usable by a business analyst — a validation error that appears in a list at the bottom
 * of the screen is an error somebody scrolls past, and one that appears on the block is one they
 * fix.
 *
 * There is no field here for a code editor, an expression box or a script step, and there should
 * not be. The designer's vocabulary is the palette.
 */

export interface PaletteEntry {
  blockId: string;
  version: string;
  category: string;
  name: string;
  description: string;
  /** Whether it needs a connector bound before the product validates. */
  requiresProvider: string | null;
  /** Whether it moves money. Rendered differently, because it is the one a reviewer looks for. */
  movesMoney: boolean;
  requiresPrecedingCategories: string[];
  /** Configuration fields the inspector renders. */
  configuration: Array<{ name: string; type: string; required: boolean; description: string }>;
}

export interface PaletteGroup {
  category: string;
  entries: PaletteEntry[];
}

/**
 * What may be dragged onto the canvas.
 *
 * Approved blocks only. A deprecated block is included and marked, because a product that already
 * contains one has to be editable — but it is not offered as a new choice.
 */
export function designerPalette(registry: BlockRegistry = APPROVED_BLOCKS): PaletteGroup[] {
  return BLOCK_CATEGORIES.map((category) => ({
    category,
    entries: registry
      .byCategory(category)
      .filter((block) => block.lifecycleStatus === 'approved')
      .map((block) => ({
        blockId: block.blockId,
        version: block.version,
        category: block.category,
        name: block.name,
        description: block.description,
        requiresProvider: block.providerInterface ?? null,
        movesMoney: block.monetaryEffect === 'moves',
        requiresPrecedingCategories: [...block.requiresPrecedingCategories],
        configuration: block.configuration.map((field) => ({
          name: field.name,
          type: field.type,
          required: field.required,
          description: field.description,
        })),
      })),
  })).filter((group) => group.entries.length > 0);
}

export interface CanvasNode {
  key: string;
  label: string;
  blockId: string;
  category: string;
  /** Layout column, from the topological order. Rows are the renderer's business. */
  column: number;
  movesMoney: boolean;
  requiresApproval: boolean;
  /** True when this block exists only to undo another. Drawn below the main flow. */
  isCompensation: boolean;
  findings: ValidationFinding[];
}

export interface CanvasEdge {
  from: string;
  to: string;
  kind: string;
  /** The condition in words. What the canvas prints on a branch. */
  label: string | null;
}

export interface DesignerCanvas {
  productId: string;
  version: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Findings that belong to the product rather than to a node. */
  productFindings: ValidationFinding[];
  valid: boolean;
}

/**
 * The canvas for a definition.
 *
 * Columns come from the validator's topological order, so the flow reads left to right in
 * execution order. When the graph is cyclic there is no order and every node lands in column
 * zero — which looks wrong, and should: a cyclic product is one the runtime refuses, and a canvas
 * that laid it out neatly would be a canvas that made it look fine.
 */
export function designerCanvas(
  definition: ProductDefinition,
  registry: BlockRegistry = APPROVED_BLOCKS,
): DesignerCanvas {
  const validation = validateProduct(definition, { blocks: registry });
  const columns = new Map(validation.executionOrder.map((key, index) => [key, index]));
  const compensators = new Set(definition.blocks.flatMap((block) => block.compensateWith));

  const byNode = new Map<string, ValidationFinding[]>();
  const productFindings: ValidationFinding[] = [];
  const keys = new Set(definition.blocks.map((block) => block.key));

  for (const finding of validation.findings) {
    if (keys.has(finding.subject)) {
      byNode.set(finding.subject, [...(byNode.get(finding.subject) ?? []), finding]);
    } else {
      productFindings.push(finding);
    }
  }

  const nodes: CanvasNode[] = definition.blocks.map((block) => {
    const catalog = registry.find(block.blockId, block.blockVersion);

    return {
      key: block.key,
      label: block.name,
      blockId: block.blockId,
      category: catalog?.category ?? 'unknown',
      column: columns.get(block.key) ?? 0,
      movesMoney: catalog?.monetaryEffect === 'moves',
      requiresApproval: block.requiresApproval,
      isCompensation: compensators.has(block.key),
      findings: byNode.get(block.key) ?? [],
    };
  });

  const edges: CanvasEdge[] = definition.transitions.map((transition) => ({
    from: transition.from,
    to: transition.to,
    kind: transition.kind,
    label: transition.when ? describe(transition.when) : (transition.description ?? null),
  }));

  return {
    productId: definition.productId,
    version: definition.version,
    nodes,
    edges,
    productFindings,
    valid: validation.valid,
  };
}

/** The synthetic nodes a canvas always draws. */
export const CANVAS_ENDPOINTS = [START_NODE, ...END_NODES] as const;

/**
 * A version comparison, as the designer renders it.
 *
 * Node-level rather than text-level. A JSON diff of two definitions is technically complete and
 * useless to a product owner: they need to see that a block was added, that a fee changed, and
 * that the graph now branches somewhere it did not. The reviewer reading this is deciding whether
 * to approve, and a diff they cannot read is a diff they approve anyway.
 */
export interface DesignerComparison {
  addedBlocks: string[];
  removedBlocks: string[];
  changedBlocks: string[];
  addedTransitions: string[];
  removedTransitions: string[];
  changedFields: string[];
}

export function compareDesigns(
  before: ProductDefinition,
  after: ProductDefinition,
): DesignerComparison {
  const beforeBlocks = new Map(before.blocks.map((block) => [block.key, block]));
  const afterBlocks = new Map(after.blocks.map((block) => [block.key, block]));

  const edgeKey = (transition: { from: string; to: string; kind: string }): string =>
    `${transition.from} -[${transition.kind}]-> ${transition.to}`;

  const beforeEdges = new Set(before.transitions.map(edgeKey));
  const afterEdges = new Set(after.transitions.map(edgeKey));

  const changedFields: string[] = [];
  for (const field of [
    'fees',
    'limits',
    'rules',
    'providers',
    'settlementPolicy',
    'riskPolicy',
    'compliancePolicy',
    'apiExposurePolicy',
  ] as const) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) changedFields.push(field);
  }

  return {
    addedBlocks: [...afterBlocks.keys()].filter((key) => !beforeBlocks.has(key)).sort(),
    removedBlocks: [...beforeBlocks.keys()].filter((key) => !afterBlocks.has(key)).sort(),
    changedBlocks: [...afterBlocks.keys()]
      .filter(
        (key) =>
          beforeBlocks.has(key) &&
          JSON.stringify(beforeBlocks.get(key)) !== JSON.stringify(afterBlocks.get(key)),
      )
      .sort(),
    addedTransitions: [...afterEdges].filter((edge) => !beforeEdges.has(edge)).sort(),
    removedTransitions: [...beforeEdges].filter((edge) => !afterEdges.has(edge)).sort(),
    changedFields,
  };
}

/** The designer's navigation. Section 22 of the reference architecture, as data. */
export const DESIGNER_NAVIGATION = [
  { id: 'products', label: 'Products', description: 'The catalog, by category and status.' },
  { id: 'templates', label: 'Templates', description: 'Starting points that already validate.' },
  { id: 'blocks', label: 'Blocks', description: 'The approved capability catalog.' },
  { id: 'connectors', label: 'Connectors', description: 'Approved bindings to external systems.' },
  { id: 'rules', label: 'Rules', description: 'Conditions and their outcomes, with the trace.' },
  { id: 'simulator', label: 'Simulator', description: 'Volume runs and the path distribution.' },
  { id: 'sandbox', label: 'Sandbox', description: 'Mock providers and the failure scenarios.' },
  { id: 'approvals', label: 'Approvals', description: 'What is waiting, and on whom.' },
  {
    id: 'deployments',
    label: 'Deployments',
    description: 'Versions, staging, activation, rollback.',
  },
  {
    id: 'monitoring',
    label: 'Monitoring',
    description: 'Usage, latency, failures and SLA breaches.',
  },
  { id: 'audit', label: 'Audit', description: 'Every governed action, immutable.' },
] as const;

function describe(condition: unknown): string {
  const node = condition as Record<string, unknown>;

  if (Array.isArray(node.all)) return node.all.map(describe).join(' AND ');
  if (Array.isArray(node.any)) return node.any.map(describe).join(' OR ');
  if (node.not) return `NOT ${describe(node.not)}`;

  const value = Array.isArray(node.value) ? `[${node.value.join(', ')}]` : String(node.value ?? '');
  return `${String(node.field)} ${String(node.operator)} ${value}`.trim();
}
