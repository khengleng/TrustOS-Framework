/**
 * @trustos/data-catalog
 *
 * What governed data exists, what it means, who owns it and how sensitive it is.
 *
 * Nine entity kinds, because "where is customer data" is answered wrongly by a catalog that only
 * knows about tables — it is also in an event payload, an API response, a report and an AI
 * knowledge source, and those are the copies nobody remembers.
 *
 * `inheritedClassification` is the function that earns the package: a table declared `INTERNAL`
 * whose columns include a national identifier is `HIGHLY_RESTRICTED` whatever the table row says.
 * Tables are classified when they are created; columns are added later.
 */
export * from './catalog';
