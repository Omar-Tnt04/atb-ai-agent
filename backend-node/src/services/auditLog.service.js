const mockAuditLogs = require('../data/mockAuditLogs');
const { maskAccountNumber } = require('../utils/mask');

const maskValue = (key, value) => {
  if (value === undefined || value === null) {
    return value;
  }

  if (key.toLowerCase().includes('account')) {
    return maskAccountNumber(String(value));
  }

  return value;
};

const maskPayload = (payload = {}) => {
  return Object.entries(payload).reduce((maskedPayload, [key, value]) => {
    maskedPayload[key] = maskValue(key, value);
    return maskedPayload;
  }, {});
};

const createAuditLog = (logData) => {
  const auditLog = {
    id: `audit_${String(mockAuditLogs.length + 1).padStart(6, '0')}`,
    userId: logData.userId,
    role: logData.role,
    actionName: logData.actionName || null,
    riskLevel: logData.riskLevel || null,
    status: logData.status,
    maskedPayload: maskPayload(logData.payload),
    apiEndpoint: logData.apiEndpoint || null,
    connectorName: logData.connectorName || null,
    operationName: logData.operationName || null,
    connectorSource: logData.connectorSource || null,
    serviceName: logData.serviceName || null,
    confirmationId: logData.confirmationId || null,
    confirmation_status: logData.confirmationStatus || null,
    sms_verification_status: logData.smsVerificationStatus || null,
    metadata: logData.metadata || null,
    result: logData.result || null,
    failureReason: logData.failureReason || null,
    createdAt: new Date().toISOString(),
  };

  mockAuditLogs.push(auditLog);

  return auditLog;
};

const getAuditLogs = () => {
  return mockAuditLogs;
};

const getAuditLogsByUser = (userId) => {
  return mockAuditLogs.filter((auditLog) => auditLog.userId === userId);
};

module.exports = {
  createAuditLog,
  getAuditLogs,
  getAuditLogsByUser,
};
