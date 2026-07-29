'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ApiClientError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner } from '@/components/states';

export default function LoginPage() {
  const { signIn } = useSession();
  const router = useRouter();

  const [email, setEmail] = useState('owner@acme.test');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await signIn(email, password);
      router.push('/organizations');
    } catch (caught) {
      setError(caught);
    } finally {
      setSubmitting(false);
    }
  }

  // Field-level detail is rendered when the API supplies it, but the top-level
  // message is always shown — a validation_error with no details would
  // otherwise render as an empty box.
  const fieldErrors = error instanceof ApiClientError ? (error.details ?? []) : [];

  return (
    <div className="card" style={{ maxWidth: 420, margin: '48px auto' }}>
      <h1>Sign in</h1>
      <p className="muted">
        Seeded accounts: owner@acme.test, admin@acme.test, auditor@acme.test — password
        TrustOSDemo2026!
      </p>

      <form onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>

        {error ? <ErrorBanner error={error} /> : null}

        {fieldErrors.length > 0 ? (
          <ul className="muted">
            {fieldErrors.map((detail) => (
              <li key={`${detail.path}-${detail.message}`}>
                {detail.path}: {detail.message}
              </li>
            ))}
          </ul>
        ) : null}

        <button type="submit" className="button" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
