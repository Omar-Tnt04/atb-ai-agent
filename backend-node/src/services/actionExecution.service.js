const { getActionByName } = require('../actions/actionRegistry');
const {
  executeConnectorOperation,
} = require('../connectors/connectorRegistry');
const env = require('../config/env');
const mockAccounts = require('../data/mockAccounts');
const mockBeneficiaries = require('../data/mockBeneficiaries');
const mockBills = require('../data/mockBills');
const {
  availableSlots,
  bookedAppointments,
} = require('../data/mockAppointments');
const mockComplaints = require('../data/mockComplaints');
const mockDocuments = require('../data/mockDocuments');
const mockTransactions = require('../data/mockTransactions');
const { buildSummary, getExecutionMode } = require('./actionPreparation.service');
const { createAuditLog } = require('./auditLog.service');
const {
  createPendingConfirmation,
  getPendingConfirmationById,
  isConfirmationExpired,
  markConfirmationAsCancelled,
  markConfirmationAsConfirmed,
} = require('./confirmation.service');
const {
  createSmsCode,
  verifySmsCode,
} = require('./smsVerification.service');
const { maskAccountNumber, maskPhoneNumber, maskRib } = require('../utils/mask');
const { getMissingFields } = require('../utils/validation');

const BILL_PAYMENT_FEES = 0;
const TRANSFER_FEES = 1;
const paymentReferences = [];
const transferReferences = [];
const cardReferences = [];
const complaintSimulationReferences = [];
const appointmentSimulationReferences = [];

const hasValue = (value) =>
  value !== undefined &&
  value !== null &&
  !(typeof value === 'string' && value.trim() === '');

const publicActionPayload = (payload = {}) =>
  Object.fromEntries(
    Object.entries(payload || {}).filter(
      ([key]) => !String(key).startsWith('_'),
    ),
  );

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

const createPaymentReference = () => {
  const year = new Date().getFullYear();
  const sequence = String(paymentReferences.length + 1).padStart(6, '0');
  const reference = `PAY-${year}-${sequence}`;

  paymentReferences.push(reference);

  return reference;
};

const createTransferReference = () => {
  const year = new Date().getFullYear();
  const sequence = String(transferReferences.length + 1).padStart(6, '0');
  const reference = `TRF-${year}-${sequence}`;

  transferReferences.push(reference);

  return reference;
};

const createSimulationReference = (prefix, store) => {
  const year = new Date().getFullYear();
  const sequence = String(store.length + 1).padStart(6, '0');
  const reference = `${prefix}-${year}-${sequence}`;

  store.push(reference);

  return reference;
};

// 2b — display-only DEMO reference + simulated-success wording.
// The INTERNAL references (paymentReference / transferReference / ...) are never changed; they stay
// in `data` for logs and existing tests. We only ADD `data.demoReference` and `body.assistantMessage`
// for the user-facing simulated-success message. Read-only actions (balance, etc.) are unaffected.
const SIMULATED_WRITE_ACTIONS = new Set([
  'pay_bill',
  'make_transfer',
  'create_complaint',
  'book_appointment',
  'generate_document',
]);

const internalReferenceFromResult = (data = {}) =>
  data.paymentReference ||
  data.transferReference ||
  data.cardReference ||
  data.reference ||
  data.complaint?.reference ||
  data.appointment?.appointmentId ||
  data.document?.documentId ||
  null;

const toDemoReference = (internalReference) => {
  const ref = String(internalReference || '').trim();
  return ref ? `DEMO-${ref}` : null;
};

const buildSimulatedActionMessage = ({ actionName, data = {}, demoReference }) => {
  const actionLabel = {
    pay_bill: 'payment',
    make_transfer: 'transfer',
    request_card: 'card request',
    create_complaint: 'complaint',
    book_appointment: 'appointment',
    generate_document: 'document request',
  }[actionName] || 'action';
  const realWord =
    actionName === 'make_transfer' ? 'transfer'
      : actionName === 'pay_bill' ? 'payment'
      : 'action';

  return [
    `Done — I simulated the ${actionLabel}.`,
    `This is an MVP demo, so no real ${realWord} was made.`,
    demoReference ? `Demo reference: ${demoReference}.` : null,
  ]
    .filter(Boolean)
    .join(' ');

  const value = (input) =>
    input === undefined || input === null || String(input).trim() === '' ? null : String(input).trim();
  const amount = value(data.amount);
  const currency = value(data.currency) || 'TND';
  const provider = value(data.provider);
  const beneficiary = value(data.beneficiaryName);
  const money = amount ? ` of **${amount} ${currency}**` : '';

  const lead = {
    pay_bill: `Done — I simulated the **${provider || 'bill'}** payment${money}.`,
    make_transfer: `Done — I simulated the transfer${money}${beneficiary ? ` to **${beneficiary}**` : ''}.`,
    create_complaint: 'Done — I simulated submitting your complaint.',
    book_appointment: 'Done — I simulated booking your appointment.',
    generate_document: 'Done — I simulated generating your document.',
  }[actionName] || 'Done — I simulated this action.';

  const legacyRealWord =
    actionName === 'make_transfer' ? 'transfer'
      : actionName === 'pay_bill' ? 'payment'
      : 'banking operation';

  return [
    lead,
    `This is an MVP demo, so **no real ${legacyRealWord} was made**.`,
    demoReference ? `Demo reference: **${demoReference}**.` : null,
  ]
    .filter(Boolean)
    .join(' ');
};

const getBillPaymentContext = ({ user, payload }) => {
  const bill = mockBills.find(
    (mockBill) =>
      mockBill.billReference === payload.billReference &&
      mockBill.userId === user.id,
  );

  if (!bill) {
    return {
      success: false,
      status: 'not_found',
      message: 'Bill not found',
    };
  }

  if (bill.status === 'paid') {
    return {
      success: false,
      status: 'already_paid',
      message: 'Bill is already paid',
    };
  }

  const sourceAccount = getClientAccount(user, payload.sourceAccountId);

  if (!sourceAccount) {
    return {
      success: false,
      status: 'not_found',
      message: 'Source account not found',
    };
  }

  return {
    success: true,
    bill,
    sourceAccount,
  };
};

const buildPreparedBillPaymentPayload = ({ user, payload = {} }) => {
  const normalizedPayload = {
    ...payload,
    sourceAccountId: payload.sourceAccountId || payload.accountId,
  };
  const bill = mockBills.find(
    (mockBill) =>
      mockBill.billReference === normalizedPayload.billReference &&
      mockBill.userId === user.id,
  );
  const billIndex = bill ? mockBills.indexOf(bill) : -1;
  const amount = hasValue(normalizedPayload.amount)
    ? Number(normalizedPayload.amount)
    : Number(bill?.amount);
  const preparedBill = {
    provider: normalizedPayload.provider || bill?.provider,
    billReference: normalizedPayload.billReference || bill?.billReference,
    amount,
    currency: normalizedPayload.currency || bill?.currency || 'TND',
    status: bill?.status || 'unpaid',
  };

  return {
    ...normalizedPayload,
    provider: preparedBill.provider,
    billReference: preparedBill.billReference,
    amount: preparedBill.amount,
    currency: preparedBill.currency,
    _preparedBill: preparedBill,
    ...(billIndex >= 0 ? { _mockBillIndex: billIndex } : {}),
  };
};

const buildPreparedConfirmationPayload = ({ actionName, payload = {}, user }) => {
  if (actionName === 'pay_bill') {
    return buildPreparedBillPaymentPayload({ user, payload });
  }

  return payload;
};

const getTransferContext = ({ user, payload }) => {
  const amount = Number(payload.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      success: false,
      status: 'invalid_amount',
      message: 'Transfer amount must be a positive number',
    };
  }

  const sourceAccount = getClientAccount(user, payload.sourceAccountId);

  if (!sourceAccount) {
    return {
      success: false,
      status: 'not_found',
      message: 'Source account not found',
    };
  }

  const beneficiary = mockBeneficiaries.find(
    (mockBeneficiary) =>
      mockBeneficiary.beneficiaryId === payload.beneficiaryId &&
      mockBeneficiary.userId === user.id,
  );

  if (!beneficiary) {
    return {
      success: false,
      status: 'not_found',
      message: 'Beneficiary not found',
    };
  }

  return {
    success: true,
    amount,
    beneficiary,
    sourceAccount,
  };
};

const getPreparedBillPaymentData = (payload = {}) => ({
  provider: payload._preparedBill?.provider || payload.provider,
  billReference: payload._preparedBill?.billReference || payload.billReference,
  amount: payload._preparedBill?.amount ?? payload.amount,
  currency: payload._preparedBill?.currency || payload.currency || 'TND',
  status: payload._preparedBill?.status || payload.status || 'unpaid',
});

const MVP_LOCAL_SIMULATION_ACTIONS = new Set([
  'pay_bill',
  'make_transfer',
  'request_card',
  'create_complaint',
  'book_appointment',
]);

const canUseMvpLocalSimulation = (actionName) =>
  env.mvpLocalActionSimulation && MVP_LOCAL_SIMULATION_ACTIONS.has(actionName);

const buildLocalSimulationResult = ({ actionName, payload = {}, user }) => {
  switch (actionName) {
    case 'pay_bill': {
      const preparedBill = getPreparedBillPaymentData(payload);

      if (preparedBill.status === 'paid') {
        return {
          success: false,
          status: 'already_paid',
          message: 'Bill is already paid',
        };
      }

      const sourceAccount = getClientAccount(user, payload.sourceAccountId);

      if (!sourceAccount) {
        return {
          success: false,
          status: 'not_found',
          message: 'Source account not found',
        };
      }

      if (
        !hasValue(preparedBill.provider) ||
        !hasValue(preparedBill.billReference) ||
        !hasValue(preparedBill.amount)
      ) {
        return {
          success: false,
          status: 'missing_fields',
          message: 'Prepared bill payment details are incomplete',
        };
      }

      const amount = Number(preparedBill.amount);

      if (!Number.isFinite(amount) || amount <= 0) {
        return {
          success: false,
          status: 'invalid_amount',
          message: 'Bill amount must be a positive number',
        };
      }

      const totalAmount = Number((amount + BILL_PAYMENT_FEES).toFixed(3));

      if (sourceAccount.balance < totalAmount) {
        return {
          success: false,
          status: 'insufficient_balance',
          message: 'Insufficient account balance',
        };
      }

      return {
        success: true,
        source: 'local_mvp_simulation',
        serviceName: 'local_mvp_simulation',
        data: {
          paymentReference: createPaymentReference(),
          provider: preparedBill.provider,
          billReference: preparedBill.billReference,
          amount,
          currency: preparedBill.currency,
          sourceAccount: maskAccountNumber(sourceAccount.accountNumber),
          status: 'simulated',
          localSimulation: true,
        },
      };
    }

    case 'make_transfer': {
      const context = getTransferContext({ user, payload });

      if (!context.success) return context;

      const totalAmount = Number((context.amount + TRANSFER_FEES).toFixed(3));

      if (context.sourceAccount.balance < totalAmount) {
        return {
          success: false,
          status: 'insufficient_balance',
          message: 'Insufficient account balance',
        };
      }

      return {
        success: true,
        source: 'local_mvp_simulation',
        serviceName: 'local_mvp_simulation',
        data: {
          transferReference: createTransferReference(),
          amount: context.amount,
          currency: context.sourceAccount.currency,
          sourceAccount: maskAccountNumber(context.sourceAccount.accountNumber),
          beneficiaryId: context.beneficiary.beneficiaryId,
          beneficiaryName: context.beneficiary.name,
          beneficiaryRib: maskRib(context.beneficiary.rib),
          status: 'simulated',
          localSimulation: true,
        },
      };
    }

    case 'request_card': {
      const account = getClientAccount(user, payload.accountId);

      if (!account) {
        return {
          success: false,
          status: 'not_found',
          message: 'Source account not found',
        };
      }

      return {
        success: true,
        source: 'local_mvp_simulation',
        serviceName: 'local_mvp_simulation',
        data: {
          cardReference: createSimulationReference('CARD', cardReferences),
          cardType: payload.cardType,
          sourceAccount: maskAccountNumber(account.accountNumber),
          status: 'simulated',
          localSimulation: true,
        },
      };
    }

    case 'create_complaint':
      return {
        success: true,
        source: 'local_mvp_simulation',
        serviceName: 'local_mvp_simulation',
        data: {
          complaint: {
            reference: createSimulationReference('CMP', complaintSimulationReferences),
            customerName: user.fullName,
            category: payload.category,
            description: payload.description,
            status: 'simulated',
          },
          localSimulation: true,
        },
      };

    case 'book_appointment':
      return {
        success: true,
        source: 'local_mvp_simulation',
        serviceName: 'local_mvp_simulation',
        data: {
          appointment: {
            appointmentId: createSimulationReference('APT', appointmentSimulationReferences),
            customerName: user.fullName,
            branch: payload.branch,
            date: payload.date,
            time: payload.time,
            status: 'simulated',
          },
          localSimulation: true,
        },
      };

    default:
      return {
        success: false,
        status: 'not_supported',
        message: 'Local MVP simulation is not supported for this action',
      };
  }
};

const executeMvpLocalSimulation = ({
  action,
  actionName,
  payload,
  user,
  confirmationId,
  confirmationStatus,
}) => {
  const simulationResult = buildLocalSimulationResult({ actionName, payload, user });

  if (!simulationResult.success) {
    createExecutionLog({
      user,
      action,
      actionName,
      payload,
      status: simulationResult.status,
      failureReason: simulationResult.message,
      confirmationId,
      confirmationStatus,
      connectorSource: 'local_mvp_simulation',
      serviceName: 'local_mvp_simulation',
    });

    return {
      httpStatus: simulationResult.status === 'not_found' ? 404 : 400,
      body: {
        success: false,
        status: simulationResult.status,
        message: simulationResult.message,
      },
    };
  }

  const resultData = simulationResult.data || {};
  const internalReference = internalReferenceFromResult(resultData);
  const demoReference = toDemoReference(internalReference);

  console.info('[DEMO_ACTION] localSimulation=true', {
    actionType: actionName,
    internalReference,
    displayReference: demoReference,
  });

  createExecutionLog({
    user,
    action,
    actionName,
    payload,
    status: 'completed',
    result: {
      ...resultData,
      demoReference,
    },
    confirmationId,
    confirmationStatus,
    connectorSource: 'local_mvp_simulation',
    serviceName: 'local_mvp_simulation',
  });

  return {
    httpStatus: 200,
    body: {
      success: true,
      status: 'completed',
      message: 'Action executed successfully',
      executionMode: 'local_mvp_simulation',
      assistantMessage: buildSimulatedActionMessage({
        actionName,
        data: resultData,
        demoReference,
      }),
      data: {
        ...resultData,
        executionMode: 'local_mvp_simulation',
        demoReference,
      },
    },
  };
};

const canViewComplaint = (user, complaint) => {
  return (
    user.role === 'SUPPORT_AGENT' ||
    user.role === 'ADMIN' ||
    complaint.userId === user.id
  );
};

const executeConnectedAction = async ({ action, actionName, payload, user }) => {
  if (action?.connector && action?.operation) {
    return executeConnectorOperation({
      connectorName: action.connector,
      operationName: action.operation,
      user,
      payload,
    });
  }

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

    case 'pay_bill': {
      const context = getBillPaymentContext({ user, payload });

      if (!context.success) {
        return context;
      }

      const totalAmount = Number(
        (context.bill.amount + BILL_PAYMENT_FEES).toFixed(3),
      );

      if (context.sourceAccount.balance < totalAmount) {
        return {
          success: false,
          status: 'insufficient_balance',
          message: 'Insufficient account balance',
        };
      }

      context.sourceAccount.balance = Number(
        (context.sourceAccount.balance - totalAmount).toFixed(3),
      );
      context.bill.status = 'paid';
      context.bill.paidAt = new Date().toISOString();

      return {
        success: true,
        data: {
          paymentReference: createPaymentReference(),
          provider: context.bill.provider,
          amount: context.bill.amount,
          currency: context.bill.currency,
          sourceAccount: maskAccountNumber(context.sourceAccount.accountNumber),
          status: context.bill.status,
          paidAt: context.bill.paidAt,
        },
      };
    }

    case 'make_transfer': {
      const context = getTransferContext({ user, payload });

      if (!context.success) {
        return context;
      }

      const totalAmount = Number((context.amount + TRANSFER_FEES).toFixed(3));

      if (context.sourceAccount.balance < totalAmount) {
        return {
          success: false,
          status: 'insufficient_balance',
          message: 'Insufficient account balance',
        };
      }

      context.sourceAccount.balance = Number(
        (context.sourceAccount.balance - totalAmount).toFixed(3),
      );

      return {
        success: true,
        data: {
          transferReference: createTransferReference(),
          amount: context.amount,
          currency: context.sourceAccount.currency,
          sourceAccount: maskAccountNumber(context.sourceAccount.accountNumber),
          beneficiaryName: context.beneficiary.name,
          beneficiaryRib: maskRib(context.beneficiary.rib),
          status: 'completed',
          executedAt: new Date().toISOString(),
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
  smsVerificationStatus,
  connectorSource,
  serviceName,
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
    smsVerificationStatus,
    connectorName: action?.connector,
    operationName: action?.operation,
    connectorSource,
    serviceName,
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

  if (action.status === 'not_connected' && !canUseMvpLocalSimulation(action.name)) {
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

  if (action.riskLevel === 'high' && !action.requiresSmsVerification) {
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

  return {
    action,
  };
};

const executeValidatedAction = async ({
  action,
  actionName,
  payload,
  user,
  confirmationId,
  confirmationStatus,
  smsVerificationStatus,
  failureAuditStatus,
}) => {
  const executionResult = await executeConnectedAction({
    action,
    actionName,
    payload,
    user,
  });

  if (!executionResult.success) {
    const isServiceUnavailable =
      executionResult.status === 'service_unavailable' ||
      executionResult.status === 'service_error';

    createExecutionLog({
      user,
      action,
      actionName,
      payload,
      status: isServiceUnavailable
        ? 'service_unavailable'
        : failureAuditStatus || executionResult.status,
      failureReason: executionResult.message,
      confirmationId,
      confirmationStatus,
      smsVerificationStatus,
      connectorSource: executionResult.source || getExecutionMode(action),
      serviceName: executionResult.serviceName,
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

  const executionMode = executionResult.source || getExecutionMode(action);

  createExecutionLog({
    user,
    action,
    actionName,
    payload,
    status: 'completed',
    result: executionResult.data,
    confirmationId,
    confirmationStatus,
    smsVerificationStatus,
    connectorSource: executionMode,
    serviceName: executionResult.serviceName,
  });

  const resultData = executionResult.data || {};
  const isSimulatedWrite = SIMULATED_WRITE_ACTIONS.has(actionName);
  const demoReference = isSimulatedWrite
    ? resultData.demoReference || toDemoReference(internalReferenceFromResult(resultData))
    : null;

  const body = {
    success: true,
    status: 'completed',
    message: 'Action executed successfully',
    executionMode,
    data: {
      ...resultData,
      executionMode,
      ...(demoReference ? { demoReference } : {}),
    },
  };
  if (isSimulatedWrite) {
    // User-facing simulated-success message (the internal reference above is left unchanged).
    body.assistantMessage = buildSimulatedActionMessage({
      actionName,
      data: resultData,
      demoReference,
    });
    if (['1', 'true', 'yes', 'on'].includes(String(process.env.DEBUG_AGENT_ROUTING).toLowerCase())) {
      console.log(
        `[DEMO_ACTION] simulated action=${actionName}` +
        ` internalRef=${internalReferenceFromResult(resultData) || 'none'}` +
        ` demoRef=${demoReference || 'none'} realExecution=false`,
      );
    }
  }

  return {
    httpStatus: 200,
    body,
  };
};

const executeAction = async ({ actionName, payload = {}, user }) => {
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

  if (action.riskLevel === 'medium' || action.riskLevel === 'high') {
    if (action.riskLevel === 'high' && !user.phoneNumber) {
      createExecutionLog({
        user,
        action,
        actionName,
        payload,
        status: 'phone_required',
        failureReason: 'User has no registered phone number',
      });

      return {
        httpStatus: 400,
        body: {
          success: false,
          status: 'phone_required',
          message:
            'This action requires a registered phone number for SMS verification.',
        },
      };
    }

    const preparedPayload = buildPreparedConfirmationPayload({
      actionName,
      payload,
      user,
    });
    const summary = buildSummary(action, preparedPayload, user);
    const confirmation = createPendingConfirmation({
      userId: user.id,
      actionName,
      riskLevel: action.riskLevel,
      payload: preparedPayload,
      summary,
      expiresInMinutes: 10,
    });

    console.info('[action-security] confirmation_created', {
      confirmationId: confirmation.id,
      actionName,
      riskLevel: action.riskLevel,
      hasPreparedPayload: Boolean(preparedPayload),
      billReference: publicActionPayload(preparedPayload).billReference || undefined,
    });

    createExecutionLog({
      user,
      action,
      actionName,
      payload: preparedPayload,
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
        message:
          action.riskLevel === 'high'
            ? 'This high-risk action requires confirmation and SMS verification.'
            : 'Please confirm this action before execution.',
        data: {
          confirmationId: confirmation.id,
          actionName,
          riskLevel: action.riskLevel,
          requiresSmsVerification: action.requiresSmsVerification,
          executionMode: getExecutionMode(action),
          summary,
          finalPayload: publicActionPayload(preparedPayload),
          ...(action.riskLevel === 'high'
            ? { maskedPhoneNumber: maskPhoneNumber(user.phoneNumber) }
            : {}),
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

const confirmAction = async ({ confirmationId, user }) => {
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

  if (canUseMvpLocalSimulation(confirmation.actionName)) {
    return executeMvpLocalSimulation({
      action,
      actionName: confirmation.actionName,
      payload: confirmation.payload,
      user,
      confirmationId,
      confirmationStatus: 'confirmed',
    });
  }

  if (confirmation.riskLevel === 'high') {
    if (!user.phoneNumber) {
      createExecutionLog({
        user,
        action,
        actionName: confirmation.actionName,
        payload: confirmation.payload,
        status: 'phone_required',
        failureReason: 'User has no registered phone number',
        confirmationId,
        confirmationStatus: 'confirmed',
      });

      return {
        httpStatus: 400,
        body: {
          success: false,
          status: 'phone_required',
          message:
            'This action requires a registered phone number for SMS verification.',
        },
      };
    }

    const smsCode = createSmsCode({
      userId: user.id,
      phoneNumber: user.phoneNumber,
      purpose: 'high_risk_action',
      actionName: confirmation.actionName,
      confirmationId,
    });

    createExecutionLog({
      user,
      action,
      actionName: confirmation.actionName,
      payload: confirmation.payload,
      status: 'sms_required',
      result: {
        confirmationId,
        maskedPhoneNumber: smsCode.maskedPhoneNumber,
        expiresAt: smsCode.expiresAt,
      },
      confirmationId,
      confirmationStatus: 'confirmed',
    });

    console.info('[action-security] sms_required', {
      confirmationId,
      actionName: confirmation.actionName,
      smsVerificationStatus: 'created',
    });

    return {
      httpStatus: 200,
      body: {
        success: true,
        status: 'sms_required',
        message: 'SMS verification code sent to your registered phone number.',
        data: {
          confirmationId,
          actionName: confirmation.actionName,
          finalPayload: publicActionPayload(confirmation.payload),
          maskedPhoneNumber: smsCode.maskedPhoneNumber,
          expiresAt: smsCode.expiresAt,
        },
      },
    };
  }

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

const cancelAction = async ({ confirmationId, user }) => {
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

const verifyAndExecuteAction = async ({ confirmationId, code, user }) => {
  const missingFields = [
    ...(!confirmationId ? ['confirmationId'] : []),
    ...(!code ? ['code'] : []),
  ];

  if (missingFields.length > 0) {
    createExecutionLog({
      user,
      status: 'missing_fields',
      failureReason: `Missing fields: ${missingFields.join(', ')}`,
      confirmationId,
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
      confirmationStatus: confirmation.status,
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

  if (confirmation.status !== 'confirmed') {
    createExecutionLog({
      user,
      action,
      actionName: confirmation.actionName,
      payload: confirmation.payload,
      status: 'failed',
      failureReason: 'Confirmation must be confirmed before SMS execution',
      confirmationId,
      confirmationStatus: confirmation.status,
    });

    return {
      httpStatus: 400,
      body: {
        success: false,
        status: 'confirmation_required',
        message: 'Please confirm this action before SMS verification.',
      },
    };
  }

  if (confirmation.riskLevel !== 'high') {
    createExecutionLog({
      user,
      action,
      actionName: confirmation.actionName,
      payload: confirmation.payload,
      status: 'failed',
      failureReason: 'SMS verification is only required for high-risk actions',
      confirmationId,
      confirmationStatus: 'confirmed',
    });

    return {
      httpStatus: 400,
      body: {
        success: false,
        status: 'invalid_confirmation_risk',
        message: 'SMS verification is only required for high-risk actions.',
      },
    };
  }

  const smsResult = verifySmsCode({
    userId: user.id,
    code,
    purpose: 'high_risk_action',
    actionName: confirmation.actionName,
    confirmationId,
  });

  console.info('[action-security] sms_verification_result', {
    confirmationId,
    actionName: confirmation.actionName,
    smsVerificationStatus: smsResult.status,
  });

  if (!smsResult.success) {
    createExecutionLog({
      user,
      action,
      actionName: confirmation.actionName,
      payload: confirmation.payload,
      status: smsResult.status,
      failureReason: smsResult.message,
      confirmationId,
      confirmationStatus: 'confirmed',
      smsVerificationStatus: smsResult.status,
    });

    const responseBody = {
      success: false,
      status: smsResult.status,
      message: smsResult.message,
    };

    if (smsResult.attemptsRemaining !== undefined) {
      responseBody.data = {
        attemptsRemaining: smsResult.attemptsRemaining,
      };
    }

    return {
      httpStatus: 400,
      body: responseBody,
    };
  }

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
      status: 'failed',
      failureReason: validation.log.failureReason,
      confirmationId,
      confirmationStatus: 'confirmed',
      smsVerificationStatus: 'verified',
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
    smsVerificationStatus: 'verified',
    failureAuditStatus: 'failed',
  });
};

module.exports = {
  cancelAction,
  confirmAction,
  executeAction,
  verifyAndExecuteAction,
};
