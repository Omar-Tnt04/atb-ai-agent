const externalPaymentConnector = require('./externalPayment.connector');
const sandboxPaymentConnector = require('./sandboxPayment.connector');

const SANDBOX_FALLBACK_REASON =
  'External service is not configured. Sandbox execution used for MVP demonstration.';

const executeHybrid = async (operationName, args) => {
  const externalResult =
    await externalPaymentConnector.operations[operationName](args);

  if (externalResult.success) {
    return {
      ...externalResult,
      source: 'external',
      fallbackUsed: false,
    };
  }

  const fallbackResult =
    await sandboxPaymentConnector.operations[operationName](args);

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
  name: 'hybridPaymentConnector',
  description: 'Hybrid payment connector with external-first sandbox fallback',
  operations: {
    prepareBillPayment: (args) => executeHybrid('prepareBillPayment', args),
    executeBillPayment: (args) => executeHybrid('executeBillPayment', args),
  },
};
