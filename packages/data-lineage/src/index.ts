/**
 * @trustos/data-lineage
 *
 * Where governed data came from and where it goes.
 *
 * **Not an ETL scanner.** One that parses SQL is right about the queries it understands and
 * silent about the rest, and "silent" in a lineage graph reads exactly like "no dependency". So
 * lineage is declared, with an extension interface for a deployment that has a scanner — and a
 * scanned edge is marked as scanned, so an investigation can weigh it differently.
 *
 * `propagatedClassification` is the inference that makes the graph worth maintaining: a report
 * declared `INTERNAL` whose sources include a restricted column is restricted, and nobody would
 * notice by reading the report's own row.
 */
export * from './lineage';
