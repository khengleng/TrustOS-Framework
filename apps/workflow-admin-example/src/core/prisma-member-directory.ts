import type { PrismaService } from '@trustsystem/database';
import type { MemberDirectory } from '@trustsystem/workflow-tasks';

/**
 * The framework's membership tables, as a member directory.
 *
 * Three questions about one organization, and nothing else. That narrowness is the point: a
 * workflow package handed a `PrismaClient` could query anything, and assignment is the
 * boundary where an over-broad query becomes a cross-tenant task.
 *
 * `ACTIVE` only, everywhere. An invited member has not accepted, and a suspended one should
 * not receive work — assigning to either produces a task that sits in nobody's queue, which
 * is the normal outcome of ordinary staff turnover if this filter is forgotten.
 */
export class PrismaMemberDirectory implements MemberDirectory {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Active members holding a role, in a stable order.
   *
   * The order matters: round-robin indexes into this list, so an unstable order makes a
   * rotation a shuffle. Sorted by user id rather than by name, because a name change would
   * otherwise reorder the rotation.
   */
  async listByRole(organizationId: string, role: string): Promise<string[]> {
    const members = await this.prisma.organizationMember.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        deletedAt: null,
        roles: { some: { role: { name: role } } },
      },
      select: { userId: true },
      orderBy: { userId: 'asc' },
    });

    return members.map((member) => member.userId);
  }

  /**
   * Members of a group.
   *
   * The framework has no group table yet, so this returns nothing and says so rather than
   * guessing. A definition that assigns by group therefore produces a task nobody is
   * eligible for — which `validateDefinition` cannot catch and the empty result makes
   * visible at the first instance rather than silently.
   */
  async listByGroup(organizationId: string, groupId: string): Promise<string[]> {
    void organizationId;
    void groupId;
    return [];
  }

  async isActiveMember(organizationId: string, userId: string): Promise<boolean> {
    const member = await this.prisma.organizationMember.findFirst({
      where: { organizationId, userId, status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });

    return member !== null;
  }
}
