/**
 * @trustos/financial-reporting
 *
 * General ledger, trial balance, balance sheet and statements, with CSV export.
 *
 * Every report states the moment it was taken, and no report posts anything. The framework ships
 * CSV only: Excel needs a spreadsheet library and PDF a rendering engine, and which one to use is
 * a deployment decision — `ReportRenderer` is the seam.
 */
export * from './reports';
