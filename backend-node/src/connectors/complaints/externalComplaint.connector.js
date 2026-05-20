const {
  safeExternalRequest,
} = require('../external/externalApi.client');
const {
  getServiceConfig,
} = require('../external/externalService.config');

const config = () => getServiceConfig('complaint');

module.exports = {
  name: 'externalComplaintConnector',
  description: 'External complaint connector for future ATB complaint services',
  operations: {
    createComplaint: async ({ user, payload }) =>
      safeExternalRequest({
        config: config(),
        method: 'POST',
        path: '/complaints',
        data: {
          user: { id: user.id, fullName: user.fullName, role: user.role },
          payload,
        },
      }),

    listComplaints: async ({ user, payload }) =>
      safeExternalRequest({
        config: config(),
        method: 'GET',
        path: '/complaints',
        data: {
          user: { id: user.id, role: user.role },
          payload,
        },
      }),

    checkComplaintStatus: async ({ user, payload }) =>
      safeExternalRequest({
        config: config(),
        method: 'GET',
        path: `/complaints/${encodeURIComponent(payload.reference || '')}`,
        data: {
          user: { id: user.id, role: user.role },
          payload,
        },
      }),
  },
};
