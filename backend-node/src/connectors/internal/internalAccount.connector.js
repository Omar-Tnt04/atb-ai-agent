const mockAccounts = require('../../data/mockAccounts');
const { maskAccountNumber } = require('../../utils/mask');
const { callInternalService } = require('./internalService.client');

const getClientAccount = (user, accountId) =>
  mockAccounts.find(
    (account) => account.id === accountId && account.userId === user.id,
  );

// Resolves account ownership locally, then reads the balance from the internal
// demo account service over HTTP.
const checkBalance = async ({ user, payload }) => {
  const ownedAccount = getClientAccount(user, payload.accountId);

  if (!ownedAccount) {
    return {
      success: false,
      status: 'not_found',
      message: 'Account not found for authenticated user',
    };
  }

  const result = await callInternalService({
    serviceName: 'account',
    method: 'GET',
    path: `/accounts/${encodeURIComponent(ownedAccount.id)}/balance`,
  });

  if (!result.success) {
    return result;
  }

  const account = result.data.account || {};

  return {
    success: true,
    source: result.source,
    fallbackUsed: false,
    serviceName: result.serviceName,
    data: {
      account: {
        id: account.id,
        accountNumber: maskAccountNumber(account.accountNumber || ''),
        type: account.type,
        currency: account.currency,
        balance: account.balance,
        status: account.status,
      },
    },
  };
};

module.exports = {
  name: 'internalAccountConnector',
  description: 'Routes balance lookups to the internal demo account service',
  operations: {
    checkBalance,
  },
};
