const mockComplaints = require('../data/mockComplaints');

const canViewComplaint = (user, complaint) => {
  return (
    user.role === 'SUPPORT_AGENT' ||
    user.role === 'ADMIN' ||
    complaint.userId === user.id
  );
};

const createComplaintReference = () => {
  const year = new Date().getFullYear();
  const sequence = String(mockComplaints.length + 1).padStart(3, '0');

  return `CMP-${year}-${sequence}`;
};

const createComplaint = (req, res) => {
  const { category, description } = req.body;

  if (!category || !description) {
    return res.status(400).json({
      success: false,
      message: 'category and description are required',
    });
  }

  const complaint = {
    reference: createComplaintReference(),
    userId: req.user.id,
    customerName: req.user.fullName,
    category,
    description,
    status: 'open',
    createdAt: new Date().toISOString(),
  };

  mockComplaints.push(complaint);

  return res.status(201).json({
    success: true,
    message: 'Complaint created successfully',
    complaint,
  });
};

const getComplaints = (req, res) => {
  const complaints =
    req.user.role === 'SUPPORT_AGENT' || req.user.role === 'ADMIN'
      ? mockComplaints
      : mockComplaints.filter((complaint) => complaint.userId === req.user.id);

  return res.json({
    success: true,
    message: 'Complaints retrieved successfully',
    complaints,
  });
};

const getComplaintByReference = (req, res) => {
  const complaint = mockComplaints.find(
    (mockComplaint) => mockComplaint.reference === req.params.reference,
  );

  if (!complaint || !canViewComplaint(req.user, complaint)) {
    return res.status(404).json({
      success: false,
      message: 'Complaint not found',
    });
  }

  return res.json({
    success: true,
    message: 'Complaint retrieved successfully',
    complaint,
  });
};

module.exports = {
  createComplaint,
  getComplaints,
  getComplaintByReference,
};
