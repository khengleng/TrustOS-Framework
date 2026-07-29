import { Module } from '@nestjs/common';
import { MiniAppController, TasksController } from './product.controller';
import { ProductService } from './product.service';

/**
 * Telegram Mini App product module.
 *
 * The authentication boundary is validateInitData, called from
 * ProductService.openSession. Everything else is ordinary tenant-scoped CRUD.
 */
@Module({
  controllers: [MiniAppController, TasksController],
  providers: [ProductService],
  exports: [ProductService],
})
export class ProductModule {}
