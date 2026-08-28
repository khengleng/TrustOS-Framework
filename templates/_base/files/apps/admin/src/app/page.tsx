'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/lib/session';
import { Loading } from '@/components/states';

export default function IndexPage() {
  const { session, loading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    router.replace(session ? '/organizations' : '/login');
  }, [loading, session, router]);

  return <Loading label="Checking your session…" />;
}
