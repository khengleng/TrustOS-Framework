/**
 * Every console screen, in menu order.
 *
 * One generic page renders every entry, so adding a screen is a line in the resource file rather
 * than another near-identical page component.
 */

import type { ResourceDefinition } from '@trustos/template-sdk';
import { CUSTOMER_PORTAL_RESOURCES } from './resources-customer-portal';

export const RESOURCES: ResourceDefinition[] = [...CUSTOMER_PORTAL_RESOURCES];
