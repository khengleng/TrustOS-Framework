/**
 * @trustsystem/plugin-framework
 *
 * Plugin manifests, declared permissions, signature verification and the extension points a
 * plugin may claim.
 *
 * The security model, stated plainly because the alternative is that somebody assumes a stronger
 * one: **this does not sandbox anything.** Node has no usable in-process sandbox, and a framework
 * that claimed otherwise would be the most dangerous thing in the phase. What it does is refuse
 * to install code that is unsigned, signed by an unknown key, or asking for permissions the
 * deployment has not granted — and make what a plugin *can* do visible before it is installed.
 *
 * The rest is review, and `docs/plugin-development.md` says so.
 */
export * from './signing';
export * from './manifest';
export * from './registry';
