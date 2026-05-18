const { getActionByName } = require('../actions/actionRegistry');
const mockAccounts = require('../data/mockAccounts');
const {
  availableSlots,
  bookedAppointments,
} = require('../data/mockAppointments');
const mockComplaints = require('../data/mockComplaints');
const mockDocuments = require('../data/mockDocuments');
const mockTransactions = require('../data/mockTransactions');
const { createAuditLog } = require('./auditLog.service');
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

const createExecutionLog = ({ user, action, actionName, payload, status, result, failureReason }) => {
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
  });
};

const executeAction = ({ actionName, payload = {}, user }) => {
  if (!actionName) {
    createExecutionLog({
      user,
      actionName,
      payload,
      status: 'missing_fields',
      failureReason: 'actionName is required',
    });

    return {
      httpStatus: 400,
      body: {
        success: false,
        status: 'missing_fields',
        missingFields: ['actionName'],
      },
    };
  }

  const action = getActionByName(actionName);

  if (!action) {
    createExecutionLog({
      user,
      actionName,
      payload,
      status: 'not_found',
      failureReason: 'Action not found',
    });

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
    createExecutionLog({
      user,
      action,
      actionName,
      payload,
      status: 'forbidden',
      failureReason: 'Action is not allowed for this user role',
    });

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
    createExecutionLog({
      user,
      action,
      actionName,
      payload,
      status: 'missing_fields',
      failureReason: `Missing fields: ${missingFields.join(', ')}`,
    });

    return {
      httpStatus: 400,
      body: {
        success: false,
        status: 'missing_fields',
        missingFields,
      },
    };
  }

  if (action.riskLevel === 'high') {
    createExecutionLog({
      user,
      action,
      actionName,
      payload,
      status: 'high_risk_blocked',
      failureReason: 'High-risk action flow is not implemented',
    });

    return {
      httpStatus: 400,
      body: {
        success: false,
        status: 'high_risk_blocked',
        message:
          'This action requires confirmation and SMS verification and will be implemented in the high-risk action flow.',
      },
    };
  }

  if (action.status === 'not_connected') {
    createExecutionLog({
      user,
      action,
      actionName,
      payload,
      status: 'not_connected',
      failureReason: 'Action is not connected in the current MVP',
    });

    return {
      httpStatus: 400,
      body: {
        success: false,
        status: 'not_connected',
        message: 'This action is understood but not connected in the current MVP.',
      },
    };
  }

  const executionResult = executeConnectedAction({ actionName, payload, user });

  if (!executionResult.success) {
    createExecutionLog({
      user,
      action,
      actionName,
      payload,
      status: executionResult.status,
      failureReason: executionResult.message,
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

module.exports = {
  executeAction,
};
