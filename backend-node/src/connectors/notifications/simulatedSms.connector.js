const {
  createSmsCode,
  verifySmsCode,
} = require('../../services/smsVerification.service');

module.exports = {
  name: 'simulatedSmsConnector',
  description: 'Simulated SMS connector for MVP verification flows',
  operations: {
    sendSmsCode: async ({ user, payload }) => {
      if (!user.phoneNumber) {
        return {
          success: false,
          status: 'phone_required',
          message: 'User has no registered phone number',
        };
      }

      const smsCode = createSmsCode({
        userId: user.id,
        phoneNumber: user.phoneNumber,
        purpose: payload.purpose,
        actionName: payload.actionName,
        confirmationId: payload.confirmationId,
      });

      return {
        success: true,
        data: smsCode,
      };
    },

    verifySmsCode: async ({ user, payload }) => {
      return verifySmsCode({
        userId: user.id,
        code: payload.code,
        purpose: payload.purpose,
        actionName: payload.actionName,
        confirmationId: payload.confirmationId,
      });
    },
  },
};
