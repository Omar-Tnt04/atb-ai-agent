const express = require('express');

const {
  createComplaint,
  getComplaintByReference,
  getComplaints,
} = require('../controllers/complaint.controller');
const authMiddleware = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authMiddleware);

router.post('/', createComplaint);
router.get('/', getComplaints);
router.get('/:reference', getComplaintByReference);

module.exports = router;
