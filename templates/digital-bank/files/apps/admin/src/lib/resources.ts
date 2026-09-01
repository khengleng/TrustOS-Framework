/**
 * Every console screen, in menu order.
 *
 * Parent layers first: wallet -> digital-bank. A child that wanted to reorder or hide a parent
 * screen would filter this array, never edit the parent file.
 */

import type { ResourceDefinition } from '@trustsystem/template-sdk';
import { WALLET_RESOURCES } from './resources-wallet';
import { DIGITAL_BANK_RESOURCES } from './resources-digital-bank';

export const RESOURCES: ResourceDefinition[] = [...WALLET_RESOURCES, ...DIGITAL_BANK_RESOURCES];
