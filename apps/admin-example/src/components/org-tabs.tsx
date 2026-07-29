'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function OrgTabs({ organizationId }: { organizationId: string }) {
  const pathname = usePathname();
  const base = `/organizations/${organizationId}`;

  const tabs = [
    { href: `${base}/members`, label: 'Members' },
    { href: `${base}/audit`, label: 'Audit log' },
    { href: '/organizations', label: 'Switch organization' },
  ];

  return (
    <nav className="tabs">
      {tabs.map((tab) => (
        <Link key={tab.href} href={tab.href} className={pathname === tab.href ? 'active' : ''}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
