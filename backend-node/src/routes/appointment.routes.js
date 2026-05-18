const express = require('express');

const {
  bookAppointment,
  getAvailableSlots,
} = require('../controllers/appointment.controller');
const authMiddleware = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

router.get('/slots', getAvailableSlots);
router.post('/book', bookAppointment);

module.exports = router;
