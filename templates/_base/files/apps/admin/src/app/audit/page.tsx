'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmptyState, ErrorBanner, Loading } from '@/components/states';
import { useSession } from '@/lib/session';

const PAGE_SIZE = 20;

interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorId: string | null;
  organizationId: string | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
  ipAddress: string | null;
  createdAt: string;
}

interface AuditPage {
  items: AuditEntry[];
  meta: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
    hasNextPage: boolean;
  };
}

/**
 * Audit trail.
 *
 * Scoped by the server to the caller's organization; there is no organization
 * selector here on purpose. Reading it requires `audit.read`, so an operator
 * sees a 403 — which the error banner reports along with the request id.
 */
export default function AuditPage() {
  const { session, loading, authedRequest } = useSession();
  const router = useRouter();

  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AuditPage | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(
    async (targetPage: number) => {
      setError(null);
      setResult(null);
      try {
        setResult(
          await authedRequest<AuditPage>(`/audit-logs?page=${targetPage}&pageSize=${PAGE_SIZE}`),
        );
      } catch (caught) {
        setError(caught);
      }
    },
    [authedRequest],
  );

  useEffect(() => {
    if (loading) return;
    if (!session) {
      router.replace('/login');
      return;
    }
    void load(page);
  }, [loading, session, router, load, page]);

  if (loading) return <Loading />;
  if (!session) return null;

  return (
    <>
      <h1>Audit log</h1>
      <p className="muted">
        Append-only, scoped to this organization by the server. Records are never edited.
      </p>

      {error ? <ErrorBanner error={error} onRetry={() => void load(page)} /> : null}

      <div className="card">
        {result === null && !error ? (
          <Loading label="Loading audit records…" />
        ) : result === null ? null : result.items.length === 0 ? (
          <EmptyState
            title="No audit records yet"
            hint="Sign in, create something, or change a role, then check back."
          />
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Actor</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      {new Date(entry.createdAt).toLocaleString()}
                      <br />
                      <span className="muted">{entry.requestId ?? '—'}</span>
                    </td>
                    <td>
                      <span className="badge">{entry.action}</span>
                    </td>
                    <td>
                      {entry.entityType}
                      <br />
                      <span className="muted">{entry.entityId ?? '—'}</span>
                    </td>
                    <td>
                      {entry.actorId ?? <span className="muted">anonymous</span>}
                      <br />
                      <span className="muted">{entry.ipAddress ?? '—'}</span>
                    </td>
                    <td>
                      {entry.before || entry.after ? (
                        <pre className="json">
                          {JSON.stringify({ before: entry.before, after: entry.after }, null, 1)}
                        </pre>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="muted pager">
              Page {result.meta.page} of {Math.max(result.meta.totalPages, 1)} ·{' '}
              {result.meta.totalItems} records{' '}
              <button
                type="button"
                className="button secondary"
                disabled={result.meta.page <= 1}
                onClick={() => setPage((current) => current - 1)}
              >
                Previous
              </button>{' '}
              <button
                type="button"
                className="button secondary"
                disabled={!result.meta.hasNextPage}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </button>
            </p>
          </>
        )}
      </div>
    </>
  );
}
