const express = require('express');

const { getMe, login } = require('../controllers/auth.controller');
const authMiddleware = require('../middleware/auth.middleware');

const router = express.Router();

router.post('/login', login);
router.get('/me', authMiddleware, getMe);

module.exports = router;
