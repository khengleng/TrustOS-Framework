import type { Conversation, ConversationStore, ConversationTurn } from './conversation';

/** An in-memory conversation store, for tests and development. */
export class InMemoryConversationStore implements ConversationStore {
  readonly conversations = new Map<string, Conversation>();
  readonly turnsByConversation = new Map<string, ConversationTurn[]>();

  async create(conversation: Conversation): Promise<Conversation> {
    this.conversations.set(conversation.id, conversation);
    this.turnsByConversation.set(conversation.id, []);
    return conversation;
  }

  async find(id: string, organizationId: string | null): Promise<Conversation | null> {
    const conversation = this.conversations.get(id);
    if (!conversation || conversation.organizationId !== organizationId) return null;
    return conversation;
  }

  async update(id: string, patch: Partial<Conversation>): Promise<Conversation | null> {
    const conversation = this.conversations.get(id);
    if (!conversation) return null;

    const updated = { ...conversation, ...patch };
    this.conversations.set(id, updated);
    return updated;
  }

  async list(input: {
    organizationId: string | null;
    userId?: string;
    agentId?: string;
    limit?: number;
  }): Promise<Conversation[]> {
    return [...this.conversations.values()]
      .filter((conversation) => conversation.organizationId === input.organizationId)
      .filter((conversation) => !input.userId || conversation.userId === input.userId)
      .filter((conversation) => !input.agentId || conversation.agentId === input.agentId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, input.limit ?? 50);
  }

  async appendTurn(turn: ConversationTurn): Promise<ConversationTurn> {
    const existing = this.turnsByConversation.get(turn.conversationId) ?? [];
    existing.push(turn);
    this.turnsByConversation.set(turn.conversationId, existing);
    return turn;
  }

  async turns(conversationId: string, organizationId: string | null): Promise<ConversationTurn[]> {
    return (this.turnsByConversation.get(conversationId) ?? []).filter(
      (turn) => turn.organizationId === organizationId,
    );
  }

  async deleteTurnsBefore(
    conversationId: string,
    organizationId: string | null,
    sequence: number,
  ): Promise<number> {
    const existing = this.turnsByConversation.get(conversationId) ?? [];
    const kept = existing.filter(
      (turn) => turn.organizationId !== organizationId || turn.sequence >= sequence,
    );

    this.turnsByConversation.set(conversationId, kept);
    return existing.length - kept.length;
  }
}
