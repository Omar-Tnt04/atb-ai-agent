const express = require('express');

const {
  getMyAuditLogs,
  getVisibleAuditLogs,
} = require('../controllers/audit.controller');
const authMiddleware = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

router.get('/me', getMyAuditLogs);
router.get('/', getVisibleAuditLogs);

module.exports = router;
