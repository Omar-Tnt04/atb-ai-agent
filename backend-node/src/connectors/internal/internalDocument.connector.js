const mockAccounts = require('../../data/mockAccounts');
const { callInternalService } = require('./internalService.client');

const getClientAccount = (user, accountId) =>
  mockAccounts.find(
    (account) => account.id === accountId && account.userId === user.id,
  );

const generateDocument = async ({ user, payload }) => {
  const account = getClientAccount(user, payload.accountId);

  if (!account) {
    return {
      success: false,
      status: 'not_found',
      message: 'Account not found for authenticated user',
    };
  }

  const result = await callInternalService({
    serviceName: 'document',
    method: 'POST',
    path: '/documents/generate',
    data: {
      userId: user.id,
      accountId: account.id,
      documentType: payload.documentType,
      period: payload.period,
    },
  });

  if (!result.success) {
    return result;
  }

  return {
    success: true,
    source: result.source,
    fallbackUsed: false,
    serviceName: result.serviceName,
    data: {
      document: {
        documentId: result.data.documentId,
        title: result.data.title,
        status: result.data.status,
        downloadUrl: result.data.downloadUrl,
      },
    },
  };
};

module.exports = {
  name: 'internalDocumentConnector',
  description: 'Routes document generation to the internal demo document service',
  operations: {
    generateDocument,
  },
};
