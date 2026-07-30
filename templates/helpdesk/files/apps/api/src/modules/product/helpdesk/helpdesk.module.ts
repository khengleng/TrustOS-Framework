import { Module } from '@nestjs/common';
import {
  TicketQueueController,
  SupportAgentController,
  SlaPolicyController,
  TicketController,
  TicketCommentController,
} from './helpdesk.controller';
import { HelpdeskService } from './helpdesk.service';

/**
 * TrustOS Helpdesk domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [
    TicketQueueController,
    SupportAgentController,
    SlaPolicyController,
    TicketController,
    TicketCommentController,
  ],
  providers: [HelpdeskService],
  exports: [HelpdeskService],
})
export class HelpdeskDomainModule {}
