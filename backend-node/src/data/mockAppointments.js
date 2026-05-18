const availableSlots = [
  {
    branch: 'Tunis Centre',
    date: '2026-05-25',
    times: ['09:00', '10:00', '11:30', '14:00'],
  },
  {
    branch: 'La Marsa',
    date: '2026-05-26',
    times: ['09:30', '10:30', '15:00'],
  },
  {
    branch: 'Sfax Ville',
    date: '2026-05-27',
    times: ['08:30', '11:00', '13:30'],
  },
];

const bookedAppointments = [];

module.exports = {
  availableSlots,
  bookedAppointments,
};
