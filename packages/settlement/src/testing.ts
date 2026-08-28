import type {
  SettlementAdjustment,
  SettlementBatch,
  SettlementInstruction,
  SettlementStatus,
  SettlementStore,
} from './settlement';

/** In-memory settlement stores, for tests and development. */
export class InMemorySettlementStore implements SettlementStore {
  readonly batches = new Map<string, SettlementBatch>();
  readonly instructionsById = new Map<string, SettlementInstruction>();
  readonly adjustmentsById = new Map<string, SettlementAdjustment>();

  async createBatch(batch: SettlementBatch): Promise<SettlementBatch> {
    this.batches.set(batch.id, batch);
    return batch;
  }

  async findBatch(id: string, organizationId: string | null): Promise<SettlementBatch | null> {
    const batch = this.batches.get(id);
    if (!batch || batch.organizationId !== organizationId) return null;
    return batch;
  }

  async updateBatch(id: string, patch: Partial<SettlementBatch>): Promise<SettlementBatch | null> {
    const batch = this.batches.get(id);
    if (!batch) return null;

    const updated = { ...batch, ...patch } as SettlementBatch;
    this.batches.set(id, updated);
    return updated;
  }

  async listBatches(input: {
    organizationId: string | null;
    status?: SettlementStatus;
    currency?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }): Promise<SettlementBatch[]> {
    return [...this.batches.values()]
      .filter((batch) => batch.organizationId === input.organizationId)
      .filter((batch) => !input.status || batch.status === input.status)
      .filter((batch) => !input.currency || batch.currency === input.currency)
      .filter((batch) => !input.from || batch.windowEnd >= input.from)
      .filter((batch) => !input.to || batch.windowStart <= input.to)
      .sort((a, b) => b.windowEnd.getTime() - a.windowEnd.getTime())
      .slice(0, input.limit ?? 200);
  }

  async addAdjustment(adjustment: SettlementAdjustment): Promise<SettlementAdjustment> {
    this.adjustmentsById.set(adjustment.id, adjustment);
    return adjustment;
  }

  async adjustments(
    batchId: string,
    organizationId: string | null,
  ): Promise<SettlementAdjustment[]> {
    return [...this.adjustmentsById.values()]
      .filter(
        (adjustment) =>
          adjustment.batchId === batchId && adjustment.organizationId === organizationId,
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  }

  async addInstruction(instruction: SettlementInstruction): Promise<SettlementInstruction> {
    this.instructionsById.set(instruction.id, instruction);
    return instruction;
  }

  async findInstruction(
    id: string,
    organizationId: string | null,
  ): Promise<SettlementInstruction | null> {
    const instruction = this.instructionsById.get(id);
    if (!instruction || instruction.organizationId !== organizationId) return null;
    return instruction;
  }

  async updateInstruction(
    id: string,
    patch: Partial<SettlementInstruction>,
  ): Promise<SettlementInstruction | null> {
    const instruction = this.instructionsById.get(id);
    if (!instruction) return null;

    const updated = { ...instruction, ...patch } as SettlementInstruction;
    this.instructionsById.set(id, updated);
    return updated;
  }

  async instructions(
    batchId: string,
    organizationId: string | null,
  ): Promise<SettlementInstruction[]> {
    return [...this.instructionsById.values()]
      .filter(
        (instruction) =>
          instruction.batchId === batchId && instruction.organizationId === organizationId,
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  }
}
