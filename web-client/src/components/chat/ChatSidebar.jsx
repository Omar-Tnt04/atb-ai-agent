import { useEffect, useRef, useState } from 'react';
import Logo from '../Logo.jsx';
import { formatThreadTime } from '../../utils/chatStorage';
import { getDisplayRole } from '../../utils/roleLabels';

const getInitials = (name) => {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!parts.length) {
    return '?';
  }

  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }

  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

function PersonIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function ChatSidebar({
  activeThreadId,
  onDeleteThread,
  onLogout,
  onNewThread,
  onOpenProfile,
  onSelectThread,
  profile,
  threads,
  user,
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const accountRef = useRef(null);

  const displayName = profile?.fullName?.trim() || user?.fullName || 'User';
  const displayEmail = profile?.email?.trim() || user?.email || '';
  const roleLabel = getDisplayRole(user?.role);

  useEffect(() => {
    if (!isMenuOpen) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (accountRef.current && !accountRef.current.contains(event.target)) {
        setIsMenuOpen(false);
      }
    };

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setIsMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMenuOpen]);

  const handleProfileClick = () => {
    setIsMenuOpen(false);
    onOpenProfile();
  };

  const handleLogoutClick = () => {
    setIsMenuOpen(false);
    onLogout();
  };

  return (
    <aside className="chat-sidebar">
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <Logo />
          <div>
            <p>ATB Assistant</p>
            <span>Banking workspace</span>
          </div>
        </div>

        <button
          type="button"
          className="button button-primary new-thread-button"
          onClick={onNewThread}
        >
          New conversation
        </button>
      </div>

      <div className="thread-list" aria-label="Conversation history">
        {threads.map((thread) => (
          <div
            key={thread.id}
            className={`thread-item ${thread.id === activeThreadId ? 'active' : ''}`}
            aria-current={thread.id === activeThreadId ? 'true' : undefined}
          >
            <button
              type="button"
              className="thread-select-button"
              onClick={() => onSelectThread(thread.id)}
            >
              <span>{thread.title || 'New conversation'}</span>
              <time dateTime={thread.updatedAt}>
                {formatThreadTime(thread.updatedAt)}
              </time>
            </button>
            <button
              type="button"
              className="thread-delete-button"
              aria-label={`Delete ${thread.title || 'conversation'}`}
              onClick={(event) => {
                event.stopPropagation();
                onDeleteThread(thread.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="sidebar-account" ref={accountRef}>
        {isMenuOpen ? (
          <div className="account-menu" role="menu">
            <div className="account-menu-header">
              <span className="account-avatar account-avatar-sm">
                {getInitials(displayName)}
              </span>
              <div className="account-menu-identity">
                <strong>{displayName}</strong>
                {displayEmail ? <span>{displayEmail}</span> : null}
              </div>
            </div>
            <button
              type="button"
              role="menuitem"
              className="account-menu-item"
              onClick={handleProfileClick}
            >
              <span className="account-menu-icon" aria-hidden="true">
                <PersonIcon />
              </span>
              Profile
            </button>
            <button
              type="button"
              role="menuitem"
              className="account-menu-item account-menu-item-danger"
              onClick={handleLogoutClick}
            >
              <span className="account-menu-icon" aria-hidden="true">
                <LogoutIcon />
              </span>
              Log out
            </button>
          </div>
        ) : null}

        <button
          type="button"
          className={`account-block ${isMenuOpen ? 'is-open' : ''}`.trim()}
          onClick={() => setIsMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={isMenuOpen}
        >
          <span className="account-avatar">{getInitials(displayName)}</span>
          <span className="account-identity">
            <strong>{displayName}</strong>
            <span>{roleLabel}</span>
          </span>
          <span className="account-chevron" aria-hidden="true">
            <ChevronIcon />
          </span>
        </button>
      </div>
    </aside>
  );
}

export default ChatSidebar;
