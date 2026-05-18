const express = require('express');

const {
  generateDocument,
  getDocuments,
} = require('../controllers/document.controller');
const authMiddleware = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

router.get('/', getDocuments);
router.post('/generate', generateDocument);

module.exports = router;
