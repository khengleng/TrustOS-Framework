/**
 * Seed script.
 *
 * Idempotent by construction: system roles and permissions are upserted by
 * stable keys, so running it twice — or running it against a database that is
 * already half-seeded — converges rather than duplicating.
 *
 *   npm run db:seed
 *
 * Demo data (a user, an organization, a membership) is created only outside
 * production. A seeded account with a known password in production is a
 * backdoor, not a convenience.
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SYSTEM_ROLE_LIST } from '@trustos/rbac';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const DEMO_ORGANIZATION = { id: 'org_demo_acme', name: 'Acme Demo', slug: 'acme-demo' };
const DEMO_USERS = [
  {
    id: 'user_demo_owner',
    email: 'owner@acme.test',
    name: 'Ada Owner',
    role: 'organization_owner',
  },
  { id: 'user_demo_admin', email: 'admin@acme.test', name: 'Alan Admin', role: 'administrator' },
  { id: 'user_demo_auditor', email: 'auditor@acme.test', name: 'Grace Auditor', role: 'auditor' },
];

/**
 * Development-only password. Long enough to satisfy the policy, obviously fake
 * so nobody mistakes it for a real credential.
 */
// architecture-ignore: no-secret-in-source — a development seed password, never used outside seeding
const DEMO_PASSWORD = 'TrustOSDemo2026!';

async function seedPermissions(): Promise<void> {
  for (const permission of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      create: {
        key: permission.key,
        resource: permission.resource,
        action: permission.action,
        description: permission.description,
      },
      update: {
        resource: permission.resource,
        action: permission.action,
        description: permission.description,
      },
    });
  }
  console.log(`  permissions: ${ALL_PERMISSIONS.length}`);
}

async function seedSystemRoles(): Promise<void> {
  for (const role of SYSTEM_ROLE_LIST) {
    await prisma.role.upsert({
      where: { id: role.id },
      create: {
        id: role.id,
        name: role.name,
        description: role.description,
        isSystem: true,
        organizationId: null,
      },
      update: { description: role.description, isSystem: true },
    });

    // `super_admin` holds the wildcard, which is expressed by the isSuperAdmin
    // flag on the user rather than by rows in RolePermission.
    const keys = role.permissions.filter((key) => key !== '*');
    const permissions = await prisma.permission.findMany({ where: { key: { in: keys } } });

    // Re-point the role's grants at exactly the definition. Removing a
    // permission from the catalog must actually revoke it.
    await prisma.rolePermission.deleteMany({
      where: { roleId: role.id, permission: { key: { notIn: keys } } },
    });

    for (const permission of permissions) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
        create: { roleId: role.id, permissionId: permission.id },
        update: {},
      });
    }

    console.log(`  role ${role.name}: ${permissions.length} permissions`);
  }
}

async function seedDemoData(): Promise<void> {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  await prisma.organization.upsert({
    where: { id: DEMO_ORGANIZATION.id },
    create: DEMO_ORGANIZATION,
    update: { name: DEMO_ORGANIZATION.name },
  });

  for (const demo of DEMO_USERS) {
    const user = await prisma.user.upsert({
      where: { id: demo.id },
      create: {
        id: demo.id,
        email: demo.email,
        displayName: demo.name,
        passwordHash,
        isActive: true,
      },
      update: { displayName: demo.name, passwordHash },
    });

    const membership = await prisma.organizationMember.upsert({
      where: {
        organizationId_userId: { organizationId: DEMO_ORGANIZATION.id, userId: user.id },
      },
      create: {
        organizationId: DEMO_ORGANIZATION.id,
        userId: user.id,
        status: 'ACTIVE',
        joinedAt: new Date(),
      },
      update: { status: 'ACTIVE' },
    });

    const role = SYSTEM_ROLE_LIST.find((candidate) => candidate.name === demo.role);
    if (role) {
      await prisma.organizationMemberRole.upsert({
        where: { memberId_roleId: { memberId: membership.id, roleId: role.id } },
        create: { memberId: membership.id, roleId: role.id },
        update: {},
      });
    }

    console.log(`  demo user ${demo.email} (${demo.role})`);
  }
}

async function main(): Promise<void> {
  const environment = process.env.NODE_ENV ?? 'development';
  console.log(`Seeding TrustOS foundation data (NODE_ENV=${environment})`);

  await seedPermissions();
  await seedSystemRoles();

  if (environment === 'production') {
    console.log('  demo data: skipped in production');
  } else {
    await seedDemoData();
    console.log(`\n  Demo password for every seeded account: ${DEMO_PASSWORD}`);
    console.log('  These accounts exist only outside production.');
  }

  console.log('\nSeed complete.');
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
