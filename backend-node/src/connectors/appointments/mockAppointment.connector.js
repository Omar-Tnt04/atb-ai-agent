const {
  availableSlots,
  bookedAppointments,
} = require('../../data/mockAppointments');

module.exports = {
  name: 'mockAppointmentConnector',
  description: 'Demo appointment connector for MVP',
  operations: {
    listAppointmentSlots: async () => ({
      success: true,
      data: {
        slots: availableSlots,
      },
    }),

    bookAppointment: async ({ user, payload }) => {
      const appointmentId = `APT-${new Date().getFullYear()}-${String(
        bookedAppointments.length + 1,
      ).padStart(3, '0')}`;

      const appointment = {
        appointmentId,
        userId: user.id,
        customerName: user.fullName,
        branch: payload.branch,
        date: payload.date,
        time: payload.time,
        status: 'confirmed',
        createdAt: new Date().toISOString(),
      };

      bookedAppointments.push(appointment);

      return {
        success: true,
        data: {
          appointment,
        },
      };
    },
  },
};
