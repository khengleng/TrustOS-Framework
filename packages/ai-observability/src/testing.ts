import type { AiRequestRecord, TelemetryStore } from './telemetry';

/**
 * An in-memory telemetry store, for tests and development.
 *
 * Bounded per tenant, like a real one should be. Telemetry is the highest-volume thing an AI
 * platform writes, and an unbounded in-memory store is a memory leak that only shows up under the
 * traffic that made somebody open the dashboard.
 */
export class InMemoryTelemetryStore implements TelemetryStore {
  readonly records = new Map<string, AiRequestRecord[]>();

  constructor(private readonly maxPerTenant = 10_000) {}

  async record(entry: AiRequestRecord): Promise<void> {
    const key = entry.organizationId ?? '__platform__';
    const existing = this.records.get(key) ?? [];

    existing.push(entry);
    if (existing.length > this.maxPerTenant)
      existing.splice(0, existing.length - this.maxPerTenant);

    this.records.set(key, existing);
  }

  async query(input: {
    organizationId: string | null;
    since?: Date;
    until?: Date;
    agentId?: string;
    modelId?: string;
    provider?: string;
    application?: string;
    limit?: number;
  }): Promise<AiRequestRecord[]> {
    return (this.records.get(input.organizationId ?? '__platform__') ?? [])
      .filter((record) => !input.since || record.at >= input.since)
      .filter((record) => !input.until || record.at <= input.until)
      .filter((record) => !input.agentId || record.agentId === input.agentId)
      .filter((record) => !input.modelId || record.modelId === input.modelId)
      .filter((record) => !input.provider || record.provider === input.provider)
      .filter((record) => !input.application || record.application === input.application)
      .slice(-(input.limit ?? 10_000));
  }
}
