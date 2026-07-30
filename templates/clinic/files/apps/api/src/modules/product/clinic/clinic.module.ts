import { Module } from '@nestjs/common';
import {
  PatientController,
  PractitionerController,
  AppointmentController,
  MedicalRecordEntryController,
  ClinicInvoiceController,
} from './clinic.controller';
import { ClinicService } from './clinic.service';

/**
 * TrustOS Clinic domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [
    PatientController,
    PractitionerController,
    AppointmentController,
    MedicalRecordEntryController,
    ClinicInvoiceController,
  ],
  providers: [ClinicService],
  exports: [ClinicService],
})
export class ClinicDomainModule {}
