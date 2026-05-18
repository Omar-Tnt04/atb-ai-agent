const express = require('express');

const {
  executeTransfer,
  prepareTransfer,
} = require('../controllers/transfer.controller');
const authMiddleware = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

router.post('/prepare', prepareTransfer);
router.post('/execute', executeTransfer);

module.exports = router;
