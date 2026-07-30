/**
 * Every console screen, in menu order.
 *
 * One generic page renders every entry, so adding a screen is a line in the resource file rather
 * than another near-identical page component.
 */

import type { ResourceDefinition } from '@trustos/template-sdk';
import { MICROLOAN_RESOURCES } from './resources-microloan';

export const RESOURCES: ResourceDefinition[] = [...MICROLOAN_RESOURCES];
