'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { OrganizationMemberSummary, RoleSummary } from '@trustos/shared-types';
import { useSession } from '@/lib/session';
import { EmptyState, ErrorBanner, Loading } from '@/components/states';
import { OrgTabs } from '@/components/org-tabs';

export default function MembersPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = use(params);
  const { session, loading, authedRequest } = useSession();
  const router = useRouter();

  const [members, setMembers] = useState<OrganizationMemberSummary[] | null>(null);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setMembers(null);
    try {
      const [loadedMembers, loadedRoles] = await Promise.all([
        authedRequest<OrganizationMemberSummary[]>(`/organizations/${organizationId}/members`),
        // Roles need `rbac.role.read`, which an operator does not hold. The
        // list is optional decoration, so a 403 here must not blank the page.
        authedRequest<RoleSummary[]>(`/organizations/${organizationId}/roles`).catch(() => []),
      ]);
      setMembers(loadedMembers);
      setRoles(loadedRoles);
    } catch (caught) {
      setError(caught);
      setMembers([]);
    }
  }, [authedRequest, organizationId]);

  useEffect(() => {
    if (loading) return;
    if (!session) {
      router.replace('/login');
      return;
    }
    void load();
  }, [loading, session, router, load]);

  async function assignRole(memberId: string, roleName: string) {
    setBusyMemberId(memberId);
    setError(null);
    setNotice(null);
    try {
      await authedRequest(`/organizations/${organizationId}/members/${memberId}/role`, {
        method: 'PUT',
        body: { roleName },
      });
      setNotice(`Role updated to ${roleName}.`);
      await load();
    } catch (caught) {
      // A 403 here is the expected answer when an administrator tries to grant
      // organization_owner — the server decides, and the UI reports.
      setError(caught);
    } finally {
      setBusyMemberId(null);
    }
  }

  if (loading) return <Loading />;
  if (!session) return null;

  const assignableRoles = roles.filter((role) => role.name !== 'super_admin');

  return (
    <>
      <h1>Members</h1>
      <OrgTabs organizationId={organizationId} />

      {notice ? <p className="muted">{notice}</p> : null}
      {error ? <ErrorBanner error={error} onRetry={() => void load()} /> : null}

      <div className="card">
        {members === null ? (
          <Loading label="Loading members…" />
        ) : members.length === 0 && !error ? (
          <EmptyState
            title="No members yet"
            hint="Invite someone with POST /api/organizations/:organizationId/members."
          />
        ) : members.length === 0 ? null : (
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Status</th>
                <th>Roles</th>
                <th className="actions">Assign role</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id}>
                  <td>
                    {member.user.displayName ?? '—'}
                    <br />
                    <span className="muted">{member.user.email}</span>
                  </td>
                  <td>
                    <span className="badge">{member.status}</span>
                  </td>
                  <td>
                    {member.roles.length === 0 ? (
                      <span className="muted">none</span>
                    ) : (
                      member.roles.map((role) => (
                        <span key={role.id} className="badge">
                          {role.name}
                        </span>
                      ))
                    )}
                  </td>
                  <td className="actions">
                    <select
                      aria-label={`Assign a role to ${member.user.email}`}
                      defaultValue=""
                      disabled={busyMemberId !== null || assignableRoles.length === 0}
                      onChange={(event) => {
                        const roleName = event.target.value;
                        if (roleName) void assignRole(member.id, roleName);
                        event.target.value = '';
                      }}
                    >
                      <option value="">
                        {assignableRoles.length === 0 ? 'No permission' : 'Choose a role…'}
                      </option>
                      {assignableRoles.map((role) => (
                        <option key={role.id} value={role.name}>
                          {role.name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="muted">
        Every role change above is written to the audit trail with the previous and new roles.
      </p>
    </>
  );
}
