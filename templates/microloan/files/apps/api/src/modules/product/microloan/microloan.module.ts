import { Module } from '@nestjs/common';
import {
  BorrowerController,
  LoanProductController,
  LoanApplicationController,
  LoanAccountController,
  RepaymentInstalmentController,
  RepaymentController,
} from './microloan.controller';
import { MicroloanService } from './microloan.service';

/**
 * TrustOS Microloan domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [
    BorrowerController,
    LoanProductController,
    LoanApplicationController,
    LoanAccountController,
    RepaymentInstalmentController,
    RepaymentController,
  ],
  providers: [MicroloanService],
  exports: [MicroloanService],
})
export class MicroloanDomainModule {}
