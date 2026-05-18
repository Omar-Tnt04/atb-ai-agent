import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getToken,
  getUser,
  removeToken,
  removeUser,
} from '../utils/authStorage';

function ChatPage() {
  const navigate = useNavigate();
  const token = getToken();
  const user = getUser();

  useEffect(() => {
    if (!token || !user) {
      navigate('/login');
    }
  }, [navigate, token, user]);

  const handleLogout = () => {
    removeToken();
    removeUser();
    navigate('/login');
  };

  if (!user) {
    return null;
  }

  return (
    <section className="chat-layout">
      <div className="chat-header">
        <p className="eyebrow">Agent Workspace</p>
        <h1>Banking assistant chat</h1>
      </div>

      <div className="chat-window">
        <div className="account-summary">
          <h2>Welcome, {user.fullName}</h2>
          <p>Role: {user.role}</p>
          <p>Phone: {user.phoneNumber || 'Not registered'}</p>
          <button type="button" className="secondary-button" onClick={handleLogout}>
            Logout
          </button>
        </div>

        <div className="message message-agent">
          <p>Chat service is ready for the next implementation phase.</p>
        </div>
      </div>

      <div className="chat-input-row">
        <input type="text" placeholder="Chat input disabled" disabled />
        <button type="button" className="secondary-button" disabled>
          Send
        </button>
      </div>
    </section>
  );
}

export default ChatPage;
