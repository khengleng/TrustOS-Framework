import type { MemberDirectory } from '@trustsystem/workflow-tasks';
import type { AppPrismaService } from './prisma.service';

/**
 * This application's membership tables, as a workflow member directory.
 *
 * Three questions about one organization and nothing else. The narrowness is the point: a
 * workflow package handed a `PrismaClient` could query anything, and assignment is the
 * boundary where an over-broad query becomes a cross-tenant task.
 *
 * `ACTIVE` only, everywhere. An invited member has not accepted and a suspended one should
 * not receive work — assigning to either produces a task that sits in nobody's queue, which
 * is the normal outcome of ordinary staff turnover if this filter is forgotten.
 */
export class ProductMemberDirectory implements MemberDirectory {
  /*
   * `AppPrismaService`, for consistency with everything else the engine is wired with.
   *
   * `OrganizationMember` is a framework model, so the framework's own client type would work
   * here — but taking two different Prisma types in one composition root is one type somebody
   * will pass to the wrong constructor. One type, one client, one connection pool.
   */
  constructor(private readonly prisma: AppPrismaService) {}

  /**
   * Active members holding a role, in a stable order.
   *
   * The order matters: round-robin indexes into this list, so an unstable order makes a
   * rotation a shuffle. By user id rather than by name, because a name change would
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
   * The framework has no group table, so this returns nothing rather than guessing. A
   * definition that assigns by group therefore produces a task nobody is eligible for, which
   * is visible at the first instance rather than silently wrong.
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
