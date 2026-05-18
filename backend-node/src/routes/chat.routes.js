const express = require('express');

const {
  analyzeChatMessage,
  handleChatMessage,
} = require('../controllers/chat.controller');
const authMiddleware = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

router.post('/analyze', analyzeChatMessage);
router.post('/message', handleChatMessage);

module.exports = router;
