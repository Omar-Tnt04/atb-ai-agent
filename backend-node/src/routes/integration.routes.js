const express = require('express');

const {
  getInternalServiceStatus,
  listConnectors,
} = require('../controllers/integration.controller');
const authMiddleware = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

router.get('/connectors', listConnectors);
router.get('/internal/status', getInternalServiceStatus);

module.exports = router;
