const mockAccounts = require('../../data/mockAccounts');
const mockBills = require('../../data/mockBills');
const mockBeneficiaries = require('../../data/mockBeneficiaries');
const { maskAccountNumber, maskRib } = require('../../utils/mask');
const { callInternalService } = require('./internalService.client');

const BILL_PAYMENT_FEES = 0;
const TRANSFER_FEES = 1;

const getClientAccount = (user, accountId) =>
  mockAccounts.find(
    (account) => account.id === accountId && account.userId === user.id,
  );

const hasValue = (value) =>
  value !== undefined &&
  value !== null &&
  !(typeof value === 'string' && value.trim() === '');

const getPreparedBill = (payload = {}) => ({
  provider: payload._preparedBill?.provider || payload.provider,
  billReference: payload._preparedBill?.billReference || payload.billReference,
  amount: payload._preparedBill?.amount ?? payload.amount,
  currency: payload._preparedBill?.currency || payload.currency || 'TND',
  status: payload._preparedBill?.status || 'unpaid',
});

// Uses the prepared bill snapshot from confirmation, then routes the payment
// through the internal demo payment service over HTTP.
const executeBillPayment = async ({ user, payload }) => {
  const preparedBill = getPreparedBill(payload);

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

  const billAmount = Number(preparedBill.amount);

  if (!Number.isFinite(billAmount) || billAmount <= 0) {
    return {
      success: false,
      status: 'invalid_amount',
      message: 'Bill amount must be a positive number',
    };
  }

  const totalAmount = Number((billAmount + BILL_PAYMENT_FEES).toFixed(3));

  if (sourceAccount.balance < totalAmount) {
    return {
      success: false,
      status: 'insufficient_balance',
      message: 'Insufficient account balance',
    };
  }

  const result = await callInternalService({
    serviceName: 'payment',
    method: 'POST',
    path: '/payments/pay-bill',
    data: {
      userId: user.id,
      sourceAccountId: sourceAccount.id,
      provider: preparedBill.provider,
      billReference: preparedBill.billReference,
      amount: billAmount,
      currency: preparedBill.currency,
    },
  });

  if (!result.success) {
    return result;
  }

  sourceAccount.balance = Number((sourceAccount.balance - totalAmount).toFixed(3));

  const localBill = Number.isInteger(payload._mockBillIndex)
    ? mockBills[payload._mockBillIndex]
    : null;

  if (localBill?.userId === user.id) {
    localBill.status = 'paid';
    localBill.paidAt = new Date().toISOString();
  }

  return {
    success: true,
    source: result.source,
    fallbackUsed: false,
    serviceName: result.serviceName,
    data: {
      paymentReference: result.data.paymentReference,
      provider: result.data.provider,
      billReference: result.data.billReference,
      amount: result.data.amount,
      currency: result.data.currency,
      sourceAccount: maskAccountNumber(sourceAccount.accountNumber),
      status: result.data.status,
    },
  };
};

const executeTransfer = async ({ user, payload }) => {
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

  const totalAmount = Number((amount + TRANSFER_FEES).toFixed(3));

  if (sourceAccount.balance < totalAmount) {
    return {
      success: false,
      status: 'insufficient_balance',
      message: 'Insufficient account balance',
    };
  }

  const result = await callInternalService({
    serviceName: 'payment',
    method: 'POST',
    path: '/transfers/create',
    data: {
      userId: user.id,
      sourceAccountId: sourceAccount.id,
      beneficiaryId: beneficiary.beneficiaryId,
      amount,
      currency: sourceAccount.currency,
    },
  });

  if (!result.success) {
    return result;
  }

  sourceAccount.balance = Number((sourceAccount.balance - totalAmount).toFixed(3));

  return {
    success: true,
    source: result.source,
    fallbackUsed: false,
    serviceName: result.serviceName,
    data: {
      transferReference: result.data.transferReference,
      amount: result.data.amount,
      currency: result.data.currency,
      sourceAccount: maskAccountNumber(sourceAccount.accountNumber),
      beneficiaryId: beneficiary.beneficiaryId,
      beneficiaryName: beneficiary.name,
      beneficiaryRib: maskRib(beneficiary.rib),
      status: result.data.status,
    },
  };
};

module.exports = {
  name: 'internalPaymentConnector',
  description: 'Routes payments and transfers to the internal demo payment service',
  operations: {
    executeBillPayment,
    executeTransfer,
  },
};
