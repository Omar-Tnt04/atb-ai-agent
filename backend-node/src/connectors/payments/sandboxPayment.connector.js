const mockAccounts = require('../../data/mockAccounts');
const mockBills = require('../../data/mockBills');
const { maskAccountNumber } = require('../../utils/mask');

const BILL_PAYMENT_FEES = 0;
const paymentReferences = [];

const createPaymentReference = () => {
  const year = new Date().getFullYear();
  const sequence = String(paymentReferences.length + 1).padStart(6, '0');
  const reference = `PAY-${year}-${sequence}`;

  paymentReferences.push(reference);

  return reference;
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

  return {
    success: true,
    bill,
    sourceAccount,
  };
};

const buildPaymentSummary = (bill, sourceAccount) => {
  const totalAmount = Number((bill.amount + BILL_PAYMENT_FEES).toFixed(3));

  return {
    provider: bill.provider,
    billReference: bill.billReference,
    amount: bill.amount,
    currency: bill.currency,
    sourceAccount: maskAccountNumber(sourceAccount.accountNumber),
    fees: BILL_PAYMENT_FEES,
    totalAmount,
  };
};

module.exports = {
  name: 'sandboxPaymentConnector',
  description: 'Sandbox payment connector for MVP bill payment actions',
  operations: {
    prepareBillPayment: async ({ user, payload }) => {
      const context = getBillPaymentContext({ user, payload });

      if (!context.success) {
        return context;
      }

      return {
        success: true,
        data: buildPaymentSummary(context.bill, context.sourceAccount),
      };
    },

    executeBillPayment: async ({ user, payload }) => {
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
    },
  },
};
