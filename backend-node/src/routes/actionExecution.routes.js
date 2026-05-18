const express = require('express');

const {
  executeAgentAction,
  prepareAgentAction,
} = require('../controllers/actionExecution.controller');
const authMiddleware = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

router.post('/execute', executeAgentAction);
router.post('/prepare', prepareAgentAction);

module.exports = router;
