const externalDocumentConnector = require('./externalDocument.connector');
const mockDocumentConnector = require('./mockDocument.connector');

const SANDBOX_FALLBACK_REASON =
  'External service is not configured. Sandbox execution used for MVP demonstration.';

const executeHybrid = async (operationName, args) => {
  const externalResult =
    await externalDocumentConnector.operations[operationName](args);

  if (externalResult.success) {
    return {
      ...externalResult,
      source: 'external',
      fallbackUsed: false,
    };
  }

  const fallbackResult = await mockDocumentConnector.operations[operationName](args);

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
  name: 'hybridDocumentConnector',
  description: 'Hybrid document connector with external-first mock fallback',
  operations: {
    listDocuments: (args) => executeHybrid('listDocuments', args),
    generateDocument: (args) => executeHybrid('generateDocument', args),
  },
};
