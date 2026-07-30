/**
 * Every console screen, in menu order.
 *
 * Parent layers first: clinic -> hospital. A child that wanted to reorder or hide a parent
 * screen would filter this array, never edit the parent file.
 */

import type { ResourceDefinition } from '@trustos/template-sdk';
import { CLINIC_RESOURCES } from './resources-clinic';
import { HOSPITAL_RESOURCES } from './resources-hospital';

export const RESOURCES: ResourceDefinition[] = [...CLINIC_RESOURCES, ...HOSPITAL_RESOURCES];
