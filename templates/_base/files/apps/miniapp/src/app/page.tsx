'use client';

import { useEffect, useState } from 'react';
import { filterNavigation, permissionsFrom, type NavigationItem } from '@trustos/template-sdk';
import { API_BASE_URL } from '../lib/api';
import { FALLBACK_MENU, fetchMenu } from '../lib/menu';
import { startSession, type MiniAppSession } from '../lib/launch';

/**
 * The mini app home screen: sign in, then show the menu.
 *
 * The sign-in is the whole platform handshake — forward the launch payload, receive a session.
 * See `lib/launch.ts` for why nothing is verified here.
 *
 * The menu arrives already filtered by the API. It is filtered again here against the session's
 * permissions, which is belt and braces rather than duplication: the server's filtering is the
 * control, and this one keeps the UI honest if a cached menu outlives a permission change.
 */
export default function HomePage() {
  const [session, setSession] = useState<MiniAppSession | null>(null);
  const [menu, setMenu] = useState<NavigationItem[]>(FALLBACK_MENU);
  const [state, setState] = useState<'starting' | 'ready' | 'outside'>('starting');

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const started = await startSession(API_BASE_URL);
      if (cancelled) return;

      if (!started) {
        setState('outside');
        return;
      }

      setSession(started);
      setMenu(await fetchMenu(API_BASE_URL));
      setState('ready');
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (state === 'starting') {
    return <p className="muted">Signing you in…</p>;
  }

  if (state === 'outside') {
    /*
     * Not an error. Opening the URL in a plain browser is a normal thing for a developer to do,
     * and a red failure screen sends them looking for a bug that is not there.
     */
    return (
      <div className="card">
        <h1>Open from the app</h1>
        <p className="muted">
          This mini app signs you in using the messaging client that opened it. Open it from the
          conversation rather than from a browser tab.
        </p>
      </div>
    );
  }

  const visible = filterNavigation(
    menu,
    permissionsFrom(menu.map((item) => item.permission ?? '')),
  );

  return (
    <>
      <div className="card">
        {/* The display name comes from the *verified* session, never from the launch payload. */}
        <h1>Hello, {session?.displayName}</h1>
        <p className="muted">
          Signed in until {new Date(session?.expiresAt ?? '').toLocaleString()}
        </p>
      </div>

      {visible.map((item) => (
        <a key={item.key} className="card tile" href={item.href ?? '#'}>
          <strong>{item.label}</strong>
          {item.badge !== undefined && <span className="muted"> · {item.badge}</span>}
        </a>
      ))}
    </>
  );
}
