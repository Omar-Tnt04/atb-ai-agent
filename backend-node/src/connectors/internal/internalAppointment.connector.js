const { callInternalService } = require('./internalService.client');

const listAppointmentSlots = async () => {
  const result = await callInternalService({
    serviceName: 'appointment',
    method: 'GET',
    path: '/appointments/slots',
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
      slots: Array.isArray(result.data) ? result.data : result.data?.slots || [],
    },
  };
};

const bookAppointment = async ({ user, payload }) => {
  const result = await callInternalService({
    serviceName: 'appointment',
    method: 'POST',
    path: '/appointments/book',
    data: {
      userId: user.id,
      branch: payload.branch,
      date: payload.date,
      time: payload.time,
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
      appointment: {
        appointmentId: result.data.appointmentReference,
        branch: result.data.branch,
        date: result.data.date,
        time: result.data.time,
        status: result.data.status,
      },
    },
  };
};

module.exports = {
  name: 'internalAppointmentConnector',
  description: 'Routes appointments to the internal demo appointment service',
  operations: {
    listAppointmentSlots,
    bookAppointment,
  },
};
