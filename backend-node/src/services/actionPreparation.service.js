const { getActionByName } = require('../actions/actionRegistry');
const {
  getSafeServiceStatus,
} = require('../connectors/external/externalService.config');
const mockAccounts = require('../data/mockAccounts');
const { maskAccountNumber } = require('../utils/mask');
const { getMissingFields } = require('../utils/validation');

// Maps an action category to its external service name (externalService.config).
const CATEGORY_EXTERNAL_SERVICE = {
  payments: 'payment',
  documents: 'document',
  complaints: 'complaint',
  appointments: 'appointment',
};

// Determines whether an action will run against a real external connector or
// the sandbox/demo connector. Used to label the workflow honestly in the UI.
const getExecutionMode = (action) => {
  if (!action || action.status !== 'connected') {
    return 'none';
  }

  const connector = action.connector || '';

  if (connector.startsWith('hybrid')) {
    const serviceName = CATEGORY_EXTERNAL_SERVICE[action.category];

    if (!serviceName) {
      return 'sandbox';
    }

    const status = getSafeServiceStatus(serviceName);
    return status.enabled && status.configured ? 'external' : 'sandbox';
  }

  // sandbox*, mock*, or internal switch-handled actions all run in sandbox mode.
  return 'sandbox';
};

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

    if (
      field === 'accountId' ||
      field === 'fromAccountId' ||
      field === 'sourceAccountId'
    ) {
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

  const executionMode = getExecutionMode(action);

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
        executionMode,
        externalConnectorConfigured: executionMode === 'external',
        payload,
        summary: buildSummary(action, payload, user),
      },
    },
  };
};

module.exports = {
  buildSummary,
  getExecutionMode,
  prepareAction,
};
