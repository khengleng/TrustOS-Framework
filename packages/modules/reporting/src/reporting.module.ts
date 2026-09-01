import { moduleDeclarations } from '@trustsystem/module-registry';
import {
  defineModule,
  moduleHealthIndicator,
  type HealthIndicator,
  type ModuleContext,
  type ModuleInstance,
} from '@trustsystem/module-sdk';
import { reportingConfigSchema, type ReportingConfig } from './config';
import { UnavailablePdfRenderer, type PdfRenderer } from './export';
import { ReportingService } from './reporting.service';
import { PrismaReportScheduleStore, type ReportScheduleStore } from './schedule';

export interface ReportingInstance extends ModuleInstance {
  readonly service: ReportingService;
}

export interface ReportingOverrides {
  schedules?: ReportScheduleStore;
  pdf?: PdfRenderer;
}

export function createReporting(
  context: ModuleContext<ReportingConfig>,
  overrides: ReportingOverrides = {},
): ReportingInstance {
  const pdf = overrides.pdf ?? new UnavailablePdfRenderer();
  const schedules = overrides.schedules ?? new PrismaReportScheduleStore(context);
  const service = new ReportingService(context, schedules, pdf);

  return {
    moduleId: 'reporting',
    service,

    async initialize(): Promise<void> {
      if (!context.prisma && !overrides.schedules) {
        throw new Error(
          'reporting needs a database for schedules. Run the module migration and provide the Prisma client.',
        );
      }

      if (context.config.pdfEnabled && pdf.id === 'unavailable') {
        // Refused rather than warned: an application that advertises PDF export
        // and has no renderer fails on the export, in front of a user.
        throw new Error(
          'reporting has pdfEnabled but no PdfRenderer. Provide one, or set pdfEnabled to false.',
        );
      }
    },

    async shutdown(): Promise<void> {
      // Nothing to release; the module owns no scheduler.
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('reporting', async () => ({
        status: 'ok',
        detail: `pdf renderer: ${pdf.id}`,
      }));
    },
  };
}

export const reportingModule = defineModule<ReportingConfig>({
  ...moduleDeclarations('reporting'),
  configSchema: reportingConfigSchema,
  tenantScoped: true,
  create: (context) => createReporting(context),
});
