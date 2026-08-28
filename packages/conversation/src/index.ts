/**
 * @trustos/conversation
 *
 * Conversation state, context-window fitting and summarisation.
 *
 * Fitting is the part worth reading: the system prompt is pinned, tool pairs move together, and
 * what is dropped is summarised rather than deleted. Each of those prevents a specific failure
 * described in the header of `conversation.ts`.
 */
export * from './conversation';
export * from './testing';
