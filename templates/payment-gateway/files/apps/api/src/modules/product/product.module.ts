import { Module } from '@nestjs/common';
import {
  ApiKeysController,
  MerchantAccountsController,
  PaymentsController,
  WebhookEndpointsController,
} from './product.controller';
import { ProductService } from './product.service';

/**
 * Payment gateway product module.
 *
 * The payment provider is constructed inside ProductService and is a mock in
 * this phase. Integrating a real provider means providing a different
 * implementation of the PaymentProvider port — not changing the payment flow.
 */
@Module({
  controllers: [
    MerchantAccountsController,
    ApiKeysController,
    PaymentsController,
    WebhookEndpointsController,
  ],
  providers: [ProductService],
  exports: [ProductService],
})
export class ProductModule {}
