/**
 * Injection token for the module's service.
 *
 * `Symbol.for` rather than the class: the controller and the provider that
 * supplies the service can end up in different resolved copies of the package
 * once npm has installed it into an application, and a class token compares by
 * identity. A registered symbol compares by name.
 */
export const FILE_STORAGE_SERVICE = Symbol.for('trustos.module.file-storage.service');
