import { DynamicModule, Module } from '@nestjs/common';
import { moduleProviders, type ModuleHostBinding } from '@trustos/module-sdk/nest';
import { webhookModule } from '../webhook.module';

/**
 * NestJS wiring for the webhooks module.
 *
 * Registers the lifecycle and the health indicator. The framework packages have their own Nest
 * modules for the services themselves — importing this one does not import those, so an
 * application chooses what it actually wires.
 */
@Module({})
export class WebhookModule {
  static forRoot(binding: ModuleHostBinding): DynamicModule {
    return {
      module: WebhookModule,
      providers: [...moduleProviders(webhookModule, binding)],
      exports: [],
    };
  }
}
