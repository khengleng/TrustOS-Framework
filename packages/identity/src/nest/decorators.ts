import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { AuthenticationLevel } from '@trustsystem/security-policy';
import type { ActorType } from '@trustsystem/shared-types';
import { IDENTITY_METADATA } from './metadata';

/**
 * Requires a completed second factor.
 *
 *   @RequireMfa()
 *   @Delete('organizations/:id')
 *   deleteOrganization() {}
 *
 * Enforced by `AuthenticationAssuranceGuard`, which reads what the identity
 * provider reported in `acr` and `amr` — never anything the client supplied.
 *
 * With the local provider this refuses every request, because local
 * authentication has no second factor. That is the correct behaviour and it is
 * why the guard's error says so: a route that silently accepted a single factor
 * because the deployment happened to be local would be a route whose protection
 * depends on configuration nobody re-read.
 */
export function RequireMfa(): CustomDecorator<string> {
  return SetMetadata(IDENTITY_METADATA.REQUIRE_MFA, true);
}

/**
 * Requires a minimum authentication assurance.
 *
 *   @RequireAuthenticationLevel('high')
 *
 * `high` means a second factor was completed; `medium` means a single factor
 * against a real identity provider; `low` is everything else. An unrecognised
 * `acr` produces `low`, because "the framework does not know what happened" reads
 * safely only one way.
 */
export function RequireAuthenticationLevel(level: AuthenticationLevel): CustomDecorator<string> {
  return SetMetadata(IDENTITY_METADATA.REQUIRE_LEVEL, level);
}

/**
 * Restricts a route to human callers.
 *
 * For interactive flows — a login form, a consent screen, a password change. A
 * service account reaching one of these is either a misconfiguration or a misuse,
 * and both are worth blocking and recording rather than serving.
 */
export function HumanActorsOnly(): CustomDecorator<string> {
  return SetMetadata(IDENTITY_METADATA.HUMANS_ONLY, true);
}

/**
 * Restricts a route to particular actor types.
 *
 *   @AllowActorTypes('service_account', 'api_key')
 *
 * For the other direction: a machine-to-machine endpoint that a person's session
 * should not be able to call, so a stolen browser session cannot reach it.
 */
export function AllowActorTypes(...types: ActorType[]): CustomDecorator<string> {
  return SetMetadata(IDENTITY_METADATA.ACTOR_TYPES, types);
}
