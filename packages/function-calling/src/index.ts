/**
 * @trustos/function-calling
 *
 * Typed function definitions, zod-to-JSON-Schema conversion, argument repair and validation.
 *
 * Nothing here throws on a malformed call. A model that gets "amount should be a number and was a
 * string" fixes it on the next turn; an exception ends a conversation that was one turn from
 * working.
 */
export * from './function';
