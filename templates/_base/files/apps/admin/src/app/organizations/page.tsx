'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmptyState, ErrorBanner, Loading } from '@/components/states';
import { RESOURCES } from '@/lib/resources';
import { useSession } from '@/lib/session';

/**
 * Organization picker.
 *
 * Selecting an organization is a server round trip, not a client-side filter:
 * the API re-verifies membership and issues a token scoped to that
 * organization. The client never simply "sets" the current organization.
 */
export default function OrganizationsPage() {
  const { session, loading, selectOrganization } = useSession();
  const router = useRouter();
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!loading && !session) router.replace('/login');
  }, [loading, session, router]);

  if (loading) return <Loading label="Loading your session…" />;
  if (!session) return null;

  async function choose(organizationId: string) {
    setSwitching(organizationId);
    setError(null);
    try {
      await selectOrganization(organizationId);
      const first = RESOURCES[0];
      router.push(first ? `/resources/${first.key}` : '/audit');
    } catch (caught) {
      setError(caught);
    } finally {
      setSwitching(null);
    }
  }

  return (
    <>
      <h1>Choose an organization</h1>
      <p className="muted">
        Your access token is scoped to one organization at a time. Switching issues a new token.
      </p>

      {error ? <ErrorBanner error={error} /> : null}

      <div className="card">
        {session.organizations.length === 0 ? (
          <EmptyState
            title="You are not a member of any organization yet"
            hint="Ask an administrator for an invitation, or create one through POST /api/organizations."
          />
        ) : (
          <ul className="org-list">
            {session.organizations.map((organization) => (
              <li key={organization.id}>
                <button
                  type="button"
                  onClick={() => choose(organization.id)}
                  disabled={switching !== null}
                  aria-current={organization.id === session.organizationId}
                >
                  <strong>{organization.name}</strong>
                  <br />
                  <span className="muted">
                    {organization.slug}
                    {switching === organization.id ? ' · switching…' : ''}
                    {organization.id === session.organizationId ? ' · active' : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
