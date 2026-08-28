/**
 * @trustos/module-document
 *
 * Categorised documents with metadata, append-only version history and soft
 * delete. Content is held through the file-storage module's `StorageProvider`
 * port, which is why containment logic exists once in the framework rather than
 * twice.
 */
export * from './config';
export * from './store';
export * from './document.service';
export * from './document.module';
