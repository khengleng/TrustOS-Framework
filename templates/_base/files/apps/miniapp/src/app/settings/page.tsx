'use client';

import { useEffect, useState } from 'react';
import { API_BASE_URL } from '../../lib/api';

/**
 * Notification settings.
 *
 * A notification the product declares as non-optional has no switch here — see the `optional`
 * flag in @trustsystem/template-sdk. A password change or a large withdrawal that could be silenced
 * is one an attacker silences first, so the control is simply absent rather than present and
 * refused.
 */
interface Setting {
  notificationKey: string;
  label: string;
  muted: boolean;
  optional: boolean;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Setting[]>([]);

  useEffect(() => {
    void fetch(`${API_BASE_URL}/miniapp/settings`, { credentials: 'include' })
      .then((response) => (response.ok ? response.json() : []))
      .then(setSettings)
      .catch(() => setSettings([]));
  }, []);

  async function toggle(key: string, muted: boolean) {
    // Optimistic, then corrected by the response. A settings toggle that waits for a round trip
    // inside a WebView feels broken on a slow connection.
    setSettings((current) =>
      current.map((entry) => (entry.notificationKey === key ? { ...entry, muted } : entry)),
    );

    await fetch(`${API_BASE_URL}/miniapp/settings/${encodeURIComponent(key)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ muted }),
    });
  }

  return (
    <>
      <h1>Settings</h1>

      {settings.length === 0 && <p className="muted">Nothing to configure yet.</p>}

      {settings
        .filter((setting) => setting.optional)
        .map((setting) => (
          <label key={setting.notificationKey} className="card">
            <input
              type="checkbox"
              checked={!setting.muted}
              onChange={(event) => void toggle(setting.notificationKey, !event.target.checked)}
            />{' '}
            {setting.label}
          </label>
        ))}

      {settings.some((setting) => !setting.optional) && (
        <p className="muted">Security notifications are always sent and cannot be switched off.</p>
      )}
    </>
  );
}
