/**
 * Every console screen, in menu order.
 *
 * Parent layers first: telegram-miniapp -> messenger-miniapp. A child that wanted to reorder or
 * hide a parent screen would filter this array, never edit the parent file.
 */

import type { ResourceDefinition } from '@trustos/template-sdk';
import { TELEGRAM_MINIAPP_RESOURCES } from './resources-telegram-miniapp';
import { MESSENGER_MINIAPP_RESOURCES } from './resources-messenger-miniapp';

export const RESOURCES: ResourceDefinition[] = [
  ...TELEGRAM_MINIAPP_RESOURCES,
  ...MESSENGER_MINIAPP_RESOURCES,
];
