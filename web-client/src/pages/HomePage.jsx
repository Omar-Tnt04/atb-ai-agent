import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { login } from '../api/authApi';
import Button from '../components/Button.jsx';
import Logo from '../components/Logo.jsx';
import { getToken, getUser, saveToken, saveUser } from '../utils/authStorage';
import { getRoleHomePath, isAdminRole } from '../utils/roleLabels';

function HomePage() {
  const navigate = useNavigate();
  const user = getUser();
  const isLoggedIn = Boolean(getToken() && user);
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
      navigate(getRoleHomePath(data.user?.role));
    } catch (requestError) {
      const message =
        requestError.response?.data?.message ||
        'We could not sign you in. Please check your credentials and try again.';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <section className="home-page">
      <div className="home-split-panel home-split-panel-brand">
        <div className="home-main">
          <div className="home-brand">
            <Logo />
          </div>

          <p className="eyebrow">ATB Digital Banking Assistant</p>
          
        </div>
      </div>

      <div className="home-split-panel home-split-panel-auth">
        <section className="home-auth-panel" aria-labelledby="home-auth-title">
          {isLoggedIn ? (
            <div className="signed-in-panel">
              <p className="eyebrow">Secure session active</p>
              <h2 id="home-auth-title">Continue your ATB session</h2>
              <p className="muted">
                You are signed in as {isAdminRole(user?.role) ? 'ADMIN' : 'USER'}.
              </p>
              <Button as={Link} to={getRoleHomePath(user.role)}>
                {isAdminRole(user?.role) ? 'Open dashboard' : 'Open chat'}
              </Button>
            </div>
          ) : (
            <>
              <div className="auth-heading">
                <h2 id="home-auth-title">Sign in</h2>
                <p className="muted">
                  Use your ATB credentials to enter the assistant workspace.
                </p>
              </div>

              <form className="login-form" onSubmit={handleSubmit}>
                <label>
                  Email address
                  <input
                    type="email"
                    value={email}
                    placeholder="user@atb.com"
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

                <Button type="submit" disabled={isLoading}>
                  {isLoading ? 'Signing in...' : 'Sign in'}
                </Button>

                {error ? <p className="error-text" role="alert">{error}</p> : null}
              </form>

              <div className="demo-panel">
                <p className="eyebrow">Demo credentials</p>
                <div className="credential-list">
                  <p>
                    <strong>USER</strong>
                    <span>user@atb.com / user123</span>
                  </p>
                  <p>
                    <strong>ADMIN</strong>
                    <span>admin@atb.com / admin123</span>
                  </p>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </section>
  );
}

export default HomePage;
