const { getActionByName } = require('../actions/actionRegistry');
const mockAccounts = require('../data/mockAccounts');
const {
  availableSlots,
  bookedAppointments,
} = require('../data/mockAppointments');
const mockComplaints = require('../data/mockComplaints');
const mockDocuments = require('../data/mockDocuments');
const mockTransactions = require('../data/mockTransactions');
const { buildSummary } = require('./actionPreparation.service');
const { createAuditLog } = require('./auditLog.service');
const {
  createPendingConfirmation,
  getPendingConfirmationById,
  isConfirmationExpired,
  markConfirmationAsCancelled,
  markConfirmationAsConfirmed,
} = require('./confirmation.service');
const { maskAccountNumber } = require('../utils/mask');
const { getMissingFields } = require('../utils/validation');

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

const getClientAccount = (user, accountId) => {
  return mockAccounts.find(
    (account) => account.id === accountId && account.userId === user.id,
  );
};

const createComplaintReference = () => {
  const year = new Date().getFullYear();
  const sequence = String(mockComplaints.length + 1).padStart(3, '0');

  return `CMP-${year}-${sequence}`;
};

const canViewComplaint = (user, complaint) => {
  return (
    user.role === 'SUPPORT_AGENT' ||
    user.role === 'ADMIN' ||
    complaint.userId === user.id
  );
};

const executeConnectedAction = ({ actionName, payload, user }) => {
  switch (actionName) {
    case 'check_balance': {
      const account = getClientAccount(user, payload.accountId);

      if (!account) {
        return {
          success: false,
          status: 'not_found',
          message: 'Account not found for authenticated user',
        };
      }

      return {
        success: true,
        data: {
          account: toSafeAccount(account),
        },
      };
    }

    case 'view_transactions': {
      const account = getClientAccount(user, payload.accountId);

      if (!account) {
        return {
          success: false,
          status: 'not_found',
          message: 'Account not found for authenticated user',
        };
      }

      return {
        success: true,
        data: {
          account: {
            id: account.id,
            accountNumber: maskAccountNumber(account.accountNumber),
            type: account.type,
            currency: account.currency,
          },
          transactions: mockTransactions.filter(
            (transaction) => transaction.accountId === account.id,
          ),
        },
      };
    }

    case 'list_documents':
      return {
        success: true,
        data: {
          documents: mockDocuments.filter(
            (document) => document.userId === user.id,
          ),
        },
      };

    case 'generate_document': {
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
    }

    case 'create_complaint': {
      const complaint = {
        reference: createComplaintReference(),
        userId: user.id,
        customerName: user.fullName,
        category: payload.category,
        description: payload.description,
        status: 'open',
        createdAt: new Date().toISOString(),
      };

      mockComplaints.push(complaint);

      return {
        success: true,
        data: {
          complaint,
        },
      };
    }

    case 'book_appointment': {
      const appointmentId = `APT-${new Date().getFullYear()}-${String(
        bookedAppointments.length + 1,
      ).padStart(3, '0')}`;

      const appointment = {
        appointmentId,
        userId: user.id,
        customerName: user.fullName,
        branch: payload.branch,
        date: payload.date,
        time: payload.time,
        status: 'confirmed',
        createdAt: new Date().toISOString(),
      };

      bookedAppointments.push(appointment);

      return {
        success: true,
        data: {
          appointment,
        },
      };
    }

    case 'list_appointment_slots':
      return {
        success: true,
        data: {
          slots: availableSlots,
        },
      };

    case 'check_complaint_status': {
      const complaint = mockComplaints.find(
        (mockComplaint) => mockComplaint.reference === payload.reference,
      );

      if (!complaint || !canViewComplaint(user, complaint)) {
        return {
          success: false,
          status: 'not_found',
          message: 'Complaint not found',
        };
      }

      return {
        success: true,
        data: {
          complaint,
        },
      };
    }

    default:
      return {
        success: false,
        status: 'not_supported',
        message: 'Action execution is not supported for this action',
      };
  }
};

const createExecutionLog = ({
  user,
  action,
  actionName,
  payload,
  status,
  result,
  failureReason,
  confirmationId,
  confirmationStatus,
}) => {
  return createAuditLog({
    userId: user.id,
    role: user.role,
    actionName,
    riskLevel: action?.riskLevel,
    status,
    payload,
    apiEndpoint: action?.apiEndpoint,
    result,
    failureReason,
    confirmationId,
    confirmationStatus,
  });
};

const validateActionRequest = ({ actionName, payload, user }) => {
  if (!actionName) {
    return {
      httpStatus: 400,
      body: {
        success: false,
        status: 'missing_fields',
        missingFields: ['actionName'],
      },
      log: {
        status: 'missing_fields',
        failureReason: 'actionName is required',
      },
    };
  }

  const action = getActionByName(actionName);

  if (!action) {
    return {
      httpStatus: 404,
      body: {
        success: false,
        status: 'not_found',
        message: 'Action not found',
      },
      log: {
        status: 'not_found',
        failureReason: 'Action not found',
      },
    };
  }

  if (!action.allowedRoles.includes(user.role)) {
    return {
      action,
      httpStatus: 403,
      body: {
        success: false,
        status: 'forbidden',
        message: 'Action is not allowed for this user role',
      },
      log: {
        status: 'forbidden',
        failureReason: 'Action is not allowed for this user role',
      },
    };
  }

  const missingFields = getMissingFields(action.requiredFields, payload);

  if (missingFields.length > 0) {
    return {
      action,
      httpStatus: 400,
      body: {
        success: false,
        status: 'missing_fields',
        missingFields,
      },
      log: {
        status: 'missing_fields',
        failureReason: `Missing fields: ${missingFields.join(', ')}`,
      },
    };
  }

  if (action.riskLevel === 'high') {
    return {
      action,
      httpStatus: 400,
      body: {
        success: false,
        status: 'high_risk_blocked',
        message:
          'This action requires confirmation and SMS verification and will be implemented in the high-risk action flow.',
      },
      log: {
        status: 'high_risk_blocked',
        failureReason: 'High-risk action flow is not implemented',
      },
    };
  }

  if (action.status === 'not_connected') {
    return {
      action,
      httpStatus: 400,
      body: {
        success: false,
        status: 'not_connected',
        message: 'This action is understood but not connected in the current MVP.',
      },
      log: {
        status: 'not_connected',
        failureReason: 'Action is not connected in the current MVP',
      },
    };
  }

  return {
    action,
  };
};

const executeValidatedAction = ({
  action,
  actionName,
  payload,
  user,
  confirmationId,
  confirmationStatus,
}) => {
  const executionResult = executeConnectedAction({ actionName, payload, user });

  if (!executionResult.success) {
    createExecutionLog({
      user,
      action,
      actionName,
      payload,
      status: executionResult.status,
      failureReason: executionResult.message,
      confirmationId,
      confirmationStatus,
    });

    return {
      httpStatus: executionResult.status === 'not_found' ? 404 : 400,
      body: {
        success: false,
        status: executionResult.status,
        message: executionResult.message,
      },
    };
  }

  createExecutionLog({
    user,
    action,
    actionName,
    payload,
    status: 'completed',
    result: executionResult.data,
    confirmationId,
    confirmationStatus,
  });

  return {
    httpStatus: 200,
    body: {
      success: true,
      status: 'completed',
      message: 'Action executed successfully',
      data: executionResult.data,
    },
  };
};

const executeAction = ({ actionName, payload = {}, user }) => {
  const validation = validateActionRequest({ actionName, payload, user });

  if (validation.body) {
    createExecutionLog({
      user,
      action: validation.action,
      actionName,
      payload,
      status: validation.log.status,
      failureReason: validation.log.failureReason,
    });

    return {
      httpStatus: validation.httpStatus,
      body: validation.body,
    };
  }

  const { action } = validation;

  if (action.riskLevel === 'medium') {
    const summary = buildSummary(action, payload, user);
    const confirmation = createPendingConfirmation({
      userId: user.id,
      actionName,
      riskLevel: action.riskLevel,
      payload,
      summary,
      expiresInMinutes: 10,
    });

    createExecutionLog({
      user,
      action,
      actionName,
      payload,
      status: 'confirmation_required',
      result: {
        confirmationId: confirmation.id,
        expiresAt: confirmation.expiresAt,
      },
      confirmationId: confirmation.id,
    });

    return {
      httpStatus: 200,
      body: {
        success: true,
        status: 'confirmation_required',
        message: 'Please confirm this action before execution.',
        data: {
          confirmationId: confirmation.id,
          actionName,
          riskLevel: action.riskLevel,
          summary,
          expiresAt: confirmation.expiresAt,
        },
      },
    };
  }

  return executeValidatedAction({
    action,
    actionName,
    payload,
    user,
  });
};

const confirmAction = ({ confirmationId, user }) => {
  if (!confirmationId) {
    createExecutionLog({
      user,
      status: 'missing_fields',
      failureReason: 'confirmationId is required',
    });

    return {
      httpStatus: 400,
      body: {
        success: false,
        status: 'missing_fields',
        missingFields: ['confirmationId'],
      },
    };
  }

  const confirmation = getPendingConfirmationById(confirmationId);

  if (!confirmation || confirmation.userId !== user.id) {
    createExecutionLog({
      user,
      status: 'not_found',
      failureReason: 'Confirmation not found',
      confirmationId,
    });

    return {
      httpStatus: 404,
      body: {
        success: false,
        status: 'not_found',
        message: 'Confirmation not found',
      },
    };
  }

  const action = getActionByName(confirmation.actionName);

  if (isConfirmationExpired(confirmation)) {
    createExecutionLog({
      user,
      action,
      actionName: confirmation.actionName,
      payload: confirmation.payload,
      status: 'confirmation_expired',
      failureReason: 'Confirmation expired',
      confirmationId,
    });

    return {
      httpStatus: 400,
      body: {
        success: false,
        status: 'confirmation_expired',
        message: 'This confirmation has expired. Please start the action again.',
      },
    };
  }

  if (confirmation.status !== 'pending') {
    createExecutionLog({
      user,
      action,
      actionName: confirmation.actionName,
      payload: confirmation.payload,
      status: confirmation.status,
      failureReason: `Confirmation is already ${confirmation.status}`,
      confirmationId,
    });

    return {
      httpStatus: 400,
      body: {
        success: false,
        status: `confirmation_${confirmation.status}`,
        message: `This confirmation is already ${confirmation.status}.`,
      },
    };
  }

  markConfirmationAsConfirmed(confirmationId);

  const validation = validateActionRequest({
    actionName: confirmation.actionName,
    payload: confirmation.payload,
    user,
  });

  if (validation.body) {
    createExecutionLog({
      user,
      action: validation.action,
      actionName: confirmation.actionName,
      payload: confirmation.payload,
      status: validation.log.status,
      failureReason: validation.log.failureReason,
      confirmationId,
      confirmationStatus: 'confirmed',
    });

    return {
      httpStatus: validation.httpStatus,
      body: validation.body,
    };
  }

  return executeValidatedAction({
    action: validation.action,
    actionName: confirmation.actionName,
    payload: confirmation.payload,
    user,
    confirmationId,
    confirmationStatus: 'confirmed',
  });
};

const cancelAction = ({ confirmationId, user }) => {
  if (!confirmationId) {
    createExecutionLog({
      user,
      status: 'missing_fields',
      failureReason: 'confirmationId is required',
    });

    return {
      httpStatus: 400,
      body: {
        success: false,
        status: 'missing_fields',
        missingFields: ['confirmationId'],
      },
    };
  }

  const confirmation = getPendingConfirmationById(confirmationId);

  if (!confirmation || confirmation.userId !== user.id) {
    createExecutionLog({
      user,
      status: 'not_found',
      failureReason: 'Confirmation not found',
      confirmationId,
    });

    return {
      httpStatus: 404,
      body: {
        success: false,
        status: 'not_found',
        message: 'Confirmation not found',
      },
    };
  }

  const action = getActionByName(confirmation.actionName);

  if (isConfirmationExpired(confirmation)) {
    createExecutionLog({
      user,
      action,
      actionName: confirmation.actionName,
      payload: confirmation.payload,
      status: 'confirmation_expired',
      failureReason: 'Confirmation expired',
      confirmationId,
    });

    return {
      httpStatus: 400,
      body: {
        success: false,
        status: 'confirmation_expired',
        message: 'This confirmation has expired. Please start the action again.',
      },
    };
  }

  if (confirmation.status !== 'pending') {
    createExecutionLog({
      user,
      action,
      actionName: confirmation.actionName,
      payload: confirmation.payload,
      status: confirmation.status,
      failureReason: `Confirmation is already ${confirmation.status}`,
      confirmationId,
    });

    return {
      httpStatus: 400,
      body: {
        success: false,
        status: `confirmation_${confirmation.status}`,
        message: `This confirmation is already ${confirmation.status}.`,
      },
    };
  }

  markConfirmationAsCancelled(confirmationId);

  createExecutionLog({
    user,
    action,
    actionName: confirmation.actionName,
    payload: confirmation.payload,
    status: 'cancelled',
    result: {
      confirmationId,
    },
    confirmationId,
  });

  return {
    httpStatus: 200,
    body: {
      success: true,
      status: 'cancelled',
      message: 'Action confirmation cancelled successfully',
      data: {
        confirmationId,
      },
    },
  };
};

module.exports = {
  cancelAction,
  confirmAction,
  executeAction,
};
