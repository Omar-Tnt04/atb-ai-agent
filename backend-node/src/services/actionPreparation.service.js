const { getActionByName } = require('../actions/actionRegistry');
const env = require('../config/env');
const mockAccounts = require('../data/mockAccounts');
const { maskAccountNumber } = require('../utils/mask');
const { getMissingFields } = require('../utils/validation');

// Every connected action is executed by the backend orchestrator through a
// connector that calls a separate internal service. In production those internal
// demo services are replaced by the real ATB internal APIs.
const getExecutionMode = (action) => {
  if (!action || action.status !== 'connected') {
    if (env.mvpLocalActionSimulation && action?.name === 'request_card') {
      return 'local_mvp_simulation';
    }
    return 'none';
  }

  return 'internal_demo_service';
};

const formatFieldLabel = (field) => {
  const labels = {
    billReference: 'Bill reference',
    sourceAccountId: 'Source account',
  };

  if (labels[field]) {
    return labels[field];
  }

  return field
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (character) => character.toUpperCase());
};

const normalizePayloadForAction = (actionName, payload = {}) => {
  if (actionName === 'pay_bill' && !payload.sourceAccountId && payload.accountId) {
    return {
      ...payload,
      sourceAccountId: payload.accountId,
    };
  }

  return payload;
};

const getPreparationMissingFields = (action, payload) => {
  const missingFields = getMissingFields(action.requiredFields, payload);

  if (action.name === 'create_complaint') {
    if (missingFields.includes('category')) return ['category'];
    if (missingFields.includes('description')) return ['description'];
    return [];
  }

  return missingFields;
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

const formatAmount = (amountValue, currency = 'TND') => {
  const amount = Number(amountValue);
  const formattedAmount = Number.isFinite(amount)
    ? amount.toFixed(3)
    : amountValue;

  return `${formattedAmount} ${currency || 'TND'}`;
};

const buildSummary = (action, payload, user) => {
  if (action.name === 'pay_bill') {
    const summary = [];

    if (payload.provider) {
      summary.push(`Provider: ${payload.provider}`);
    }

    if (payload.billReference) {
      summary.push(`Bill reference: ${payload.billReference}`);
    }

    if (payload.amount !== undefined && payload.amount !== null) {
      summary.push(`Amount: ${formatAmount(payload.amount, payload.currency)}`);
    }

    if (payload.dueDate) {
      summary.push(`Due date: ${payload.dueDate}`);
    }

    if (payload.status) {
      summary.push(`Status: ${payload.status}`);
    }

    if (payload.sourceAccountId) {
      summary.push(`Account: ${getMaskedAccountLabel(payload.sourceAccountId, user)}`);
    }

    return summary;
  }

  const summary = [];

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

  const normalizedPayload = normalizePayloadForAction(action.name, payload);
  const missingFields = getPreparationMissingFields(action, normalizedPayload);

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

  if (action.status === 'not_connected' && !(env.mvpLocalActionSimulation && action.name === 'request_card')) {
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
        internalServiceRouted: executionMode === 'internal_demo_service',
        payload: normalizedPayload,
        summary: buildSummary(action, normalizedPayload, user),
      },
    },
  };
};

module.exports = {
  buildSummary,
  getExecutionMode,
  prepareAction,
};
