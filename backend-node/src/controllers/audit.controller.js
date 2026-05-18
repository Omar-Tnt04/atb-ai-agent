const {
  getAuditLogs,
  getAuditLogsByUser,
} = require('../services/auditLog.service');

const getVisibleAuditLogs = (req, res) => {
  const logs =
    req.user.role === 'SUPPORT_AGENT' || req.user.role === 'ADMIN'
      ? getAuditLogs()
      : getAuditLogsByUser(req.user.id);

  return res.json({
    success: true,
    message: 'Audit logs retrieved successfully',
    data: logs,
  });
};

const getMyAuditLogs = (req, res) => {
  return res.json({
    success: true,
    message: 'User audit logs retrieved successfully',
    data: getAuditLogsByUser(req.user.id),
  });
};

module.exports = {
  getMyAuditLogs,
  getVisibleAuditLogs,
};
