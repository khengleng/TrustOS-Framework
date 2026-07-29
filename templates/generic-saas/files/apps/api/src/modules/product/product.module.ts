import { Module } from '@nestjs/common';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';

/**
 * Product module.
 *
 * `AppModule` imports this by a fixed name, so replacing the example entity
 * with your own domain is a change inside this folder rather than a change to
 * the composition root.
 */
@Module({
  controllers: [ProductController],
  providers: [ProductService],
  exports: [ProductService],
})
export class ProductModule {}
