import { useState } from 'react';
import apiClient from '../api/client';

function HomePage() {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const testBackendConnection = async () => {
    setIsLoading(true);
    setError('');

    try {
      const response = await apiClient.get('/health');
      setHealth(response.data);
    } catch (requestError) {
      setHealth(null);
      setError(
        requestError.response?.data?.message ||
          requestError.message ||
          'Unable to reach backend',
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <section className="page-grid">
      <div className="hero-panel">
        <p className="eyebrow">ATB AI Banking Agent MVP</p>
        <h1>Simple banking support, prepared for secure automation.</h1>
        <p className="lead">
          A clean web shell for the customer-facing agent experience, ready for
          authentication, chat, and banking modules in later phases.
        </p>

        <button
          type="button"
          className="primary-button"
          onClick={testBackendConnection}
          disabled={isLoading}
        >
          {isLoading ? 'Checking backend...' : 'Test backend connection'}
        </button>
      </div>

      <aside className="status-panel" aria-live="polite">
        <div className="panel-header">
          <span className="status-dot" aria-hidden="true" />
          <h2>Backend Health</h2>
        </div>

        {health ? (
          <pre className="response-box">{JSON.stringify(health, null, 2)}</pre>
        ) : (
          <p className="muted">No backend response yet.</p>
        )}

        {error ? <p className="error-text">{error}</p> : null}
      </aside>
    </section>
  );
}

export default HomePage;
