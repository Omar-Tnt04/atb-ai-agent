const express = require('express');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'ATB AI Banking Agent Backend',
    status: 'running',
  });
});

module.exports = router;
