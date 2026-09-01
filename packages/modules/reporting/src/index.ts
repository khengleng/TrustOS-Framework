/**
 * @trustsystem/module-reporting
 *
 * Declarative report definitions with filtering, pagination, CSV export, a PDF
 * renderer port and a scheduled-report interface.
 *
 * Two things to know before changing it: report definitions are code rather than
 * rows (a runtime-authored report is a query builder), and `escapeCsvCell` is a
 * security control, not formatting.
 */
export * from './config';
export * from './report';
export * from './export';
export * from './schedule';
export * from './reporting.service';
export * from './reporting.module';
