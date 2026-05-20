const express = require('express');

const {
  getExternalStatus,
  listConnectors,
} = require('../controllers/integration.controller');
const authMiddleware = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

router.get('/connectors', listConnectors);
router.get('/external/status', getExternalStatus);

module.exports = router;
