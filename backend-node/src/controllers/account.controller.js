const mockAccounts = require('../data/mockAccounts');
const mockTransactions = require('../data/mockTransactions');
const { maskAccountNumber } = require('../utils/mask');

const toSafeAccount = (account) => {
  return {
    id: account.id,
    accountNumber: maskAccountNumber(account.accountNumber),
    type: account.type,
    currency: account.currency,
    balance: account.balance,
    status: account.status,
  };
};

const getClientAccounts = (user) => {
  if (user.role !== 'CLIENT') {
    return [];
  }

  return mockAccounts.filter((account) => account.userId === user.id);
};

const findOwnedAccount = (user, accountId) => {
  return getClientAccounts(user).find((account) => account.id === accountId);
};

const getAccounts = (req, res) => {
  if (req.user.role !== 'CLIENT') {
    return res.json({
      success: true,
      message: 'No client accounts are available for this user role',
      accounts: [],
    });
  }

  return res.json({
    success: true,
    message: 'Accounts retrieved successfully',
    accounts: getClientAccounts(req.user).map(toSafeAccount),
  });
};

const getAccountBalance = (req, res) => {
  const account = findOwnedAccount(req.user, req.params.accountId);

  if (!account) {
    return res.status(404).json({
      success: false,
      message: 'Account not found for authenticated user',
    });
  }

  return res.json({
    success: true,
    message: 'Account balance retrieved successfully',
    account: {
      id: account.id,
      accountNumber: maskAccountNumber(account.accountNumber),
      type: account.type,
      currency: account.currency,
      balance: account.balance,
    },
  });
};

const getAccountTransactions = (req, res) => {
  const account = findOwnedAccount(req.user, req.params.accountId);

  if (!account) {
    return res.status(404).json({
      success: false,
      message: 'Account not found for authenticated user',
    });
  }

  const transactions = mockTransactions.filter(
    (transaction) => transaction.accountId === account.id,
  );

  return res.json({
    success: true,
    message: 'Account transactions retrieved successfully',
    account: {
      id: account.id,
      accountNumber: maskAccountNumber(account.accountNumber),
      type: account.type,
      currency: account.currency,
    },
    transactions,
  });
};

module.exports = {
  getAccounts,
  getAccountBalance,
  getAccountTransactions,
};
