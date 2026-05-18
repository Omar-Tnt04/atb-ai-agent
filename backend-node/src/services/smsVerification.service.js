const smsVerificationCodes = require('../data/smsVerificationCodes');
const { maskPhoneNumber } = require('../utils/mask');

const CODE_EXPIRATION_MINUTES = 5;
const MAX_ATTEMPTS = 3;

const generateSixDigitCode = () => {
  return String(Math.floor(100000 + Math.random() * 900000));
};

const matchesContext = (record, userId, purpose, actionName, confirmationId) => {
  return (
    record.userId === userId &&
    record.purpose === purpose &&
    record.actionName === actionName &&
    (record.confirmationId || null) === (confirmationId || null)
  );
};

const isSmsCodeExpired = (record) => {
  if (!record) {
    return false;
  }

  if (record.status !== 'pending') {
    return false;
  }

  const isExpired = new Date(record.expiresAt).getTime() <= Date.now();

  if (isExpired) {
    record.status = 'expired';
  }

  return isExpired;
};

const expireSmsCode = (codeId) => {
  const record = smsVerificationCodes.find((smsCode) => smsCode.id === codeId);

  if (!record) {
    return null;
  }

  record.status = 'expired';

  return record;
};

const getLatestSmsCodeForUser = (
  userId,
  purpose,
  actionName,
  confirmationId,
) => {
  return [...smsVerificationCodes]
    .reverse()
    .find((record) =>
      matchesContext(record, userId, purpose, actionName, confirmationId),
    );
};

const getActiveSmsCodeForUser = (
  userId,
  purpose,
  actionName,
  confirmationId,
) => {
  const record = getLatestSmsCodeForUser(
    userId,
    purpose,
    actionName,
    confirmationId,
  );

  if (!record || isSmsCodeExpired(record) || record.status !== 'pending') {
    return null;
  }

  return record;
};

const createSmsCode = ({
  userId,
  phoneNumber,
  purpose,
  actionName,
  confirmationId,
}) => {
  const existingCode = getActiveSmsCodeForUser(
    userId,
    purpose,
    actionName,
    confirmationId,
  );

  if (existingCode) {
    expireSmsCode(existingCode.id);
  }

  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + CODE_EXPIRATION_MINUTES * 60 * 1000,
  );

  const record = {
    id: `sms_${String(smsVerificationCodes.length + 1).padStart(6, '0')}`,
    userId,
    phoneNumber,
    maskedPhoneNumber: maskPhoneNumber(phoneNumber),
    code: generateSixDigitCode(),
    purpose,
    actionName,
    confirmationId: confirmationId || null,
    status: 'pending',
    attempts: 0,
    maxAttempts: MAX_ATTEMPTS,
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
    verifiedAt: null,
  };

  smsVerificationCodes.push(record);

  console.log(
    `[SIMULATED SMS] Code ${record.code} sent to ${record.maskedPhoneNumber}`,
  );

  return record;
};

const verifySmsCode = ({
  userId,
  code,
  purpose,
  actionName,
  confirmationId,
}) => {
  const record = getLatestSmsCodeForUser(
    userId,
    purpose,
    actionName,
    confirmationId,
  );

  if (!record) {
    return {
      success: false,
      status: 'sms_not_found',
      message: 'No active SMS verification code was found.',
    };
  }

  if (isSmsCodeExpired(record)) {
    return {
      success: false,
      status: 'sms_expired',
      message: 'SMS verification code has expired.',
      record,
    };
  }

  if (record.status === 'verified') {
    return {
      success: true,
      status: 'sms_verified',
      message: 'SMS code is already verified.',
      record,
    };
  }

  if (record.status === 'failed') {
    return {
      success: false,
      status: 'sms_failed',
      message: 'Maximum SMS verification attempts reached.',
      attemptsRemaining: 0,
      record,
    };
  }

  if (record.status !== 'pending') {
    return {
      success: false,
      status: record.status,
      message: 'SMS verification code is no longer active.',
      record,
    };
  }

  if (record.code !== code) {
    record.attempts += 1;

    if (record.attempts >= record.maxAttempts) {
      record.status = 'failed';

      return {
        success: false,
        status: 'sms_failed',
        message: 'Maximum SMS verification attempts reached.',
        attemptsRemaining: 0,
        record,
      };
    }

    return {
      success: false,
      status: 'sms_invalid',
      message: 'Invalid SMS verification code.',
      attemptsRemaining: record.maxAttempts - record.attempts,
      record,
    };
  }

  record.status = 'verified';
  record.verifiedAt = new Date().toISOString();

  return {
    success: true,
    status: 'sms_verified',
    message: 'SMS verification successful.',
    record,
  };
};

module.exports = {
  createSmsCode,
  verifySmsCode,
  getActiveSmsCodeForUser,
  getLatestSmsCodeForUser,
  expireSmsCode,
  isSmsCodeExpired,
};
