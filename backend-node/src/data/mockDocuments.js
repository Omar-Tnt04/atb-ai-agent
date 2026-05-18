const mockDocuments = [
  {
    id: 'doc_001',
    userId: 'user_client_001',
    accountId: 'acc_001',
    title: 'Current Account Statement - April 2026',
    documentType: 'statement',
    period: 'April 2026',
    status: 'available',
    downloadUrl: 'https://mock.atb.local/documents/doc_001.pdf',
  },
  {
    id: 'doc_002',
    userId: 'user_client_001',
    accountId: 'acc_002',
    title: 'Savings Account Statement - April 2026',
    documentType: 'statement',
    period: 'April 2026',
    status: 'available',
    downloadUrl: 'https://mock.atb.local/documents/doc_002.pdf',
  },
];

module.exports = mockDocuments;
