import type { PrismaService } from '@trustos/database';
import type { LocalUserPort, LocalUserRecord } from '@trustos/identity';

/**
 * The local provider's view of the framework's `User` table.
 *
 * Deliberately narrow: four methods, and the only one that writes a password writes a
 * hash produced by the provider. Nothing here reads or returns a plaintext password,
 * because there is nowhere in the framework that holds one for longer than the
 * duration of a single verification.
 *
 * `findByEmail` returns a soft-deleted or deactivated user rather than filtering it
 * out. That looks wrong and is not: the provider has to distinguish "no such account"
 * from "account exists but is disabled" *internally* so that it spends the same time
 * on both and returns the same message — filtering here would make the disabled case
 * fast and turn the endpoint into an enumeration oracle.
 */
export class PrismaLocalUserStore implements LocalUserPort {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<LocalUserRecord | null> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    return user ? project(user) : null;
  }

  async findById(userId: string): Promise<LocalUserRecord | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return user ? project(user) : null;
  }

  async recordLogin(userId: string, at: Date): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: at } });
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    // `tokenVersion` is deliberately untouched here. A transparent re-hash after a
    // successful login is not a password change, and bumping the version would sign
    // the user out of every device for upgrading a cost factor.
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  }
}

function project(user: {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string | null;
  isActive: boolean;
  isSuperAdmin: boolean;
  tokenVersion: number;
  deletedAt: Date | null;
  lastLoginAt: Date | null;
}): LocalUserRecord {
  return {
    id: user.id,
    email: user.email,
    passwordHash: user.passwordHash,
    displayName: user.displayName,
    isActive: user.isActive,
    isSuperAdmin: user.isSuperAdmin,
    tokenVersion: user.tokenVersion,
    deletedAt: user.deletedAt,
    lastLoginAt: user.lastLoginAt,
  };
}
