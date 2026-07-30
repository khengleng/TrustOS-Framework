/**
 * @trustos/rag
 *
 * Chunking, retrieval, fusion, diversification and citation.
 *
 * Citations are the load-bearing part: they are the only practical way a person can check whether
 * a generated answer is grounded. Everything here carries provenance from the vector record to the
 * rendered context, because a citation added afterwards is a citation somebody guessed.
 */
export * from './chunking';
export * from './retrieval';
