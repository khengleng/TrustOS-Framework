import { Module } from '@nestjs/common';
import { ClinicDomainModule } from './clinic/clinic.module';
import { HospitalDomainModule } from './hospital/hospital.module';

/**
 * The product module `AppModule` imports.
 *
 * An aggregator over the template chain (clinic -> hospital). It exists so the composition root
 * has one fixed name to import, and so a layer can be added without anybody editing
 * app.module.ts.
 */
@Module({
  imports: [ClinicDomainModule, HospitalDomainModule],
  exports: [ClinicDomainModule, HospitalDomainModule],
})
export class ProductModule {}
