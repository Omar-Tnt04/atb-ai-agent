const express = require('express');

const {
  executeBillPayment,
  prepareBillPayment,
} = require('../controllers/bill.controller');
const authMiddleware = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

router.post('/prepare-payment', prepareBillPayment);
router.post('/execute-payment', executeBillPayment);

module.exports = router;
