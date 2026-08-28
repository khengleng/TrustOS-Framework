/**
 * @trustos/backup
 *
 * What was backed up, where, encrypted, and how strongly that is known.
 *
 * Four independent claims rather than one status: completed, checksummed, inspected, restored
 * from. Only the fourth means what "we have backups" is usually taken to mean, and a job exiting
 * zero establishes only the first.
 */
export * from './backup';
