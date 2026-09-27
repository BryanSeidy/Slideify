'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

export default function ResultPage() {
  const params = useParams();
  const generationId = params.id as string;
  const [slides, setSlides] = useState([]);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // In real app, fetch from API
    const mockSlides = [
      { order: 1, title: 'Introduction', body: 'Contenu de la slide 1' },
      { order: 2, title: 'Point clé', body: 'Contenu de la slide 2' },
      { order: 3, title: 'Développement', body: 'Contenu de la slide 3' },
      { order: 4, title: 'Exemple', body: 'Contenu de la slide 4' },
      { order: 5, title: 'Conclusion', body: 'Contenu de la slide 5' },
    ];
    setSlides(mockSlides);
    setLoading(false);
  }, [generationId]);

  if (loading) return <div className="container text-center"><div className="spinner" style={{ margin: '100px auto' }} /></div>;

  return (
    <div className="container">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1>Résultat</h1>
        <a href="/dashboard" className="btn-secondary">Retour au tableau de bord</a>
      </div>

      <div className="carousel-container">
        {slides.map((slide, i) => (
          <div key={slide.order} className={`carousel-slide ${i === currentSlide ? 'active' : ''}`} style={{ padding: 40, textAlign: 'center' }}>
            <div style={{ fontSize: 12, opacity: 0.4, marginBottom: 24 }}>Slide {slide.order} / {slides.length}</div>
            <h2 style={{ fontSize: 32, marginBottom: 16 }}>{slide.title}</h2>
            <p style={{ fontSize: 18, opacity: 0.8, lineHeight: 1.6 }}>{slide.body}</p>
          </div>
        ))}
        {slides.length > 1 && (
          <>
            <button className="carousel-nav prev" onClick={() => setCurrentSlide((p) => (p - 1 + slides.length) % slides.length)} disabled={slides.length <= 1}>‹</button>
            <button className="carousel-nav next" onClick={() => setCurrentSlide((p) => (p + 1) % slides.length)} disabled={slides.length <= 1}>›</button>
          </>
        )}
      </div>

      <div style={{ display: 'flex', gap: 16, justifyContent: 'center', marginTop: 32 }}>
        <button className="btn-primary">Télécharger les images (ZIP)</button>
        <button className="btn-secondary">Télécharger le PDF</button>
      </div>
    </div>
  );
}