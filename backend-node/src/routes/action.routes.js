const express = require('express');

const {
  getAction,
  getActions,
  getConnectedActions,
} = require('../controllers/action.controller');
const authMiddleware = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

router.get('/', getActions);
router.get('/connected', getConnectedActions);
router.get('/:actionName', getAction);

module.exports = router;
