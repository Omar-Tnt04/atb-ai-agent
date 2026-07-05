const express = require('express');

const {
  debugCatalogMatch,
  downloadApprovedResource,
  viewApprovedResource,
} = require('../controllers/resource.controller');
const authMiddleware = require('../middleware/auth.middleware');

const router = express.Router();

// Public demo download endpoint. Download IDs are generated only after the
// backend validates Laragon PDF URLs, so this route can be opened directly.
router.get('/download/:downloadId', downloadApprovedResource);
router.get('/view/:viewId', viewApprovedResource);

router.use(authMiddleware);

// Resource resolution is intentionally not exposed as a browser-callable route.
// Chat orchestration resolves and validates Laragon JSON/PDF resources server-side.
router.get('/catalog/debug', debugCatalogMatch);

module.exports = router;
