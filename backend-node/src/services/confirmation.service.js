const pendingConfirmations = require('../data/pendingConfirmations');

const createPendingConfirmation = ({
  userId,
  actionName,
  riskLevel,
  payload,
  summary,
  expiresInMinutes = 10,
}) => {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInMinutes * 60 * 1000);

  const confirmation = {
    id: `conf_${String(pendingConfirmations.length + 1).padStart(6, '0')}`,
    userId,
    actionName,
    riskLevel,
    payload,
    summary,
    status: 'pending',
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
    confirmedAt: null,
  };

  pendingConfirmations.push(confirmation);

  return confirmation;
};

const getPendingConfirmationById = (confirmationId) => {
  return pendingConfirmations.find(
    (confirmation) => confirmation.id === confirmationId,
  );
};

const markConfirmationAsConfirmed = (confirmationId) => {
  const confirmation = getPendingConfirmationById(confirmationId);

  if (!confirmation) {
    return null;
  }

  confirmation.status = 'confirmed';
  confirmation.confirmedAt = new Date().toISOString();

  return confirmation;
};

const markConfirmationAsCancelled = (confirmationId) => {
  const confirmation = getPendingConfirmationById(confirmationId);

  if (!confirmation) {
    return null;
  }

  confirmation.status = 'cancelled';

  return confirmation;
};

const isConfirmationExpired = (confirmation) => {
  if (!confirmation) {
    return false;
  }

  if (confirmation.status === 'cancelled') {
    return false;
  }

  if (confirmation.status === 'expired') {
    return true;
  }

  const isExpired = new Date(confirmation.expiresAt).getTime() <= Date.now();

  if (isExpired) {
    confirmation.status = 'expired';
  }

  return isExpired;
};

module.exports = {
  createPendingConfirmation,
  getPendingConfirmationById,
  markConfirmationAsConfirmed,
  markConfirmationAsCancelled,
  isConfirmationExpired,
};
