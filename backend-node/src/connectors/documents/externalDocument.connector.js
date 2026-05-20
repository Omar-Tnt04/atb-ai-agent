const {
  safeExternalRequest,
} = require('../external/externalApi.client');
const {
  getServiceConfig,
} = require('../external/externalService.config');

const config = () => getServiceConfig('document');

module.exports = {
  name: 'externalDocumentConnector',
  description: 'External document connector for future ATB document services',
  operations: {
    listDocuments: async ({ user, payload }) =>
      safeExternalRequest({
        config: config(),
        method: 'GET',
        path: '/documents',
        data: {
          user: { id: user.id, role: user.role },
          payload,
        },
      }),

    generateDocument: async ({ user, payload }) =>
      safeExternalRequest({
        config: config(),
        method: 'POST',
        path: '/documents/generate',
        data: {
          user: { id: user.id, role: user.role },
          payload,
        },
      }),
  },
};
