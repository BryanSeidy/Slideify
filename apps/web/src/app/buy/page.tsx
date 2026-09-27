'use client';

import { useState } from 'react';

export default function BuyPage() {
  const [loading, setLoading] = useState(false);

  const handlePurchase = async () => {
    setLoading(true);
    // In real app, create Stripe Checkout session
    setTimeout(() => {
      setLoading(false);
      // Redirect to Stripe
      window.location.href = 'https://checkout.stripe.com/pay/test';
    }, 1000);
  };

  return (
    <div className="container text-center" style={{ marginTop: '100px' }}>
      <div className="card" style={{ maxWidth: 400, margin: '0 auto' }}>
        <h1 style={{ marginBottom: 16 }}>Acheter des crédits</h1>
        <p style={{ color: 'var(--muted)', marginBottom: 32 }}>
          Vous n'avez plus de crédits. Achetez un pack pour continuer.
        </p>

        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, marginBottom: 24 }}>
          <div style={{ fontSize: 48, fontWeight: 700, marginBottom: 8 }}>20 crédits</div>
          <div style={{ color: 'var(--muted)', marginBottom: 16 }}>Pack unique — pas d'abonnement</div>
          <div style={{ fontSize: 14, color: 'var(--muted)' }}>
            <del>19,90 €</del> <strong>9,90 €</strong> (lancement)
          </div>
        </div>

        <button
          className="btn-primary"
          style={{ width: '100%', padding: '16px', fontSize: 18 }}
          onClick={handlePurchase}
          disabled={loading}
        >
          {loading ? 'Redirection vers Stripe…' : 'Acheter 20 crédits — 9,90 €'}
        </button>

        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 16 }}>
          Paiement sécurisé par Stripe. Pas de stockage de carte.
        </p>
      </div>
    </div>
  );
}