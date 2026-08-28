'use client';

import { useEffect, useState } from 'react';
import { API_BASE_URL } from '../../lib/api';

/**
 * Profile.
 *
 * Read from the API, not from the launch payload. The payload's name and photo are whatever the
 * user set on the platform and are unverified until the server has checked the signature —
 * rendering them directly is how a mini app displays an attacker-chosen name.
 */
interface Profile {
  displayName: string;
  languageCode: string;
  platform: string;
  joinedAt: string;
}

export default function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    void fetch(`${API_BASE_URL}/miniapp/profile`, { credentials: 'include' })
      .then((response) => (response.ok ? response.json() : null))
      .then(setProfile)
      .catch(() => setProfile(null));
  }, []);

  if (!profile) return <p className="muted">Loading…</p>;

  return (
    <div className="card">
      <h1>{profile.displayName}</h1>
      <p className="muted">
        {profile.platform} · {profile.languageCode}
      </p>
      <p className="muted">Joined {new Date(profile.joinedAt).toLocaleDateString()}</p>
    </div>
  );
}
