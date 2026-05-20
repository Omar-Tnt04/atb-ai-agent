const mockAccounts = require('../../data/mockAccounts');
const mockBeneficiaries = require('../../data/mockBeneficiaries');
const { maskAccountNumber, maskRib } = require('../../utils/mask');

const TRANSFER_FEES = 1;
const transferReferences = [];

const SANDBOX_FALLBACK_REASON =
  'External service is not configured. Sandbox execution used for MVP demonstration.';

const withSandboxLabel = (result) => {
  if (!result.success) {
    return result;
  }

  return {
    ...result,
    source: 'sandbox',
    fallbackUsed: true,
    fallbackReason: SANDBOX_FALLBACK_REASON,
  };
};

const createTransferReference = () => {
  const year = new Date().getFullYear();
  const sequence = String(transferReferences.length + 1).padStart(6, '0');
  const reference = `TRF-${year}-${sequence}`;

  transferReferences.push(reference);

  return reference;
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

  const sourceAccount = mockAccounts.find(
    (account) =>
      account.id === payload.sourceAccountId && account.userId === user.id,
  );

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

const buildTransferSummary = ({ amount, beneficiary, sourceAccount }) => {
  const totalAmount = Number((amount + TRANSFER_FEES).toFixed(3));

  return {
    amount,
    currency: sourceAccount.currency,
    sourceAccount: maskAccountNumber(sourceAccount.accountNumber),
    beneficiaryName: beneficiary.name,
    beneficiaryBank: beneficiary.bank,
    beneficiaryRib: maskRib(beneficiary.rib),
    fees: TRANSFER_FEES,
    totalAmount,
  };
};

module.exports = {
  name: 'sandboxTransferConnector',
  description: 'Sandbox transfer connector for MVP transfer actions',
  operations: {
    prepareTransfer: async ({ user, payload }) => {
      const context = getTransferContext({ user, payload });

      if (!context.success) {
        return context;
      }

      return withSandboxLabel({
        success: true,
        data: buildTransferSummary(context),
      });
    },

    executeTransfer: async ({ user, payload }) => {
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

      return withSandboxLabel({
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
      });
    },
  },
};
