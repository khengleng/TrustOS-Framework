'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmptyState, ErrorBanner, Loading } from '@/components/states';
import { RESOURCES } from '@/lib/resources';
import { readCell, type ResourceDefinition } from '@/lib/resource-types';
import { useSession } from '@/lib/session';

/**
 * Generic resource list.
 *
 * One page renders every product entity from the registry in `lib/resources.ts`.
 * Filtering here is presentational only — the server scopes every response to
 * the caller's organization, and that is the control.
 */
export default function ResourcePage({ params }: { params: Promise<{ resource: string }> }) {
  const { resource: resourceKey } = use(params);
  const { session, loading, authedRequest } = useSession();
  const router = useRouter();

  const definition: ResourceDefinition | undefined = RESOURCES.find(
    (entry) => entry.key === resourceKey,
  );

  const [rows, setRows] = useState<Array<Record<string, unknown>> | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    if (!definition) return;
    setError(null);
    setRows(null);
    try {
      const response = await authedRequest<unknown>(definition.endpoint);
      // Accept either a bare array or a paginated envelope.
      const items = Array.isArray(response)
        ? response
        : ((response as { items?: unknown[] })?.items ?? []);
      setRows(items as Array<Record<string, unknown>>);
    } catch (caught) {
      setError(caught);
      setRows([]);
    }
  }, [authedRequest, definition]);

  useEffect(() => {
    if (loading) return;
    if (!session) {
      router.replace('/login');
      return;
    }
    void load();
  }, [loading, session, router, load]);

  if (loading) return <Loading />;
  if (!session) return null;

  if (!definition) {
    return (
      <EmptyState
        title={`Unknown resource "${resourceKey}"`}
        hint="Add it to apps/admin/src/lib/resources.ts."
      />
    );
  }

  return (
    <>
      <h1>{definition.label}</h1>
      {definition.description ? <p className="muted">{definition.description}</p> : null}

      {error ? <ErrorBanner error={error} onRetry={() => void load()} /> : null}

      <div className="card">
        {rows === null ? (
          <Loading label={`Loading ${definition.label.toLowerCase()}…`} />
        ) : rows.length === 0 && !error ? (
          <EmptyState
            title={`No ${definition.label.toLowerCase()} yet`}
            {...(definition.emptyHint ? { hint: definition.emptyHint } : {})}
          />
        ) : rows.length === 0 ? null : (
          <table>
            <thead>
              <tr>
                {definition.columns.map((column) => (
                  <th key={column.key}>{column.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={String(row.id ?? index)}>
                  {definition.columns.map((column) => {
                    const value = readCell(row, column.key);
                    return (
                      <td key={column.key}>
                        {value === null || value === undefined || value === '' ? (
                          <span className="muted">—</span>
                        ) : column.badge ? (
                          <span className="badge">{String(value)}</span>
                        ) : column.date ? (
                          new Date(String(value)).toLocaleString()
                        ) : (
                          String(value)
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
