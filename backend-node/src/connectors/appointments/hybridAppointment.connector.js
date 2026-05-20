const externalAppointmentConnector = require('./externalAppointment.connector');
const mockAppointmentConnector = require('./mockAppointment.connector');

const SANDBOX_FALLBACK_REASON =
  'External service is not configured. Sandbox execution used for MVP demonstration.';

const executeHybrid = async (operationName, args) => {
  const externalResult =
    await externalAppointmentConnector.operations[operationName](args);

  if (externalResult.success) {
    return {
      ...externalResult,
      source: 'external',
      fallbackUsed: false,
    };
  }

  const fallbackResult =
    await mockAppointmentConnector.operations[operationName](args);

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
  name: 'hybridAppointmentConnector',
  description: 'Hybrid appointment connector with external-first mock fallback',
  operations: {
    listAppointmentSlots: (args) => executeHybrid('listAppointmentSlots', args),
    bookAppointment: (args) => executeHybrid('bookAppointment', args),
  },
};
