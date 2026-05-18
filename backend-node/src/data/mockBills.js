const mockBills = [
  {
    userId: 'user_client_001',
    billReference: 'STEG-2026-001',
    provider: 'STEG',
    amount: 126.5,
    currency: 'TND',
    status: 'unpaid',
    paidAt: null,
  },
  {
    userId: 'user_client_001',
    billReference: 'SONEDE-2026-001',
    provider: 'SONEDE',
    amount: 48.75,
    currency: 'TND',
    status: 'unpaid',
    paidAt: null,
  },
  {
    userId: 'user_client_001',
    billReference: 'OOREDOO-2026-001',
    provider: 'Ooredoo',
    amount: 32,
    currency: 'TND',
    status: 'unpaid',
    paidAt: null,
  },
];

module.exports = mockBills;
