import { Module } from '@nestjs/common';
import {
  ProgrammeController,
  NgoProjectController,
  DonorController,
  DonationController,
  BeneficiaryController,
  FieldReportController,
} from './ngo.controller';
import { NgoService } from './ngo.service';

/**
 * TrustOS NGO domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [
    ProgrammeController,
    NgoProjectController,
    DonorController,
    DonationController,
    BeneficiaryController,
    FieldReportController,
  ],
  providers: [NgoService],
  exports: [NgoService],
})
export class NgoDomainModule {}
