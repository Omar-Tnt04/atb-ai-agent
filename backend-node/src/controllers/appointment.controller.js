const {
  availableSlots,
  bookedAppointments,
} = require('../data/mockAppointments');

const getAvailableSlots = (req, res) => {
  return res.json({
    success: true,
    message: 'Available appointment slots retrieved successfully',
    slots: availableSlots,
  });
};

const bookAppointment = (req, res) => {
  const { branch, date, time } = req.body;

  if (!branch || !date || !time) {
    return res.status(400).json({
      success: false,
      message: 'branch, date, and time are required',
    });
  }

  const appointmentId = `APT-${new Date().getFullYear()}-${String(
    bookedAppointments.length + 1,
  ).padStart(3, '0')}`;

  const appointment = {
    appointmentId,
    userId: req.user.id,
    customerName: req.user.fullName,
    branch,
    date,
    time,
    status: 'confirmed',
    createdAt: new Date().toISOString(),
  };

  bookedAppointments.push(appointment);

  return res.status(201).json({
    success: true,
    message: 'Appointment booked successfully',
    appointment,
  });
};

module.exports = {
  getAvailableSlots,
  bookAppointment,
};
