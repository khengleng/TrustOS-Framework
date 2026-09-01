import { moduleDeclarations } from '@trustsystem/module-registry';
import {
  defineModule,
  moduleHealthIndicator,
  type HealthIndicator,
  type ModuleContext,
  type ModuleInstance,
} from '@trustsystem/module-sdk';
import { createMockChannels, type ChannelId, type NotificationChannel } from './channels';
import { notificationConfigSchema, type NotificationConfig } from './config';
import { InMemoryRetryQueue, type RetryQueue } from './delivery';
import { NotificationService } from './notification.service';
import { PrismaNotificationStore, type NotificationStore } from './store';

export interface NotificationInstance extends ModuleInstance {
  readonly service: NotificationService;
  readonly queue: RetryQueue;
}

export interface NotificationOverrides {
  store?: NotificationStore;
  channels?: Map<ChannelId, NotificationChannel>;
  queue?: RetryQueue;
}

/**
 * Builds the module.
 *
 * The channel map, the queue and the store are all replaceable, which is what
 * makes the delivery pipeline testable without a network, a timer or a database.
 */
export function createNotification(
  context: ModuleContext<NotificationConfig>,
  overrides: NotificationOverrides = {},
): NotificationInstance {
  const channels = overrides.channels ?? createMockChannels();
  const queue = overrides.queue ?? new InMemoryRetryQueue();
  const store = overrides.store ?? new PrismaNotificationStore(context);
  const service = new NotificationService(context, store, channels, queue);

  return {
    moduleId: 'notification',
    service,
    queue,

    async initialize(): Promise<void> {
      if (!context.prisma && !overrides.store) {
        throw new Error(
          'notification needs a database. Run the module migration and provide the Prisma client.',
        );
      }

      // Said out loud at start-up rather than left in the documentation: an
      // operator reading logs should know that nothing is being delivered.
      context.logger.warn(
        {
          moduleId: 'notification',
          channels: [...channels.keys()],
          enabled: context.config.enabledChannels,
        },
        'notification module initialized with mock channels: no message leaves this process',
      );
    },

    async shutdown(): Promise<void> {
      const remaining = await queue.size();
      if (remaining > 0) {
        // Not drained on the way out: finishing deliveries during shutdown means
        // an unbounded delay before the process exits, and the platform kills it
        // anyway. The queue's durability is the queue implementation's problem.
        context.logger.warn(
          { moduleId: 'notification', pending: remaining },
          'notification module stopped with deliveries still queued',
        );
      }
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('notification', async () => {
        const pending = await queue.size();
        const registered = [...channels.keys()].join(', ');

        // A backlog is reported as degraded rather than down: messages are still
        // being accepted, and taking the instance out of rotation would stop the
        // requests that drain the queue.
        return pending > 1000
          ? { status: 'degraded', detail: `${pending} deliveries queued (${registered})` }
          : { status: 'ok', detail: `${pending} queued, channels: ${registered}` };
      });
    },
  };
}

export const notificationModule = defineModule<NotificationConfig>({
  ...moduleDeclarations('notification'),
  configSchema: notificationConfigSchema,
  tenantScoped: true,
  create: (context) => createNotification(context),
});
