import { Module } from '@nestjs/common';
import {
  AcademicTermController,
  ClassGroupController,
  AttendanceController,
  GradeController,
  GuardianController,
} from './school.controller';
import { SchoolService } from './school.service';

/**
 * TrustOS School domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [
    AcademicTermController,
    ClassGroupController,
    AttendanceController,
    GradeController,
    GuardianController,
  ],
  providers: [SchoolService],
  exports: [SchoolService],
})
export class SchoolDomainModule {}
