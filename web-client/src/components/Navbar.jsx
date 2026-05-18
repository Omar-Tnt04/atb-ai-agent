import { NavLink } from 'react-router-dom';

function Navbar() {
  return (
    <header className="navbar">
      <NavLink to="/" className="brand" aria-label="ATB AI Banking Agent Home">
        <span className="brand-mark">ATB</span>
        <span className="brand-text">AI Banking Agent</span>
      </NavLink>

      <nav className="nav-links" aria-label="Primary navigation">
        <NavLink to="/">Home</NavLink>
        <NavLink to="/login">Login</NavLink>
        <NavLink to="/chat">Chat</NavLink>
      </nav>
    </header>
  );
}

export default Navbar;
