/**
 * Every console screen, in menu order.
 *
 * Parent layers first: telegram-miniapp -> whatsapp-miniapp. A child that wanted to reorder or
 * hide a parent screen would filter this array, never edit the parent file.
 */

import type { ResourceDefinition } from '@trustsystem/template-sdk';
import { TELEGRAM_MINIAPP_RESOURCES } from './resources-telegram-miniapp';
import { WHATSAPP_MINIAPP_RESOURCES } from './resources-whatsapp-miniapp';

export const RESOURCES: ResourceDefinition[] = [
  ...TELEGRAM_MINIAPP_RESOURCES,
  ...WHATSAPP_MINIAPP_RESOURCES,
];
