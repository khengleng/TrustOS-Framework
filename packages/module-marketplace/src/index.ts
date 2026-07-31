/**
 * @trustos/module-marketplace
 *
 * Browse, search, categorize, rate and verify modules.
 *
 * There is no remote registry, and that is the design — the catalogue is local and
 * version-controlled, exactly as the template registry is. Every property that makes the supply
 * chain tractable comes from it: no dependency confusion, no typosquatting, no compromised
 * mirror, no install-time network. Adding a private source is a deliberate act with a signing key
 * attached, not a URL in a config file.
 */
export * from './marketplace';
