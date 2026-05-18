const mockAccounts = require('../data/mockAccounts');
const mockBeneficiaries = require('../data/mockBeneficiaries');
const { maskAccountNumber, maskRib } = require('../utils/mask');

const TRANSFER_FEES = 1;

const transferReferences = [];

const createTransferReference = () => {
  const year = new Date().getFullYear();
  const sequence = String(transferReferences.length + 1).padStart(6, '0');
  const reference = `TRF-${year}-${sequence}`;

  transferReferences.push(reference);

  return reference;
};

const getTransferContext = (req, res) => {
  if (req.user.role !== 'CLIENT') {
    res.status(403).json({
      success: false,
      message: 'Only client users can perform transfer operations',
    });
    return null;
  }

  const { sourceAccountId, beneficiaryId, amount } = req.body;

  if (!sourceAccountId || !beneficiaryId || amount === undefined) {
    res.status(400).json({
      success: false,
      message: 'sourceAccountId, beneficiaryId, and amount are required',
    });
    return null;
  }

  const parsedAmount = Number(amount);

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    res.status(400).json({
      success: false,
      message: 'Transfer amount must be a positive number',
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

  const beneficiary = mockBeneficiaries.find(
    (mockBeneficiary) =>
      mockBeneficiary.beneficiaryId === beneficiaryId &&
      mockBeneficiary.userId === req.user.id,
  );

  if (!beneficiary) {
    res.status(404).json({
      success: false,
      message: 'Beneficiary not found',
    });
    return null;
  }

  return {
    amount: parsedAmount,
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

const prepareTransfer = (req, res) => {
  const context = getTransferContext(req, res);

  if (!context) {
    return;
  }

  return res.json({
    success: true,
    message: 'Transfer prepared successfully',
    data: buildTransferSummary(context),
  });
};

const executeTransfer = (req, res) => {
  const context = getTransferContext(req, res);

  if (!context) {
    return;
  }

  const totalAmount = Number((context.amount + TRANSFER_FEES).toFixed(3));

  if (context.sourceAccount.balance < totalAmount) {
    return res.status(400).json({
      success: false,
      message: 'Insufficient account balance',
    });
  }

  context.sourceAccount.balance = Number(
    (context.sourceAccount.balance - totalAmount).toFixed(3),
  );

  return res.json({
    success: true,
    message: 'Transfer executed successfully',
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
};

module.exports = {
  executeTransfer,
  prepareTransfer,
};
