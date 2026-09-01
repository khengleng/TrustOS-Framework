import { DynamicModule, Module } from '@nestjs/common';
import {
  moduleProviders,
  moduleServiceProvider,
  type ModuleHostBinding,
} from '@trustsystem/module-sdk/nest';
import { reportingModule, type ReportingInstance } from '../reporting.module';
import { ReportingController } from './reporting.controller';
import { REPORTING_SERVICE } from './tokens';

/**
 * NestJS wiring for the reporting module.
 *
 * The service is exported because an application has to reach it to register its
 * own report definitions — that is the one thing reporting cannot do for itself.
 */
@Module({})
export class ReportingModule {
  static forRoot(binding: ModuleHostBinding): DynamicModule {
    return {
      module: ReportingModule,
      controllers: [ReportingController],
      providers: [
        ...moduleProviders(reportingModule, binding),
        moduleServiceProvider<ReportingInstance, ReportingInstance['service']>(
          'reporting',
          REPORTING_SERVICE,
          (instance) => instance.service,
        ),
      ],
      exports: [REPORTING_SERVICE],
    };
  }
}
