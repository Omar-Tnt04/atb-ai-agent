const express = require('express');

const {
  getSmsStatus,
  sendSmsCode,
  verifySms,
} = require('../controllers/smsVerification.controller');
const authMiddleware = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

router.post('/send', sendSmsCode);
router.post('/verify', verifySms);
router.get('/status', getSmsStatus);

module.exports = router;
