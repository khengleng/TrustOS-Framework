import { Module } from '@nestjs/common';
import { MessengerProfileController } from './messenger-miniapp.controller';
import { MessengerMiniappService } from './messenger-miniapp.service';

/**
 * TrustOS Messenger Mini App domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [MessengerProfileController],
  providers: [MessengerMiniappService],
  exports: [MessengerMiniappService],
})
export class MessengerMiniappDomainModule {}
