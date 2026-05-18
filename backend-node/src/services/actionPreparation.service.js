const { getActionByName } = require('../actions/actionRegistry');
const mockAccounts = require('../data/mockAccounts');
const { maskAccountNumber } = require('../utils/mask');
const { getMissingFields } = require('../utils/validation');

const formatFieldLabel = (field) => {
  return field
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (character) => character.toUpperCase());
};

const getMaskedAccountLabel = (accountId, user) => {
  const account = mockAccounts.find(
    (mockAccount) =>
      mockAccount.id === accountId &&
      (mockAccount.userId === user.id || user.role !== 'CLIENT'),
  );

  if (!account) {
    return accountId;
  }

  return maskAccountNumber(account.accountNumber);
};

const buildSummary = (action, payload, user) => {
  const summary = [`Action: ${action.displayName}`];

  action.requiredFields.forEach((field) => {
    const value = payload[field];

    if (field === 'accountId' || field === 'fromAccountId') {
      summary.push(`Account: ${getMaskedAccountLabel(value, user)}`);
      return;
    }

    if (field === 'accountNumber') {
      summary.push(`Account number: ${maskAccountNumber(value)}`);
      return;
    }

    summary.push(`${formatFieldLabel(field)}: ${value}`);
  });

  return summary;
};

const prepareAction = ({ actionName, payload = {}, user }) => {
  const action = getActionByName(actionName);

  if (!action) {
    return {
      httpStatus: 404,
      body: {
        success: false,
        status: 'not_found',
        message: 'Action not found',
      },
    };
  }

  if (!action.allowedRoles.includes(user.role)) {
    return {
      httpStatus: 403,
      body: {
        success: false,
        status: 'forbidden',
        message: 'Action is not allowed for this user role',
      },
    };
  }

  const missingFields = getMissingFields(action.requiredFields, payload);

  if (missingFields.length > 0) {
    return {
      httpStatus: 400,
      body: {
        success: false,
        status: 'missing_fields',
        missingFields,
      },
    };
  }

  if (action.status === 'not_connected') {
    return {
      httpStatus: 400,
      body: {
        success: false,
        status: 'not_connected',
        message: 'This action is understood but not connected in the current MVP.',
      },
    };
  }

  return {
    httpStatus: 200,
    body: {
      success: true,
      status: 'prepared',
      message: 'Action prepared successfully',
      data: {
        actionName: action.name,
        displayName: action.displayName,
        riskLevel: action.riskLevel,
        requiresConfirmation: action.requiresConfirmation,
        requiresSmsVerification: action.requiresSmsVerification,
        apiEndpoint: action.apiEndpoint,
        method: action.method,
        payload,
        summary: buildSummary(action, payload, user),
      },
    },
  };
};

module.exports = {
  prepareAction,
};
