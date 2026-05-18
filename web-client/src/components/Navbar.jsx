import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  getToken,
  getUser,
  removeToken,
  removeUser,
} from '../utils/authStorage';

function Navbar() {
  useLocation();
  const navigate = useNavigate();
  const isLoggedIn = Boolean(getToken() && getUser());

  const handleLogout = () => {
    removeToken();
    removeUser();
    navigate('/login');
  };

  return (
    <header className="navbar">
      <NavLink to="/" className="brand" aria-label="ATB AI Banking Agent Home">
        <span className="brand-mark">ATB</span>
        <span className="brand-text">AI Banking Agent</span>
      </NavLink>

      <nav className="nav-links" aria-label="Primary navigation">
        {isLoggedIn ? (
          <>
            <NavLink to="/chat">Chat</NavLink>
            <button type="button" className="nav-button" onClick={handleLogout}>
              Logout
            </button>
          </>
        ) : (
          <>
            <NavLink to="/">Home</NavLink>
            <NavLink to="/login">Login</NavLink>
          </>
        )}
      </nav>
    </header>
  );
}

export default Navbar;
