const express = require('express');

const {
  getAccountBalance,
  getAccountTransactions,
  getAccounts,
} = require('../controllers/account.controller');
const authMiddleware = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

router.get('/', getAccounts);
router.get('/:accountId/balance', getAccountBalance);
router.get('/:accountId/transactions', getAccountTransactions);

module.exports = router;
