'use client';

import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

const MIN_WORDS = 80;
const MAX_WORDS = 3000;

export default function GeneratePage() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [wordCount, setWordCount] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [credits, setCredits] = useState(2); // Mock

  const countWords = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setText(value);
    setWordCount(countWords(value));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (wordCount < MIN_WORDS || wordCount > MAX_WORDS) return;
    if (credits <= 0) return;

    setSubmitting(true);
    try {
      // Call API to create generation
      const res = await fetch('/api/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceText: text }),
      });
      const data = (await res.json()) as { generationId?: string };
      if (data.generationId) {
        router.push(`/generating/${data.generationId}`);
      }
    } catch {
      alert('Erreur lors de la création');
    } finally {
      setSubmitting(false);
    }
  };

  const valid = wordCount >= MIN_WORDS && wordCount <= MAX_WORDS && credits > 0;

  return (
    <div className="container">
      <div className="card" style={{ maxWidth: 720 }}>
        <h1 style={{ marginBottom: 24 }}>Nouvelle génération</h1>

        {credits <= 0 && (
          <div style={{ background: '#fef3c7', border: '1px solid #f59e0b', borderRadius: 8, padding: 16, marginBottom: 24, color: '#92400e' }}>
            <strong>0 crédit restant</strong> — <a href="/buy" style={{ color: '#b45309' }}>Acheter des crédits</a>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <label style={{ display: 'block', marginBottom: 8, fontWeight: 500 }}>
            Collez votre texte ici — article, post, réflexion…
          </label>
          <textarea
            name="sourceText"
            value={text}
            onChange={handleChange}
            rows={12}
            placeholder="Collez votre texte ici..."
            style={{ marginBottom: 12 }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
            <span style={{ color: wordCount < MIN_WORDS || wordCount > MAX_WORDS ? '#ef4444' : 'var(--muted)' }}>
              {wordCount} / {MAX_WORDS} mots
            </span>
            {wordCount < MIN_WORDS && (
              <span style={{ color: '#ef4444', fontSize: 14 }}>
                Minimum {MIN_WORDS} mots
              </span>
            )}
            {wordCount > MAX_WORDS && (
              <span style={{ color: '#ef4444', fontSize: 14 }}>
                Maximum {MAX_WORDS} mots
              </span>
            )}
          </div>

          <button
            type="submit"
            className="btn-primary"
            style={{ width: '100%' }}
            disabled={!valid || submitting}
          >
            {submitting ? 'Génération…' : 'Générer mon carrousel'}
          </button>
        </form>
      </div>
    </div>
  );
}