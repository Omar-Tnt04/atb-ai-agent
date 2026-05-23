const express = require('express');

const {
  resolveResourceUrl,
} = require('../controllers/resource.controller');

const router = express.Router();

router.get('/resolve', resolveResourceUrl);

module.exports = router;
