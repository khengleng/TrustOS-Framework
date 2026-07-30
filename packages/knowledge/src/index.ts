/**
 * @trustos/knowledge
 *
 * Knowledge collections and documents with versions, access policy and expiry.
 *
 * A knowledge base is an access-control surface that does not look like one: a document an agent
 * can search is one it can quote to whoever it is talking to. Collections default to `restricted`
 * for that reason.
 */
export * from './knowledge';
export * from './testing';
