import type { Metadata } from 'next';
import './globals.css';
import { SessionProvider } from '@/lib/session';
import { TopBar } from '@/components/top-bar';

export const metadata: Metadata = {
  title: 'TrustOS Admin Example',
  description: 'Reference admin console for the TrustOS Engineering Framework.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>
          <TopBar />
          <main className="shell">{children}</main>
        </SessionProvider>
      </body>
    </html>
  );
}
