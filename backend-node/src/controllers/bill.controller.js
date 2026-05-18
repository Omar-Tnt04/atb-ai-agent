const mockAccounts = require('../data/mockAccounts');
const mockBills = require('../data/mockBills');
const { maskAccountNumber } = require('../utils/mask');

const BILL_PAYMENT_FEES = 0;

const paymentReferences = [];

const createPaymentReference = () => {
  const year = new Date().getFullYear();
  const sequence = String(paymentReferences.length + 1).padStart(6, '0');
  const reference = `PAY-${year}-${sequence}`;

  paymentReferences.push(reference);

  return reference;
};

const getClientContext = (req, res) => {
  if (req.user.role !== 'CLIENT') {
    res.status(403).json({
      success: false,
      message: 'Only client users can perform bill payment operations',
    });
    return null;
  }

  const { billReference, sourceAccountId } = req.body;

  if (!billReference || !sourceAccountId) {
    res.status(400).json({
      success: false,
      message: 'billReference and sourceAccountId are required',
    });
    return null;
  }

  const bill = mockBills.find(
    (mockBill) =>
      mockBill.billReference === billReference &&
      mockBill.userId === req.user.id,
  );

  if (!bill) {
    res.status(404).json({
      success: false,
      message: 'Bill not found',
    });
    return null;
  }

  if (bill.status === 'paid') {
    res.status(400).json({
      success: false,
      message: 'Bill is already paid',
    });
    return null;
  }

  const sourceAccount = mockAccounts.find(
    (account) => account.id === sourceAccountId && account.userId === req.user.id,
  );

  if (!sourceAccount) {
    res.status(404).json({
      success: false,
      message: 'Source account not found',
    });
    return null;
  }

  return {
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

const prepareBillPayment = (req, res) => {
  const context = getClientContext(req, res);

  if (!context) {
    return;
  }

  return res.json({
    success: true,
    message: 'Bill payment prepared successfully',
    data: buildPaymentSummary(context.bill, context.sourceAccount),
  });
};

const executeBillPayment = (req, res) => {
  const context = getClientContext(req, res);

  if (!context) {
    return;
  }

  const totalAmount = Number(
    (context.bill.amount + BILL_PAYMENT_FEES).toFixed(3),
  );

  if (context.sourceAccount.balance < totalAmount) {
    return res.status(400).json({
      success: false,
      message: 'Insufficient account balance',
    });
  }

  context.sourceAccount.balance = Number(
    (context.sourceAccount.balance - totalAmount).toFixed(3),
  );
  context.bill.status = 'paid';
  context.bill.paidAt = new Date().toISOString();

  return res.json({
    success: true,
    message: 'Bill payment executed successfully',
    data: {
      paymentReference: createPaymentReference(),
      provider: context.bill.provider,
      amount: context.bill.amount,
      currency: context.bill.currency,
      sourceAccount: maskAccountNumber(context.sourceAccount.accountNumber),
      status: context.bill.status,
      paidAt: context.bill.paidAt,
    },
  });
};

module.exports = {
  executeBillPayment,
  prepareBillPayment,
};
