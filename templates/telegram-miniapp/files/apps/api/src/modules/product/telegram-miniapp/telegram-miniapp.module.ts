import { Module } from '@nestjs/common';
import {
  MiniAppUserController,
  MiniAppSessionController,
  DeepLinkController,
  MenuEntryController,
  MiniAppNotificationSettingController,
} from './telegram-miniapp.controller';
import { TelegramMiniappService } from './telegram-miniapp.service';

/**
 * TrustOS Telegram Mini App domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [
    MiniAppUserController,
    MiniAppSessionController,
    DeepLinkController,
    MenuEntryController,
    MiniAppNotificationSettingController,
  ],
  providers: [TelegramMiniappService],
  exports: [TelegramMiniappService],
})
export class TelegramMiniappDomainModule {}
