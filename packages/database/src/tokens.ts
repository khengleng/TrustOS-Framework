/**
 * Injection tokens.
 *
 * Declared here rather than in each Nest module so that a package can depend
 * on a token without depending on the module that provides it.
 */
export const APP_CONFIG = Symbol.for('trustos.app-config');
export const DATABASE_LOGGER = Symbol.for('trustos.database-logger');
