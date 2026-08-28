import { DynamicModule, Module } from '@nestjs/common';
import {
  moduleProviders,
  moduleServiceProvider,
  type ModuleHostBinding,
} from '@trustos/module-sdk/nest';
import { notificationModule, type NotificationInstance } from '../notification.module';
import { NotificationController } from './notification.controller';
import { NOTIFICATION_SERVICE } from './tokens';

/** NestJS wiring for the notification module. */
@Module({})
export class NotificationModule {
  static forRoot(binding: ModuleHostBinding): DynamicModule {
    return {
      module: NotificationModule,
      controllers: [NotificationController],
      providers: [
        ...moduleProviders(notificationModule, binding),
        moduleServiceProvider<NotificationInstance, NotificationInstance['service']>(
          'notification',
          NOTIFICATION_SERVICE,
          (instance) => instance.service,
        ),
      ],
      // Exported so product code and other modules — a workflow escalation hook,
      // for instance — can send messages through the same queue and audit trail.
      exports: [NOTIFICATION_SERVICE],
    };
  }
}
