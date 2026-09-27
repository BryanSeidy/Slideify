import './globals.css';
import { createBrowserClient, type ReactQueryConfig } from '@tanstack/react-query';
import { NextAppRouterProvider, NextProvider } from '@next/bundle-renderer';
import { headers } from 'next/headers';

// Mock auth for MVP — in production this would use Supabase magic link / JWT
function useAuth() {
  const [user, setUser] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    // Check localStorage for auth state
    const userData = localStorage.getItem('user');
    if (userData) {
      setUser(JSON.parse(userData));
    }
    setLoading(false);
  }, []);

  return { user, loading };
}

export default function RootLayout({
  children,
}: { children: React.ReactNode }) {
  const { loading } = useAuth();

  if (loading) {
    return <html><body>Loading...</body></html>;
  }

  return (
    <html lang="fr" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}

export const config = {
  runtime: 'edge',
};