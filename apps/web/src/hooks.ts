'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export function useAuth() {
  const router = useRouter();
  const [user, setUser] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const userData = localStorage.getItem('user');
    if (userData) {
      setUser(JSON.parse(userData));
      router.push('/dashboard');
    } else {
      setLoading(false);
    }
  }, [router]);

  return { user, loading };
}

export function useCredits() {
  const [credits, setCredits] = useState(0);

  useEffect(() => {
    if (!localStorage.getItem('user')) return;
    void fetch('/api/user')
      .then(async (res) => {
        const data = (await res.json()) as { credits?: number };
        setCredits(data.credits ?? 0);
      })
      .catch(() => {
        setCredits(0);
      });
  }, []);

  return { credits };
}
