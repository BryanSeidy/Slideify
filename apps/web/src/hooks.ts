'use client';

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

export function useAuth() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const userData = localStorage.getItem('user');
    if (userData) {
      setUser(JSON.parse(userData));
      navigate('/dashboard');
    } else {
      setLoading(false);
    }
  }, [navigate]);

  return { user, loading };
}

export function useCredits() {
  const { data: userData } = useQuery({
    queryKey: ['user'],
    queryFn: async () => {
      const res = await fetch('/api/user');
      return res.json();
    },
    enabled: !!localStorage.getItem('user'),
  });
  return { credits: userData?.credits ?? 0 };
}