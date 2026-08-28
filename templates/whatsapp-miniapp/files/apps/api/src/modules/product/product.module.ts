import { Module } from '@nestjs/common';
import { TelegramMiniappDomainModule } from './telegram-miniapp/telegram-miniapp.module';
import { WhatsappMiniappDomainModule } from './whatsapp-miniapp/whatsapp-miniapp.module';

/**
 * The product module `AppModule` imports.
 *
 * An aggregator over the template chain (telegram-miniapp -> whatsapp-miniapp). It exists so the
 * composition root has one fixed name to import, and so a layer can be added without anybody
 * editing app.module.ts.
 */
@Module({
  imports: [TelegramMiniappDomainModule, WhatsappMiniappDomainModule],
  exports: [TelegramMiniappDomainModule, WhatsappMiniappDomainModule],
})
export class ProductModule {}
