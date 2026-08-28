import { Module } from '@nestjs/common';
import { WhatsAppProfileController } from './whatsapp-miniapp.controller';
import { WhatsappMiniappService } from './whatsapp-miniapp.service';

/**
 * TrustOS WhatsApp Mini App domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [WhatsAppProfileController],
  providers: [WhatsappMiniappService],
  exports: [WhatsappMiniappService],
})
export class WhatsappMiniappDomainModule {}
