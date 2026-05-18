const mockTransactions = [
  {
    id: 'txn_001',
    accountId: 'acc_001',
    date: '2026-05-14',
    description: 'Card payment - Grocery store',
    amount: -86.4,
    currency: 'TND',
    status: 'completed',
  },
  {
    id: 'txn_002',
    accountId: 'acc_001',
    date: '2026-05-12',
    description: 'Salary deposit',
    amount: 2100,
    currency: 'TND',
    status: 'completed',
  },
  {
    id: 'txn_003',
    accountId: 'acc_001',
    date: '2026-05-09',
    description: 'ATM withdrawal',
    amount: -120,
    currency: 'TND',
    status: 'completed',
  },
  {
    id: 'txn_004',
    accountId: 'acc_002',
    date: '2026-05-03',
    description: 'Savings interest',
    amount: 18.25,
    currency: 'TND',
    status: 'completed',
  },
];

module.exports = mockTransactions;
