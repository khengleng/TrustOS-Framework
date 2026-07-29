import { Module } from '@nestjs/common';
import {
  LearningSessionsController,
  ProgressController,
  QuizAttemptsController,
  StudentsController,
} from './product.controller';
import { ProductService } from './product.service';

/**
 * Learning product module.
 *
 * `AppModule` imports this by a fixed name, so replacing the domain is a
 * change inside this folder rather than a change to the composition root.
 */
@Module({
  controllers: [
    StudentsController,
    LearningSessionsController,
    QuizAttemptsController,
    ProgressController,
  ],
  providers: [ProductService],
  exports: [ProductService],
})
export class ProductModule {}
