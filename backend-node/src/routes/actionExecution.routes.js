const express = require('express');

const {
  cancelAgentAction,
  confirmAgentAction,
  executeAgentAction,
  prepareAgentAction,
  verifyAndExecuteAgentAction,
} = require('../controllers/actionExecution.controller');
const authMiddleware = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

router.post('/cancel', cancelAgentAction);
router.post('/confirm', confirmAgentAction);
router.post('/execute', executeAgentAction);
router.post('/prepare', prepareAgentAction);
router.post('/verify-and-execute', verifyAndExecuteAgentAction);

module.exports = router;
