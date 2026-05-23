// Internal demo ATB Service.
// Simulates general ATB customer, branch, product, card, and complaint APIs.
const express = require('express');

const app = express();
app.use(express.json());

const SERVICE_NAME = 'atb-service';
const PORT = process.env.ATB_SERVICE_PORT || 7106;
const MODE = 'internal_demo_service';

let complaintSequence = 0;
const complaints = new Map();

const CUSTOMERS = {
  user_client_001: {
    userId: 'user_client_001',
    fullName: 'Ahmed Ben Ali',
    segment: 'Retail',
    status: 'active',
    branch: 'Tunis Centre',
  },
  user_admin_001: {
    userId: 'user_admin_001',
    fullName: 'Admin ATB',
    segment: 'Staff',
    status: 'active',
    branch: 'Head Office',
  },
};

const BRANCHES = [
  { id: 'branch_tunis_centre', name: 'Tunis Centre', city: 'Tunis' },
  { id: 'branch_lac_2', name: 'Lac 2', city: 'Tunis' },
  { id: 'branch_sfax', name: 'Sfax Centre', city: 'Sfax' },
];

const PRODUCTS = [
  { id: 'current_account', name: 'Current Account', category: 'accounts' },
  { id: 'savings_account', name: 'Savings Account', category: 'accounts' },
  { id: 'personal_loan', name: 'Personal Loan', category: 'loans' },
  { id: 'debit_card', name: 'Debit Card', category: 'cards' },
];

const CARDS_BY_USER = {
  user_client_001: [
    {
      cardId: 'card_001',
      maskedNumber: '************1122',
      type: 'Debit',
      status: 'active',
    },
  ],
};

const nextReference = (sequence) =>
  `CMP-DEMO-${new Date().getFullYear()}-${String(sequence).padStart(6, '0')}`;

const isMissing = (value) => value === undefined || value === null || value === '';

app.get('/health', (req, res) => {
  res.json({ success: true, service: SERVICE_NAME, status: 'running' });
});

app.get('/customers/:userId', (req, res) => {
  const customer = CUSTOMERS[req.params.userId];

  if (!customer) {
    return res.status(404).json({
      success: false,
      mode: MODE,
      error: 'Customer not found',
    });
  }

  return res.json({ success: true, mode: MODE, customer });
});

app.get('/branches', (req, res) => {
  res.json({ success: true, mode: MODE, branches: BRANCHES });
});

app.get('/products', (req, res) => {
  res.json({ success: true, mode: MODE, products: PRODUCTS });
});

app.get('/cards/:userId', (req, res) => {
  res.json({
    success: true,
    mode: MODE,
    cards: CARDS_BY_USER[req.params.userId] || [],
  });
});

app.post('/complaints', (req, res) => {
  const body = req.body || {};
  const missing = ['userId', 'category', 'description'].filter((field) =>
    isMissing(body[field]),
  );

  if (missing.length > 0) {
    return res.status(400).json({
      success: false,
      mode: MODE,
      error: `Missing required fields: ${missing.join(', ')}`,
    });
  }

  complaintSequence += 1;
  const complaintReference = nextReference(complaintSequence);
  const createdAt = new Date().toISOString();

  complaints.set(complaintReference, {
    complaintReference,
    userId: body.userId,
    category: body.category,
    description: body.description,
    status: 'open',
    createdAt,
  });

  return res.json({
    success: true,
    mode: MODE,
    complaintReference,
    status: 'open',
    category: body.category,
    createdAt,
  });
});

app.get('/complaints/:reference', (req, res) => {
  const complaint = complaints.get(req.params.reference);

  if (!complaint) {
    return res.status(404).json({
      success: false,
      mode: MODE,
      error: 'Complaint not found',
    });
  }

  return res.json({
    success: true,
    mode: MODE,
    complaintReference: complaint.complaintReference,
    status: complaint.status,
    category: complaint.category,
    description: complaint.description,
    createdAt: complaint.createdAt,
  });
});

app.listen(PORT, () => {
  console.log(`${SERVICE_NAME} running on port ${PORT}`);
});
