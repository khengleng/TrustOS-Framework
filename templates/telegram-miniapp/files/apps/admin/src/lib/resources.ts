/**
 * Every console screen, in menu order.
 *
 * One generic page renders every entry, so adding a screen is a line in the resource file rather
 * than another near-identical page component.
 */

import type { ResourceDefinition } from '@trustsystem/template-sdk';
import { TELEGRAM_MINIAPP_RESOURCES } from './resources-telegram-miniapp';

export const RESOURCES: ResourceDefinition[] = [...TELEGRAM_MINIAPP_RESOURCES];
