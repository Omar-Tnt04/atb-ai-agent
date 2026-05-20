const externalComplaintConnector = require('./externalComplaint.connector');
const mockComplaintConnector = require('./mockComplaint.connector');

const SANDBOX_FALLBACK_REASON =
  'External service is not configured. Sandbox execution used for MVP demonstration.';

const executeHybrid = async (operationName, args) => {
  const externalResult =
    await externalComplaintConnector.operations[operationName](args);

  if (externalResult.success) {
    return {
      ...externalResult,
      source: 'external',
      fallbackUsed: false,
    };
  }

  const fallbackResult =
    await mockComplaintConnector.operations[operationName](args);

  if (!fallbackResult.success) {
    return fallbackResult;
  }

  return {
    ...fallbackResult,
    source: 'sandbox',
    fallbackUsed: true,
    fallbackReason: SANDBOX_FALLBACK_REASON,
  };
};

module.exports = {
  name: 'hybridComplaintConnector',
  description: 'Hybrid complaint connector with external-first mock fallback',
  operations: {
    createComplaint: (args) => executeHybrid('createComplaint', args),
    listComplaints: (args) => executeHybrid('listComplaints', args),
    checkComplaintStatus: (args) => executeHybrid('checkComplaintStatus', args),
  },
};
