/**
 * Every console screen, in menu order.
 *
 * One generic page renders every entry, so adding a screen is a line in the resource file rather
 * than another near-identical page component.
 */

import type { ResourceDefinition } from '@trustsystem/template-sdk';
import { GOVERNMENT_RESOURCES } from './resources-government';

export const RESOURCES: ResourceDefinition[] = [...GOVERNMENT_RESOURCES];
