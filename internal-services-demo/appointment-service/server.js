// Internal demo Appointment Service.
// Simulates an internal ATB branch appointment application exposed over HTTP.
// In production this URL is replaced by the real ATB appointment API.
const express = require('express');

const app = express();
app.use(express.json());

const SERVICE_NAME = 'appointment-service';
const PORT = process.env.APPOINTMENT_SERVICE_PORT || 7104;
const MODE = 'internal_demo_service';

let appointmentSequence = 0;

const SLOTS = [
  { branch: 'Tunis Centre', date: '2026-05-21', time: '10:00' },
  { branch: 'Lac 2', date: '2026-05-21', time: '14:00' },
];

const nextReference = (sequence) =>
  `APT-DEMO-${new Date().getFullYear()}-${String(sequence).padStart(6, '0')}`;

const isMissing = (value) => value === undefined || value === null || value === '';

app.get('/health', (req, res) => {
  res.json({ success: true, service: SERVICE_NAME, status: 'running' });
});

app.get('/appointments/slots', (req, res) => {
  res.json(SLOTS);
});

app.post('/appointments/book', (req, res) => {
  const body = req.body || {};
  const missing = ['userId', 'branch', 'date', 'time'].filter((field) =>
    isMissing(body[field]),
  );

  if (missing.length > 0) {
    return res.status(400).json({
      success: false,
      mode: MODE,
      error: `Missing required fields: ${missing.join(', ')}`,
    });
  }

  appointmentSequence += 1;

  return res.json({
    success: true,
    mode: MODE,
    appointmentReference: nextReference(appointmentSequence),
    status: 'booked',
    branch: body.branch,
    date: body.date,
    time: body.time,
  });
});

app.listen(PORT, () => {
  console.log(`${SERVICE_NAME} running on port ${PORT}`);
});
