const mockAccounts = require('../data/mockAccounts');
const mockDocuments = require('../data/mockDocuments');

const getDocuments = (req, res) => {
  const documents = mockDocuments.filter(
    (document) => document.userId === req.user.id,
  );

  return res.json({
    success: true,
    message: 'Documents retrieved successfully',
    documents,
  });
};

const generateDocument = (req, res) => {
  const { accountId, documentType, period } = req.body;

  if (!accountId || !documentType || !period) {
    return res.status(400).json({
      success: false,
      message: 'accountId, documentType, and period are required',
    });
  }

  const account = mockAccounts.find(
    (mockAccount) =>
      mockAccount.id === accountId && mockAccount.userId === req.user.id,
  );

  if (!account) {
    return res.status(404).json({
      success: false,
      message: 'Account not found for authenticated user',
    });
  }

  const documentId = `doc_generated_${Date.now()}`;
  const generatedDocument = {
    documentId,
    title: `${account.type} ${documentType} - ${period}`,
    status: 'generated',
    downloadUrl: `https://mock.atb.local/documents/${documentId}.pdf`,
  };

  mockDocuments.push({
    id: documentId,
    userId: req.user.id,
    accountId,
    documentType,
    period,
    ...generatedDocument,
  });

  return res.status(201).json({
    success: true,
    message: 'Document generated successfully',
    document: generatedDocument,
  });
};

module.exports = {
  getDocuments,
  generateDocument,
};
