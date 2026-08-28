/**
 * Every console screen, in menu order.
 *
 * One generic page renders every entry, so adding a screen is a line in the resource file rather
 * than another near-identical page component.
 */

import type { ResourceDefinition } from '@trustos/template-sdk';
import { DEVELOPER_PORTAL_RESOURCES } from './resources-developer-portal';

export const RESOURCES: ResourceDefinition[] = [...DEVELOPER_PORTAL_RESOURCES];
