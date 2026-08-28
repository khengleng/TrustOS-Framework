import type { EvaluationRun, EvaluationRunStore } from './suite';

/** An in-memory run store, for tests and development. */
export class InMemoryEvaluationRunStore implements EvaluationRunStore {
  readonly runs: EvaluationRun[] = [];

  async save(run: EvaluationRun): Promise<EvaluationRun> {
    this.runs.push(run);
    return run;
  }

  async history(input: {
    suiteId: string;
    organizationId: string | null;
    variant?: string;
    limit?: number;
  }): Promise<EvaluationRun[]> {
    return this.runs
      .filter((run) => run.suiteId === input.suiteId)
      .filter((run) => run.organizationId === input.organizationId)
      .filter((run) => !input.variant || run.variant === input.variant)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, input.limit ?? 20);
  }
}
