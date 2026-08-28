import { Module } from '@nestjs/common';
import { EducationDomainModule } from './education/education.module';
import { SchoolDomainModule } from './school/school.module';

/**
 * The product module `AppModule` imports.
 *
 * An aggregator over the template chain (education -> school). It exists so the composition root
 * has one fixed name to import, and so a layer can be added without anybody editing
 * app.module.ts.
 */
@Module({
  imports: [EducationDomainModule, SchoolDomainModule],
  exports: [EducationDomainModule, SchoolDomainModule],
})
export class ProductModule {}
