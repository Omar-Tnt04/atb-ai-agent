import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import ChatPage from './pages/ChatPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import HomePage from './pages/HomePage.jsx';
import { getToken, getUser } from './utils/authStorage';
import { getRoleHomePath, isAdminRole } from './utils/roleLabels';

function ChatRoute() {
  const user = getUser();

  if (!getToken() || !user) {
    return <Navigate to="/" replace />;
  }

  if (isAdminRole(user.role)) {
    return <Navigate to="/dashboard" replace />;
  }

  return <ChatPage />;
}

function DashboardRoute() {
  const user = getUser();

  if (!getToken() || !user) {
    return <Navigate to="/" replace />;
  }

  if (!isAdminRole(user.role)) {
    return <Navigate to="/chat" replace />;
  }

  return <DashboardPage />;
}

function AuditRedirect() {
  const user = getUser();

  if (!getToken() || !user) {
    return <Navigate to="/" replace />;
  }

  return <Navigate to={getRoleHomePath(user.role)} replace />;
}

function App() {
  const location = useLocation();
  const isChatWorkspace = location.pathname === '/chat';
  const isDashboard = location.pathname === '/dashboard';
  const isHomePage = location.pathname === '/' || location.pathname === '/login';

  return (
    <div className="app-shell">
      <main
        className={`page-shell ${isChatWorkspace ? 'workspace-shell' : ''} ${
          isDashboard ? 'dashboard-shell' : ''
        } ${isHomePage ? 'home-shell' : ''}`}
      >
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/chat" element={<ChatRoute />} />
          <Route path="/dashboard" element={<DashboardRoute />} />
          <Route path="/audit" element={<AuditRedirect />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
