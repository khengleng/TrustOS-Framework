import { Module } from '@nestjs/common';
import { WidgetsController } from './widgets.controller';
import { WidgetsRepository } from './widgets.repository';
import { WidgetsService } from './widgets.service';

@Module({
  controllers: [WidgetsController],
  providers: [WidgetsService, WidgetsRepository],
  exports: [WidgetsService],
})
export class WidgetsModule {}
