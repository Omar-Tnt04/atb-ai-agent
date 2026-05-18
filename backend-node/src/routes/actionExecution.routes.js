const express = require('express');

const {
  prepareAgentAction,
} = require('../controllers/actionExecution.controller');
const authMiddleware = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

router.post('/prepare', prepareAgentAction);

module.exports = router;
