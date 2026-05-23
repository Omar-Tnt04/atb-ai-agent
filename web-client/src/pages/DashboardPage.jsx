import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAllAuditLogs } from '../api/auditApi';
import { getConnectors, getInternalServiceStatus } from '../api/integrationApi';
import Badge from '../components/Badge.jsx';
import Button from '../components/Button.jsx';
import Card from '../components/Card.jsx';
import {
  getToken,
  getUser,
  removeToken,
  removeUser,
} from '../utils/authStorage';
import { getDisplayRole, isAdminRole } from '../utils/roleLabels';

const statusLabels = {
  completed: 'Completed',
  failed: 'Failed',
  confirmation_required: 'Confirmation Required',
  sms_required: 'SMS Required',
  sms_verified: 'SMS Verified',
  cancelled: 'Cancelled',
  missing_fields: 'Missing Fields',
  not_connected: 'Not Connected',
  sms_failed: 'SMS Failed',
  service_unavailable: 'Service Unavailable',
};

const CONNECTOR_CATEGORY_ORDER = [
  'ATB',
  'Documents',
  'Payments',
  'Appointments',
  'Transfers',
  'Notifications',
  'Other',
];

const SERVICE_DISPLAY_LABELS = {
  atb: 'ATB',
};

const SERVICE_DESCRIPTION_LABELS = {
  atb: 'General ATB internal service',
};

const formatDate = (value) => {
  if (!value) return '-';

  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) return value;

  return parsedDate.toLocaleString();
};

const formatValue = (value) => {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return value;
};

const formatLabel = (value = '') => {
  if (!value) return '-';

  return String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
};

const formatServiceName = (value = '') =>
  SERVICE_DISPLAY_LABELS[String(value).toLowerCase()] || formatLabel(value);

const formatServiceDescription = (value = '') =>
  SERVICE_DESCRIPTION_LABELS[String(value).toLowerCase()] ||
  `ATB ${formatServiceName(value)} internal service`;

const statusTone = (status) => {
  if (['completed', 'sms_verified'].includes(status)) return 'success';
  if (['failed', 'sms_failed', 'cancelled', 'service_unavailable'].includes(status))
    return 'danger';

  if (
    ['confirmation_required', 'sms_required', 'missing_fields'].includes(status)
  ) {
    return 'warning';
  }

  return 'neutral';
};

const riskTone = (riskLevel) => {
  if (riskLevel === 'high') return 'danger';
  if (riskLevel === 'medium') return 'warning';
  if (riskLevel === 'low') return 'success';
  return 'neutral';
};

const serviceStatusLabel = (service) => {
  if (!service.enabled) return 'Disabled';
  if (service.status === 'connected') return 'Connected';
  return 'Offline';
};

const serviceTone = (service) => {
  if (!service.enabled) return 'neutral';
  if (service.status === 'connected') return 'success';
  return 'danger';
};

const getConnectorCategory = (connector) => {
  const source = `${connector.name || ''} ${connector.description || ''}`.toLowerCase();

  if (source.includes('document')) return 'Documents';
  if (source.includes('payment') || source.includes('bill')) return 'Payments';
  if (source.includes('atb') || source.includes('complaint')) return 'ATB';
  if (source.includes('appointment')) return 'Appointments';
  if (source.includes('transfer')) return 'Transfers';
  if (source.includes('notification') || source.includes('sms')) return 'Notifications';
  return 'Other';
};

const getLogMode = (log) => {
  if (log.connectorSource === 'internal_demo_service') return 'Internal demo service';
  return formatLabel(log.connectorSource || 'Internal demo service');
};

const getAuditReference = (log) => {
  const result = log.result || {};

  return (
    result.paymentReference ||
    result.transferReference ||
    result.complaint?.reference ||
    result.appointment?.appointmentId ||
    result.document?.documentId ||
    result.reference ||
    result.id ||
    log.confirmationId ||
    log.id
  );
};

function DashboardPage() {
  const navigate = useNavigate();
  const [token] = useState(() => getToken());
  const [user] = useState(() => getUser());
  const [logs, setLogs] = useState([]);
  const [connectors, setConnectors] = useState([]);
  const [serviceStatuses, setServiceStatuses] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const loadDashboard = useCallback(async () => {
    if (!token || !user || !isAdminRole(user.role)) return;

    setIsLoading(true);
    setErrorMessage('');

    try {
      const [auditResponse, connectorResponse, serviceStatusResponse] =
        await Promise.all([
          getAllAuditLogs(token),
          getConnectors(token),
          getInternalServiceStatus(token),
        ]);

      setLogs(auditResponse.data || []);
      setConnectors(connectorResponse.data || []);
      setServiceStatuses(serviceStatusResponse.data || []);
    } catch (error) {
      setErrorMessage(
        error.response?.data?.message ||
          'Unable to load dashboard data. Please try again.',
      );
    } finally {
      setIsLoading(false);
    }
  }, [token, user]);

  useEffect(() => {
    if (!token || !user) {
      navigate('/login');
      return;
    }

    if (!isAdminRole(user.role)) {
      navigate('/chat');
      return;
    }

    const loadTimer = window.setTimeout(loadDashboard, 0);

    return () => window.clearTimeout(loadTimer);
  }, [loadDashboard, navigate, token, user]);

  const summary = useMemo(
    () => ({
      completed: logs.filter((log) => log.status === 'completed').length,
      failed: logs.filter((log) =>
        ['failed', 'sms_failed', 'cancelled'].includes(log.status),
      ).length,
      internalServiceActions: logs.filter(
        (log) =>
          log.connectorSource === 'internal_demo_service' &&
          log.status === 'completed',
      ).length,
      offlineServiceErrors: logs.filter(
        (log) => log.status === 'service_unavailable',
      ).length,
      highRisk: logs.filter((log) => log.riskLevel === 'high').length,
      total: logs.length,
    }),
    [logs],
  );

  const groupedConnectors = useMemo(() => {
    const groups = connectors.reduce((categoryMap, connector) => {
      const category = getConnectorCategory(connector);
      return {
        ...categoryMap,
        [category]: [...(categoryMap[category] || []), connector],
      };
    }, {});

    return CONNECTOR_CATEGORY_ORDER.map((category) => ({
      category,
      connectors: groups[category] || [],
    })).filter((group) => group.connectors.length > 0);
  }, [connectors]);

  const recentLogs = useMemo(() => logs.slice().reverse().slice(0, 12), [logs]);
  const currentMode = 'Internal demo services';

  const kpis = [
    { label: 'Total audit logs', value: summary.total },
    { label: 'Completed actions', value: summary.completed },
    { label: 'Internal service actions', value: summary.internalServiceActions },
    { label: 'High-risk actions', value: summary.highRisk },
    {
      label: 'Offline service errors',
      value: summary.offlineServiceErrors,
      accent: true,
    },
  ];

  const handleLogout = () => {
    removeToken();
    removeUser();
    navigate('/login');
  };

  if (!user) return null;

  return (
    <section className="dashboard-page">
      <div className="dashboard-content">
        <header className="dashboard-hero">
          <div className="dashboard-hero-copy">
            <p className="eyebrow">Admin controls</p>
            <h1>Admin Dashboard</h1>
            <p>
              Monitor assistant activity, internal service actions, connectors,
              and service readiness.
            </p>
          </div>
          <div className="dashboard-header-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={loadDashboard}
              disabled={isLoading}
            >
              {isLoading ? 'Refreshing...' : 'Refresh'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="dashboard-logout-button"
              onClick={handleLogout}
            >
              Log out
            </Button>
          </div>
        </header>

        <div className="dashboard-kpi-grid">
          {kpis.map((kpi) => (
            <Card
              key={kpi.label}
              className={`dashboard-kpi-card ${kpi.accent ? 'dashboard-kpi-card-accent' : ''}`}
            >
              <span className="dashboard-kpi-marker" aria-hidden="true" />
              <strong>{kpi.value}</strong>
              <span>{kpi.label}</span>
            </Card>
          ))}
        </div>

        <Card className="admin-overview-strip">
          <div>
            <p className="eyebrow">Administrator</p>
            <h2>{user.fullName || user.email || 'Administrator'}</h2>
          </div>
          <dl>
            <div>
              <dt>Role</dt>
              <dd>{getDisplayRole(user.role)}</dd>
            </div>
            <div>
              <dt>Total connectors</dt>
              <dd>{connectors.length}</dd>
            </div>
            <div>
              <dt>Internal services</dt>
              <dd>{serviceStatuses.length}</dd>
            </div>
            <div>
              <dt>Current mode</dt>
              <dd>{currentMode}</dd>
            </div>
          </dl>
        </Card>

        {errorMessage ? <p className="error-text">{errorMessage}</p> : null}

        <div className="dashboard-grid">
          <Card className="dashboard-panel">
            <div className="dashboard-panel-header">
              <div>
                <p className="eyebrow">Internal services</p>
                <h2>Service Status</h2>
              </div>
              <Badge tone="neutral">{serviceStatuses.length} services</Badge>
            </div>

            <div className="service-status-list">
              {serviceStatuses.map((service) => (
                <div key={service.service} className="service-status-row">
                  <div>
                    <strong>{formatServiceName(service.service)} Service</strong>
                    <span>{formatServiceDescription(service.service)}</span>
                  </div>
                  <div className="service-pill-row">
                    <Badge tone={serviceTone(service)}>
                      {serviceStatusLabel(service)}
                    </Badge>
                  </div>
                </div>
              ))}
              {!serviceStatuses.length ? (
                <p className="dashboard-empty-note">
                  No internal service status available.
                </p>
              ) : null}
            </div>
          </Card>

          <Card className="dashboard-panel dashboard-panel-connectors">
            <div className="dashboard-panel-header">
              <div>
                <p className="eyebrow">Connector registry</p>
                <h2>Available Operations</h2>
              </div>
              <Badge tone="neutral">{connectors.length} connectors</Badge>
            </div>

            <div className="connector-category-list">
              {groupedConnectors.map((group) => (
                <section key={group.category} className="connector-category">
                  <div className="connector-category-header">
                    <h3>{group.category}</h3>
                    <span>{group.connectors.length}</span>
                  </div>

                  <div className="connector-list">
                    {group.connectors.map((connector) => (
                      <div key={connector.name} className="connector-row">
                        <div>
                          <strong>{formatLabel(connector.name)}</strong>
                          <span>
                            {connector.operations?.length || 0} operation
                            {(connector.operations?.length || 0) === 1 ? '' : 's'}
                          </span>
                        </div>
                        {connector.operations?.length ? (
                          <p>{connector.operations.map(formatLabel).join(', ')}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </section>
              ))}
              {!connectors.length ? (
                <p className="dashboard-empty-note">No connectors available.</p>
              ) : null}
            </div>
          </Card>
        </div>

        <Card className="audit-log-section">
          <div className="dashboard-panel-header">
            <div>
              <p className="eyebrow">Recent activity</p>
              <h2>Audit Logs</h2>
            </div>
            <Badge tone="neutral">{recentLogs.length} latest</Badge>
          </div>

          {!isLoading && recentLogs.length === 0 ? (
            <div className="audit-empty">
              No audit activity yet. Execute an action from the chat to populate
              this dashboard.
            </div>
          ) : (
            <div className="audit-table-wrapper">
              <table className="audit-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>User</th>
                    <th>Action</th>
                    <th>Status</th>
                    <th>Risk</th>
                    <th>Mode</th>
                    <th>Service</th>
                    <th>Connector</th>
                    <th>Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {recentLogs.map((log) => (
                    <tr key={log.id}>
                      <td>{formatDate(log.createdAt)}</td>
                      <td>{formatValue(log.userId)}</td>
                      <td>{formatLabel(log.actionName)}</td>
                      <td>
                        <Badge tone={statusTone(log.status)}>
                          {statusLabels[log.status] || formatLabel(log.status)}
                        </Badge>
                      </td>
                      <td>
                        {log.riskLevel ? (
                          <Badge tone={riskTone(log.riskLevel)}>
                            {formatLabel(log.riskLevel)}
                          </Badge>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td>{getLogMode(log)}</td>
                      <td>{log.serviceName ? formatLabel(log.serviceName) : '-'}</td>
                      <td>
                        {formatLabel(log.connectorName)}
                        {log.operationName ? ` / ${formatLabel(log.operationName)}` : ''}
                      </td>
                      <td>{formatValue(getAuditReference(log))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </section>
  );
}

export default DashboardPage;
