export default function AuthPage() {
  return (
    <div className="container">
      <div className="card" style={{ maxWidth: 400, margin: '60px auto' }}>
        <h1 style={{ marginBottom: 8 }}>Slideify</h1>
        <p style={{ color: 'var(--muted)', marginBottom: 32 }}>
          Transformez votre texte en carrousels professionnels
        </p>

        <form id="auth-form">
          <label style={{ display: 'block', marginBottom: 8, fontWeight: 500 }}>
            Email
          </label>
          <input
            type="email"
            name="email"
            placeholder="vous@exemple.com"
            required
            autoComplete="email"
            style={{ marginBottom: 16 }}
          />
          <button type="submit" className="btn-primary" style={{ width: '100%' }}>
            Envoyer le lien magique
          </button>
        </form>

        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 16, textAlign: 'center' }}>
          Pas de mot de passe — un lien unique envoyé par email
        </p>
      </div>
    </div>
  );
}