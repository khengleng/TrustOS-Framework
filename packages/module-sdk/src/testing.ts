import { createNullLogger, type LoggerPort } from '@trustsystem/logging';
import {
  createModuleContext,
  InMemoryTenantSettingsStore,
  type ModuleAuditInput,
  type ModuleAuditPort,
  type ModuleContext,
  type ModuleEnvironment,
  type PrismaLike,
  type TenantSettingsStore,
} from './context';
import type { TrustosModule } from './definition';

/**
 * Test doubles, shipped with the SDK.
 *
 * Every module is required to prove its own tenant isolation, RBAC behaviour and
 * configuration validation. That is only realistic if the harness comes with the
 * SDK — otherwise each module invents its own, and the ones written last are the
 * thinnest.
 */

/** Collects audit records instead of writing them. */
export class RecordingAuditPort implements ModuleAuditPort {
  readonly records: ModuleAuditInput[] = [];

  record(input: ModuleAuditInput): Promise<void> {
    this.records.push(input);
    return Promise.resolve();
  }

  /** Records for one action, in order. */
  byAction(action: string): ModuleAuditInput[] {
    return this.records.filter((record) => record.action === action);
  }

  /** Serialized trail, for asserting that a secret never reached it. */
  serialized(): string {
    return JSON.stringify(this.records);
  }

  clear(): void {
    this.records.length = 0;
  }
}

export interface TestModuleContextOptions {
  config?: unknown;
  logger?: LoggerPort;
  audit?: RecordingAuditPort;
  environment?: ModuleEnvironment;
  /** Fixed instant, so assertions on timestamps are stable. */
  now?: Date;
  prisma?: PrismaLike | null;
  tenantSettings?: TenantSettingsStore;
}

export interface TestModuleContext<TConfig> {
  context: ModuleContext<TConfig>;
  audit: RecordingAuditPort;
  tenantSettings: TenantSettingsStore;
}

/**
 * Builds a context suitable for testing a module.
 *
 * The clock is fixed rather than advancing: a module that reads `clock()` twice
 * and gets two different values will produce test failures that depend on how
 * fast the machine is, and those failures get retried away rather than fixed.
 * Tests that need time to move call `advance()` on their own clock.
 */
export function createTestModuleContext<TConfig>(
  module: TrustosModule<TConfig>,
  options: TestModuleContextOptions = {},
): TestModuleContext<TConfig> {
  const audit = options.audit ?? new RecordingAuditPort();
  const tenantSettings = options.tenantSettings ?? new InMemoryTenantSettingsStore();
  const fixed = options.now ?? new Date('2026-01-01T00:00:00.000Z');

  const context = createModuleContext<TConfig>({
    moduleId: module.metadata.id,
    configSchema: module.configSchema,
    config: options.config ?? {},
    logger: options.logger ?? createNullLogger(),
    audit,
    environment: options.environment ?? 'test',
    clock: () => fixed,
    prisma: options.prisma ?? null,
    tenantSettings,
  });

  return { context, audit, tenantSettings };
}

/** A clock a test can move forward, for SLA and retry assertions. */
export function createTestClock(start: Date = new Date('2026-01-01T00:00:00.000Z')): {
  now: () => Date;
  advanceMinutes: (minutes: number) => void;
  advanceMs: (milliseconds: number) => void;
} {
  let current = start.getTime();

  return {
    now: () => new Date(current),
    advanceMinutes: (minutes) => void (current += minutes * 60_000),
    advanceMs: (milliseconds) => void (current += milliseconds),
  };
}
