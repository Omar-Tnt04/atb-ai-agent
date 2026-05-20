const {
  safeExternalRequest,
} = require('../external/externalApi.client');
const {
  getServiceConfig,
} = require('../external/externalService.config');

const config = () => getServiceConfig('appointment');

module.exports = {
  name: 'externalAppointmentConnector',
  description: 'External appointment connector for future ATB appointment services',
  operations: {
    listAppointmentSlots: async ({ user, payload }) =>
      safeExternalRequest({
        config: config(),
        method: 'GET',
        path: '/appointments/slots',
        data: {
          user: { id: user.id, role: user.role },
          payload,
        },
      }),

    bookAppointment: async ({ user, payload }) =>
      safeExternalRequest({
        config: config(),
        method: 'POST',
        path: '/appointments/book',
        data: {
          user: { id: user.id, fullName: user.fullName, role: user.role },
          payload,
        },
      }),
  },
};
