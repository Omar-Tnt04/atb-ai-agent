const mockAccounts = require('../../data/mockAccounts');
const mockDocuments = require('../../data/mockDocuments');

const getClientAccount = (user, accountId) => {
  return mockAccounts.find(
    (account) => account.id === accountId && account.userId === user.id,
  );
};

module.exports = {
  name: 'mockDocumentConnector',
  description: 'Demo document connector for MVP',
  operations: {
    listDocuments: async ({ user }) => ({
      success: true,
      data: {
        documents: mockDocuments.filter((document) => document.userId === user.id),
      },
    }),

    generateDocument: async ({ user, payload }) => {
      const account = getClientAccount(user, payload.accountId);

      if (!account) {
        return {
          success: false,
          status: 'not_found',
          message: 'Account not found for authenticated user',
        };
      }

      const documentId = `doc_generated_${Date.now()}`;
      const document = {
        documentId,
        title: `${account.type} ${payload.documentType} - ${payload.period}`,
        status: 'generated',
        downloadUrl: `https://mock.atb.local/documents/${documentId}.pdf`,
      };

      mockDocuments.push({
        id: documentId,
        userId: user.id,
        accountId: payload.accountId,
        documentType: payload.documentType,
        period: payload.period,
        ...document,
      });

      return {
        success: true,
        data: {
          document,
        },
      };
    },
  },
};
