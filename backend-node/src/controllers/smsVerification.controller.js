const { createAuditLog } = require('../services/auditLog.service');
const {
  createSmsCode,
  getLatestSmsCodeForUser,
  isSmsCodeExpired,
  verifySmsCode,
} = require('../services/smsVerification.service');

const createSmsAuditLog = ({
  req,
  status,
  result,
  failureReason,
  confirmationId,
}) => {
  const { purpose, actionName } = req.body;

  return createAuditLog({
    userId: req.user.id,
    role: req.user.role,
    actionName,
    status,
    payload: {
      purpose,
      actionName,
      confirmationId,
    },
    confirmationId,
    result,
    failureReason,
  });
};

const sendSmsCode = (req, res) => {
  const { purpose, actionName, confirmationId } = req.body;

  if (!purpose || !actionName) {
    return res.status(400).json({
      success: false,
      status: 'missing_fields',
      missingFields: [
        ...(!purpose ? ['purpose'] : []),
        ...(!actionName ? ['actionName'] : []),
      ],
    });
  }

  if (!req.user.phoneNumber) {
    createSmsAuditLog({
      req,
      status: 'phone_required',
      confirmationId,
      failureReason: 'User has no registered phone number',
    });

    return res.status(400).json({
      success: false,
      status: 'phone_required',
      message:
        'This action requires a registered phone number for SMS verification.',
    });
  }

  const smsCode = createSmsCode({
    userId: req.user.id,
    phoneNumber: req.user.phoneNumber,
    purpose,
    actionName,
    confirmationId,
  });

  createSmsAuditLog({
    req,
    status: 'sms_sent',
    confirmationId,
    result: {
      maskedPhoneNumber: smsCode.maskedPhoneNumber,
      expiresAt: smsCode.expiresAt,
    },
  });

  return res.status(201).json({
    success: true,
    status: 'sms_sent',
    message: 'SMS verification code sent to your registered phone number.',
    data: {
      maskedPhoneNumber: smsCode.maskedPhoneNumber,
      expiresAt: smsCode.expiresAt,
    },
  });
};

const verifySms = (req, res) => {
  const { purpose, actionName, confirmationId, code } = req.body;

  const missingFields = [
    ...(!purpose ? ['purpose'] : []),
    ...(!actionName ? ['actionName'] : []),
    ...(!code ? ['code'] : []),
  ];

  if (missingFields.length > 0) {
    return res.status(400).json({
      success: false,
      status: 'missing_fields',
      missingFields,
    });
  }

  const result = verifySmsCode({
    userId: req.user.id,
    code,
    purpose,
    actionName,
    confirmationId,
  });

  if (['sms_verified', 'sms_failed', 'sms_expired'].includes(result.status)) {
    createSmsAuditLog({
      req,
      status: result.status,
      confirmationId,
      result: result.success
        ? {
            verifiedAt: result.record?.verifiedAt,
          }
        : null,
      failureReason: result.success ? null : result.message,
    });
  }

  const responseBody = {
    success: result.success,
    status: result.status,
    message: result.message,
  };

  if (result.attemptsRemaining !== undefined) {
    responseBody.data = {
      attemptsRemaining: result.attemptsRemaining,
    };
  }

  return res.status(result.success ? 200 : 400).json(responseBody);
};

const getSmsStatus = (req, res) => {
  const { purpose, actionName, confirmationId } = req.query;

  if (!purpose || !actionName) {
    return res.status(400).json({
      success: false,
      status: 'missing_fields',
      missingFields: [
        ...(!purpose ? ['purpose'] : []),
        ...(!actionName ? ['actionName'] : []),
      ],
    });
  }

  const smsCode = getLatestSmsCodeForUser(
    req.user.id,
    purpose,
    actionName,
    confirmationId,
  );

  if (!smsCode) {
    return res.status(404).json({
      success: false,
      status: 'sms_not_found',
      message: 'No active SMS verification code was found.',
    });
  }

  isSmsCodeExpired(smsCode);

  return res.json({
    success: true,
    status: smsCode.status,
    message: 'SMS verification status retrieved successfully.',
    data: {
      maskedPhoneNumber: smsCode.maskedPhoneNumber,
      attempts: smsCode.attempts,
      maxAttempts: smsCode.maxAttempts,
      expiresAt: smsCode.expiresAt,
      createdAt: smsCode.createdAt,
      verifiedAt: smsCode.verifiedAt,
    },
  });
};

module.exports = {
  getSmsStatus,
  sendSmsCode,
  verifySms,
};
