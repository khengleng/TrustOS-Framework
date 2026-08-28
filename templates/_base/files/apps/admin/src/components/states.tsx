'use client';

import { describeError } from '@/lib/api';

/**
 * The three states every data view must handle.
 *
 * They live in one file so a new screen cannot "forget" the empty state — the
 * pattern to copy is right here, and a screen missing one is visible in review.
 */

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="state empty">
      <strong>{title}</strong>
      {hint ? <span className="muted">{hint}</span> : null}
    </div>
  );
}

/**
 * Error display.
 *
 * Always shows the request id when there is one: it is the only thing that
 * connects what the user saw to what the server logged.
 */
export function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { message, requestId } = describeError(error);

  return (
    <div className="state error" role="alert">
      <strong>{message}</strong>
      {requestId ? <code className="muted">Request ID: {requestId}</code> : null}
      {onRetry ? (
        <button type="button" className="button secondary" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
