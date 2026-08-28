'use client';

import { useRouter } from 'next/navigation';
import { useSession } from '@/lib/session';

export function TopBar() {
  const { session, signOut } = useSession();
  const router = useRouter();

  const activeOrganization = session?.organizations.find(
    (organization) => organization.id === session.organizationId,
  );

  return (
    <header className="topbar">
      <span className="brand">TrustOS Admin</span>
      {session ? (
        <span className="muted">
          {session.user.email}
          {activeOrganization ? ` · ${activeOrganization.name}` : ' · no organization selected'}
          {'  '}
          <button
            type="button"
            className="button link"
            onClick={async () => {
              await signOut();
              router.push('/login');
            }}
          >
            Sign out
          </button>
        </span>
      ) : null}
    </header>
  );
}
