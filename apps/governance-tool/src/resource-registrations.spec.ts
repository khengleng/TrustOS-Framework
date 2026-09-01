import { describe, expect, it } from 'vitest';
import { resourceRegistrationsFor, resourceRegistryFor } from './resource-registrations';

describe('resource registrations', () => {
  /*
   * This is the assertion that matters most, and it is deliberately an assertion about
   * emptiness. Nothing has been approved for any environment yet, because an approval needs a
   * named owner and a separate named approver — facts about an organisation, not values a
   * developer can supply. If this test ever fails, someone has added a registration, and the
   * question to ask of the diff is whether the owner and approver in it are real.
   */
  it.each(['dev', 'uat', 'prod'] as const)('declares nothing for %s until approved', (env) => {
    expect(resourceRegistrationsFor(env)).toEqual([]);
  });

  it('builds a registry for every environment without throwing', () => {
    for (const env of ['dev', 'uat', 'prod'] as const) {
      expect(() => resourceRegistryFor(env)).not.toThrow();
    }
  });

  it('refuses a read against an unregistered resource, which is the honest answer', () => {
    const registry = resourceRegistryFor('prod');

    expect(() => registry.require('prod', 'reporting.transactions')).toThrow(
      /No approved resource/,
    );
  });

  it('does not resolve a resource from a different environment', () => {
    const registry = resourceRegistryFor('prod');

    expect(registry.find('dev', 'reporting.transactions')).toBeUndefined();
  });
});
