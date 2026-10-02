'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';

export default function GeneratingPage() {
  const params = useParams();
  const generationId = params.id as string;
  const [status, setStatus] = useState('QUEUED');
  const [step, setStep] = useState('Préparation…');

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(`/api/generations/${generationId}/status`);
        const data = (await res.json()) as { status: string; error?: string };
        setStatus(data.status);
        if (data.status === 'PROCESSING_LLM') setStep('Analyse du contenu…');
        if (data.status === 'PROCESSING_RENDER') setStep('Mise en page du carrousel…');
        if (data.status === 'COMPLETED') {
          window.location.href = `/result/${generationId}`;
        }
        if (data.status === 'FAILED') {
          alert(`Erreur : ${data.error || 'Génération échouée'}`);
          window.location.href = '/generate';
        }
      } catch {
        // ignore
      }
    };

    const interval = setInterval(poll, 2000);
    poll();
    return () => clearInterval(interval);
  }, [generationId]);

  return (
    <div className="container text-center" style={{ marginTop: '100px' }}>
      <div className="spinner" style={{ margin: '0 auto 24px' }} />
      <h1>Génération en cours</h1>
      <p style={{ color: 'var(--muted)', fontSize: 18, marginTop: 16 }}>
        {step}
      </p>
    </div>
  );
}