const express = require('express');

const { analyzeChatMessage } = require('../controllers/chat.controller');
const authMiddleware = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

router.post('/analyze', analyzeChatMessage);

module.exports = router;
