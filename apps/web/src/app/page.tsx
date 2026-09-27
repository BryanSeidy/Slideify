import { Suspense } from 'react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

export default function Home() {
  const navigate = useNavigate();
  const [apiStatus, setApiStatus] = useState<'uninitialized' | 'checking' | 'ok' | 'error'>('uninitialized');
  const [env, setEnv] = useState<string>('');

  // Check API health on mount
  useEffect(() => {
    let mounted = true;

    const checkApiHealth = async () => {
      setApiStatus('checking');
      try {
        const response = await fetch('/api/health');
        if (mounted) {
          if (response.ok) {
            const data = await response.json();
            setApiStatus(data.status === 'ok' ? 'ok' : 'error');
          } else {
            setApiStatus('error');
          }
        }
      } catch (error) {
        if (mounted) {
          setApiStatus('error');
        }
      }
    };

    checkApiHealth();

    return () => {
      mounted = false;
    };
  }, [navigate]);

  return (
    <Suspense fallback={<div>Bienvenue sur Slideify</div>}>
      <div className="min-h-screen bg-background p-6">
        <header className="mb-8">
          <h1 className="text-4xl font-bold mb-2">Slideify</h1>
          <p className="text-text-secondary">AI-powered content repurposing</p>
        </header>

        <section className="space-y-6">
          <div>
            <h2 className="font-semibold mb-2">Environnement</h2>
            <p className="text-text-secondary">{env}</p>
          </div>

          <div>
            <h2 className="font-semibold mb-2">Statut API</h2>
            <p className={apiStatus === 'ok' ? 'text-success' : apiStatus === 'error' ? 'text-error' : 'text-muted'}
              >{apiStatus}</p>
          </div>

          <div>
            <h2 className="font-semibold mb-2">Fonctionnalités MVP</h2>
            <ul className="list-disc list-inside space-y-2">
              <li>Transformation texte → PDF</li>
              <li>URL d'article → carrousel</li>
              <li>Export images slides PNG</li>
              <li>Structure JSON intelligente</li>
            </ul>
          </div>
        </section>
      </div>
    </Suspense>
  );
}