/**
 * @trustsystem/agent-framework
 *
 * Agent definitions: role, prompt, tools, permissions, models, limits, output schema.
 *
 * An agent is a declaration rather than code, so the answer to "what can this agent do" is a
 * document that can be reviewed and diffed rather than a codebase to read and hope about.
 *
 * The nine example agents are examples: not registered by default, engineering roles rather than
 * business ones, and each carries its reasoning in a comment.
 */
export * from './agent';
export * from './examples';
