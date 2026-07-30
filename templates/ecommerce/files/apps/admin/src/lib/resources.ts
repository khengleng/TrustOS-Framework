/**
 * Every console screen, in menu order.
 *
 * Parent layers first: merchant -> ecommerce. A child that wanted to reorder or hide a parent
 * screen would filter this array, never edit the parent file.
 */

import type { ResourceDefinition } from '@trustos/template-sdk';
import { RESOURCES as MERCHANT_RESOURCES } from './resources-merchant';
import { ECOMMERCE_RESOURCES } from './resources-ecommerce';

export const RESOURCES: ResourceDefinition[] = [...MERCHANT_RESOURCES, ...ECOMMERCE_RESOURCES];
