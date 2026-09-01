/**
 * Every console screen, in menu order.
 *
 * Parent layers first: education -> school. A child that wanted to reorder or hide a parent
 * screen would filter this array, never edit the parent file.
 */

import type { ResourceDefinition } from '@trustsystem/template-sdk';
import { EDUCATION_RESOURCES } from './resources-education';
import { SCHOOL_RESOURCES } from './resources-school';

export const RESOURCES: ResourceDefinition[] = [...EDUCATION_RESOURCES, ...SCHOOL_RESOURCES];
