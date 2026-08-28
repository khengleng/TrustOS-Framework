import type { ReviewRequest, ReviewStatus, ReviewStore } from './review';

/** An in-memory review store, for tests and development. */
export class InMemoryReviewStore implements ReviewStore {
  readonly requests = new Map<string, ReviewRequest>();

  async create(request: ReviewRequest): Promise<ReviewRequest> {
    this.requests.set(request.id, request);
    return request;
  }

  async find(id: string, organizationId: string | null): Promise<ReviewRequest | null> {
    const request = this.requests.get(id);
    if (!request || request.organizationId !== organizationId) return null;
    return request;
  }

  async update(id: string, patch: Partial<ReviewRequest>): Promise<ReviewRequest | null> {
    const request = this.requests.get(id);
    if (!request) return null;

    const updated = { ...request, ...patch };
    this.requests.set(id, updated);
    return updated;
  }

  async list(input: {
    organizationId: string | null;
    status?: ReviewStatus;
    assignedTo?: string;
    agentId?: string;
    limit?: number;
  }): Promise<ReviewRequest[]> {
    return (
      [...this.requests.values()]
        .filter((request) => request.organizationId === input.organizationId)
        .filter((request) => !input.status || request.status === input.status)
        .filter((request) => !input.assignedTo || request.assignedTo === input.assignedTo)
        .filter((request) => !input.agentId || request.agentId === input.agentId)
        // Urgent first, then oldest — a queue ordered only by age buries the urgent item.
        .sort((a, b) => {
          const order = { urgent: 0, high: 1, normal: 2, low: 3 };
          const byPriority = order[a.priority] - order[b.priority];
          return byPriority !== 0 ? byPriority : a.createdAt.getTime() - b.createdAt.getTime();
        })
        .slice(0, input.limit ?? 50)
    );
  }

  async overdue(organizationId: string | null, now: Date, limit = 50): Promise<ReviewRequest[]> {
    return [...this.requests.values()]
      .filter((request) => request.organizationId === organizationId)
      .filter((request) => request.status === 'pending' && request.dueAt < now)
      .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
      .slice(0, limit);
  }
}
