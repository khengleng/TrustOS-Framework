'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { AuthResponse, OrganizationSummary, UserSummary } from '@trustos/shared-types';
import { ApiClientError, apiRequest } from './api';

/**
 * Session state.
 *
 * KNOWN LIMITATION — tokens are held in `localStorage` so this example stays
 * a pure client-side app with no session backend. That makes them readable by
 * any script running on the page, so a single XSS becomes account takeover.
 * A production TrustOS console should keep the refresh token in an
 * `httpOnly`, `SameSite=Strict`, `Secure` cookie set by a small server route
 * and hold the access token in memory only. See docs/security-standards.md.
 */

const STORAGE_KEY = 'trustos.admin.session';

export interface SessionState {
  user: UserSummary;
  organizations: OrganizationSummary[];
  organizationId: string | null;
  accessToken: string;
  refreshToken: string;
}

interface SessionContextValue {
  session: SessionState | null;
  /** True until the stored session has been read; prevents a login flash. */
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  selectOrganization: (organizationId: string) => Promise<void>;
  /** Performs a request with the access token, refreshing once on 401. */
  authedRequest: <T>(
    path: string,
    init?: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown },
  ) => Promise<T>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function toSession(response: AuthResponse, organizationId: string | null): SessionState {
  return {
    user: response.user,
    organizations: response.organizations,
    organizationId,
    accessToken: response.tokens.accessToken,
    refreshToken: response.tokens.refreshToken,
  };
}

/** Reads the organization the API actually scoped the token to. */
function organizationFromToken(accessToken: string): string | null {
  try {
    const [, payload] = accessToken.split('.');
    if (!payload) return null;
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      org?: string | null;
    };
    return claims.org ?? null;
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<SessionState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) setSession(JSON.parse(stored) as SessionState);
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    setLoading(false);
  }, []);

  const persist = useCallback((next: SessionState | null) => {
    setSession(next);
    if (next) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else window.localStorage.removeItem(STORAGE_KEY);
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const response = await apiRequest<AuthResponse>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      persist(toSession(response, organizationFromToken(response.tokens.accessToken)));
    },
    [persist],
  );

  const signOut = useCallback(async () => {
    const refreshToken = session?.refreshToken;
    persist(null);
    if (!refreshToken) return;
    // Best effort: the local session is already gone, so a failure here must
    // not leave the user staring at an error on a sign-out screen.
    await apiRequest('/auth/logout', { method: 'POST', body: { refreshToken } }).catch(
      () => undefined,
    );
  }, [persist, session]);

  const selectOrganization = useCallback(
    async (organizationId: string) => {
      if (!session) throw new Error('Not signed in');
      const response = await apiRequest<AuthResponse>(
        `/auth/organizations/${organizationId}/select`,
        { method: 'POST', accessToken: session.accessToken },
      );
      persist(toSession(response, organizationFromToken(response.tokens.accessToken)));
    },
    [persist, session],
  );

  const authedRequest = useCallback(
    async <T,>(path: string, init: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown } = {}) => {
      if (!session)
        throw new ApiClientError({ code: 'unauthorized', status: 401, message: 'Not signed in.' });

      try {
        return await apiRequest<T>(path, { ...init, accessToken: session.accessToken });
      } catch (error) {
        if (!(error instanceof ApiClientError) || !error.isAuthExpired) throw error;

        // One refresh attempt, then give up. Looping on a rejected refresh is
        // how a client hammers an API it has already been locked out of.
        const refreshed = await apiRequest<AuthResponse>('/auth/refresh', {
          method: 'POST',
          body: { refreshToken: session.refreshToken },
        }).catch(() => null);

        if (!refreshed) {
          persist(null);
          throw error;
        }

        const next = toSession(refreshed, organizationFromToken(refreshed.tokens.accessToken));
        persist(next);
        return apiRequest<T>(path, { ...init, accessToken: next.accessToken });
      }
    },
    [persist, session],
  );

  const value = useMemo<SessionContextValue>(
    () => ({ session, loading, signIn, signOut, selectOrganization, authedRequest }),
    [session, loading, signIn, signOut, selectOrganization, authedRequest],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside <SessionProvider>');
  return context;
}
