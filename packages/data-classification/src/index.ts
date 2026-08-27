/**
 * @trustos/data-classification
 *
 * The five-level classification model, and what each level **obliges**.
 *
 * The value is not the label. A scheme whose levels only differ in name is a scheme where
 * everything is eventually `internal`, because nothing follows from choosing anything else. Each
 * level here carries masking, export, reveal, residency, retention, review and AI obligations as
 * data, so a level change propagates rather than sitting in a spreadsheet.
 *
 * `combineClassifications` is the most load-bearing function: where data of different levels
 * meets, the result takes the **highest**. A report joining a public table to a restricted one
 * and inheriting "public" is a restricted extract with a public label, and every downstream
 * control is then the wrong one.
 */
export * from './classification';
