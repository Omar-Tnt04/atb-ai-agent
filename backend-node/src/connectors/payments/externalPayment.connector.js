const {
  safeExternalRequest,
} = require('../external/externalApi.client');
const {
  getServiceConfig,
} = require('../external/externalService.config');

const config = () => getServiceConfig('payment');

module.exports = {
  name: 'externalPaymentConnector',
  description: 'External payment connector for future ATB payment services',
  operations: {
    prepareBillPayment: async ({ user, payload }) =>
      safeExternalRequest({
        config: config(),
        method: 'POST',
        path: '/payments/prepare-bill-payment',
        data: {
          user: { id: user.id, role: user.role },
          payload,
        },
      }),

    executeBillPayment: async ({ user, payload }) =>
      safeExternalRequest({
        config: config(),
        method: 'POST',
        path: '/payments/execute-bill-payment',
        data: {
          user: { id: user.id, role: user.role },
          payload,
        },
      }),
  },
};
