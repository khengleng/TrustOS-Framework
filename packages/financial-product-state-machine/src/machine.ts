import { productError } from '@trustos/financial-product-core';

/**
 * A declared state machine.
 *
 * Pure: given a table, a state and an action it returns the same answer every time, with no clock
 * and no database. That is what makes "is this transition legal" testable without a transaction,
 * and it is the same split `@trustos/workflow-runtime` draws between `machine.ts` and
 * `engine.ts` — for the same reason, and deliberately not by reusing that one.
 *
 * The reason it is not `workflow-runtime`'s machine: that machine resolves transitions against a
 * `WorkflowDefinition` document, whose states and actions are authored per workflow and whose
 * store is Prisma-backed. A product's lifecycle is *fixed* — eleven states declared by the
 * framework, identical in every deployment — and a product's runtime states are fixed too. Using
 * the workflow machine would mean expressing a constant as a document, storing the document, and
 * then having to guard against somebody editing it. The constant is the control.
 *
 * `resolve` returns a result rather than throwing, and `assert` throws. Both exist because the
 * two callers differ: the composer asks "would this be legal" about many transitions and wants
 * answers, and the runtime asks about one and wants a refusal it can propagate.
 */

export interface TransitionRule<TState extends string, TAction extends string> {
  action: TAction;
  from: TState;
  to: TState;
  /** The permission an actor needs. Checked by the caller — the machine never authorizes. */
  permission?: string;
  requiresApproval?: boolean;
  description: string;
}

export interface TransitionResolution<TState extends string, TAction extends string> {
  allowed: boolean;
  transition?: TransitionRule<TState, TAction>;
  /** Machine-readable, and the reason a caller can tell "wrong state" from "no such action". */
  reason?: 'unknown_action' | 'wrong_state' | 'terminal_state';
  /** Actions that *would* be legal from here. What the error message offers instead. */
  availableActions: TAction[];
}

export class StateMachine<TState extends string, TAction extends string> {
  private readonly byState = new Map<TState, TransitionRule<TState, TAction>[]>();
  private readonly actions: Set<string>;

  constructor(
    readonly name: string,
    readonly states: readonly TState[],
    readonly transitions: readonly TransitionRule<TState, TAction>[],
  ) {
    this.actions = new Set(transitions.map((transition) => transition.action));

    for (const transition of transitions) {
      if (!states.includes(transition.from) || !states.includes(transition.to)) {
        throw productError(
          'product_definition_invalid',
          `State machine "${name}" declares a transition between states it does not have: ` +
            `${transition.from} -> ${transition.to}.`,
          { expected: states.join(', '), actual: `${transition.from} -> ${transition.to}` },
        );
      }
      this.byState.set(transition.from, [...(this.byState.get(transition.from) ?? []), transition]);
    }
  }

  /** Every action legal from a state, in declaration order. */
  availableActions(state: TState): TAction[] {
    return (this.byState.get(state) ?? []).map((transition) => transition.action);
  }

  /** Whether nothing leads out of a state. */
  isTerminal(state: TState): boolean {
    return (this.byState.get(state) ?? []).length === 0;
  }

  resolve(state: TState, action: TAction): TransitionResolution<TState, TAction> {
    const available = this.availableActions(state);
    const outgoing = this.byState.get(state) ?? [];
    const transition = outgoing.find((candidate) => candidate.action === action);

    if (transition) return { allowed: true, transition, availableActions: available };

    if (!this.actions.has(action)) {
      return { allowed: false, reason: 'unknown_action', availableActions: available };
    }

    return {
      allowed: false,
      reason: outgoing.length === 0 ? 'terminal_state' : 'wrong_state',
      availableActions: available,
    };
  }

  /**
   * The transition, or a refusal.
   *
   * The message distinguishes the three refusals, because they have three different fixes: an
   * unknown action is a client bug, a wrong state is a race with somebody else's decision, and a
   * terminal state means the thing is over. A caller that cannot tell them apart retries the one
   * that will never succeed.
   */
  assert(state: TState, action: TAction): TransitionRule<TState, TAction> {
    const resolution = this.resolve(state, action);
    if (resolution.transition) return resolution.transition;

    const suffix =
      resolution.availableActions.length > 0
        ? ` Available from "${state}": ${resolution.availableActions.join(', ')}.`
        : ` "${state}" is terminal; nothing leads out of it.`;

    const reason =
      resolution.reason === 'unknown_action'
        ? `"${action}" is not an action of the ${this.name} machine.`
        : `"${action}" is not legal from "${state}".`;

    throw productError('product_lifecycle_transition_invalid', `${reason}${suffix}`, {
      expected: resolution.availableActions.join(', '),
      actual: `${state} + ${action}`,
    });
  }

  /**
   * Every state reachable from a starting point.
   *
   * Used by the validator to catch a state nothing can reach — which in a lifecycle means a
   * control that can never fire, and in a runtime machine means a branch the executor will never
   * take.
   */
  reachableFrom(start: TState): Set<TState> {
    const seen = new Set<TState>([start]);
    const queue: TState[] = [start];

    while (queue.length > 0) {
      const current = queue.shift() as TState;
      for (const transition of this.byState.get(current) ?? []) {
        if (seen.has(transition.to)) continue;
        seen.add(transition.to);
        queue.push(transition.to);
      }
    }

    return seen;
  }

  /** States nothing reaches from the start. Empty is the only acceptable answer. */
  unreachableFrom(start: TState): TState[] {
    const reachable = this.reachableFrom(start);
    return this.states.filter((state) => !reachable.has(state));
  }
}
