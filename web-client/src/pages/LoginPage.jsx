import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login } from '../api/authApi';
import { saveToken, saveUser } from '../utils/authStorage';

function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const data = await login(email, password);
      saveToken(data.token);
      saveUser(data.user);
      navigate('/chat');
    } catch (requestError) {
      setError(
        requestError.response?.data?.message ||
          requestError.message ||
          'Login failed',
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <section className="narrow-page">
      <div className="form-panel">
        <p className="eyebrow">Secure Access</p>
        <h1>Customer login</h1>
        <form className="login-form" onSubmit={handleSubmit}>
          <label>
            Email address
            <input
              type="email"
              value={email}
              placeholder="client@atb.com"
              autoComplete="email"
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>

          <label>
            Password
            <input
              type="password"
              value={password}
              placeholder="Password"
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>

          <button type="submit" className="primary-button" disabled={isLoading}>
            {isLoading ? 'Logging in...' : 'Login'}
          </button>

          {error ? <p className="error-text">{error}</p> : null}
        </form>

        <div className="demo-credentials">
          <h2>Demo credentials</h2>
          <p>
            <strong>Client:</strong> client@atb.com / client123
          </p>
          <p>
            <strong>Employee:</strong> employee@atb.com / employee123
          </p>
          <p>
            <strong>Admin:</strong> admin@atb.com / admin123
          </p>
        </div>
      </div>
    </section>
  );
}

export default LoginPage;
