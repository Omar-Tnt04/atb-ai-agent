const { callInternalService } = require('./internalService.client');

const createComplaint = async ({ user, payload }) => {
  const result = await callInternalService({
    serviceName: 'atb',
    method: 'POST',
    path: '/complaints',
    data: {
      userId: user.id,
      category: payload.category,
      description: payload.description,
    },
  });

  if (!result.success) {
    return result;
  }

  return {
    success: true,
    source: result.source,
    fallbackUsed: false,
    serviceName: result.serviceName,
    data: {
      complaint: {
        reference: result.data.complaintReference,
        status: result.data.status,
        category: result.data.category,
        createdAt: result.data.createdAt,
      },
    },
  };
};

const checkComplaintStatus = async ({ payload }) => {
  const result = await callInternalService({
    serviceName: 'atb',
    method: 'GET',
    path: `/complaints/${encodeURIComponent(payload.reference)}`,
  });

  if (!result.success) {
    return result;
  }

  return {
    success: true,
    source: result.source,
    fallbackUsed: false,
    serviceName: result.serviceName,
    data: {
      complaint: {
        reference: result.data.complaintReference,
        status: result.data.status,
        category: result.data.category,
        description: result.data.description,
        createdAt: result.data.createdAt,
      },
    },
  };
};

module.exports = {
  name: 'internalAtbConnector',
  description: 'Routes customer, card, branch, product, and complaint operations to the internal demo ATB service',
  operations: {
    createComplaint,
    checkComplaintStatus,
  },
};
