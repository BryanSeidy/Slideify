'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

interface GenerationRow {
  id: string;
  createdAt: string;
  status: string;
  slideCount?: number;
  error?: string;
}

export default function DashboardPage() {
  const router = useRouter();
  void router;
  const [generations, setGenerations] = useState<GenerationRow[]>([]);
  const [credits, setCredits] = useState(3);

  // Fetch generations and credits on mount
  useEffect(() => {
    // In real app, fetch from API
    const mockGenerations = [
      { id: '1', createdAt: new Date().toISOString(), status: 'COMPLETED', slideCount: 7 },
      { id: '2', createdAt: new Date().toISOString(), status: 'FAILED', error: 'LLM_ERROR' },
    ];
    setGenerations(mockGenerations);
    setCredits(2);
  }, []);

  return (
    <div className="container">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1>Tableau de bord</h1>
        <div style={{ background: 'var(--accent)', padding: '8px 16px', borderRadius: '20px', fontWeight: 600 }}>
          {credits} crédits
        </div>
      </div>

      {generations.length === 0 ? (
        <div className="card text-center" style={{ padding: 48 }}>
          <h2 style={{ marginBottom: 16 }}>Aucune génération</h2>
          <p style={{ color: 'var(--muted)', marginBottom: 24 }}>
            Commencez par créer votre premier carrousel
          </p>
          <a href="/generate" className="btn-primary">
            Créer mon premier carrousel
          </a>
        </div>
      ) : (
        <div className="card">
          <h2 style={{ marginBottom: 16 }}>Historique</h2>
          {generations.map((gen) => (
            <div key={gen.id} style={{ padding: '16px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{new Date(gen.createdAt).toLocaleDateString('fr-FR')}</span>
                <span style={{ textTransform: 'capitalize' }}>{gen.status.toLowerCase()}</span>
              </div>
              {gen.status === 'COMPLETED' && (
                <a href={`/result/${gen.id}`} style={{ fontSize: 14, marginTop: 8, display: 'inline-block' }}>
                  Voir le résultat →
                </a>
              )}
              {gen.status === 'FAILED' && (
                <div style={{ color: '#ef4444', fontSize: 14, marginTop: 8 }}>
                  Échec : {gen.error}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <a href="/generate" className="btn-primary" style={{ display: 'block', marginTop: 24, width: '100%', textAlign: 'center' }}>
        Nouvelle génération
      </a>
    </div>
  );
}