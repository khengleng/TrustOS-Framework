import { Module } from '@nestjs/common';
import {
  BankCustomerController,
  BankAccountController,
  AccountStatementController,
  CustomerNotificationPreferenceController,
} from './digital-bank.controller';
import { DigitalBankService } from './digital-bank.service';

/**
 * TrustOS Digital Bank domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [
    BankCustomerController,
    BankAccountController,
    AccountStatementController,
    CustomerNotificationPreferenceController,
  ],
  providers: [DigitalBankService],
  exports: [DigitalBankService],
})
export class DigitalBankDomainModule {}
