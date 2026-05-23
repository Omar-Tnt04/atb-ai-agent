// Internal demo Payment Service.
// Simulates an internal ATB payment application exposed over HTTP.
// In production this URL is replaced by the real ATB payment API.
const express = require('express');

const app = express();
app.use(express.json());

const SERVICE_NAME = 'payment-service';
const PORT = process.env.PAYMENT_SERVICE_PORT || 7101;
const MODE = 'internal_demo_service';

let paymentSequence = 0;
let transferSequence = 0;

const nextReference = (prefix, sequence) =>
  `${prefix}-DEMO-${new Date().getFullYear()}-${String(sequence).padStart(6, '0')}`;

const isMissing = (value) => value === undefined || value === null || value === '';

const requireFields = (body, fields) =>
  fields.filter((field) => isMissing(body[field]));

app.get('/health', (req, res) => {
  res.json({ success: true, service: SERVICE_NAME, status: 'running' });
});

app.post('/payments/pay-bill', (req, res) => {
  const body = req.body || {};
  const missing = requireFields(body, [
    'userId',
    'sourceAccountId',
    'provider',
    'billReference',
    'amount',
  ]);

  if (missing.length > 0) {
    return res.status(400).json({
      success: false,
      mode: MODE,
      error: `Missing required fields: ${missing.join(', ')}`,
    });
  }

  const amount = Number(body.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({
      success: false,
      mode: MODE,
      error: 'amount must be a positive number',
    });
  }

  paymentSequence += 1;

  return res.json({
    success: true,
    mode: MODE,
    paymentReference: nextReference('PAY', paymentSequence),
    status: 'completed',
    provider: body.provider,
    billReference: body.billReference,
    amount,
    currency: body.currency || 'TND',
  });
});

app.post('/transfers/create', (req, res) => {
  const body = req.body || {};
  const missing = requireFields(body, [
    'userId',
    'sourceAccountId',
    'beneficiaryId',
    'amount',
  ]);

  if (missing.length > 0) {
    return res.status(400).json({
      success: false,
      mode: MODE,
      error: `Missing required fields: ${missing.join(', ')}`,
    });
  }

  const amount = Number(body.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({
      success: false,
      mode: MODE,
      error: 'amount must be a positive number',
    });
  }

  transferSequence += 1;

  return res.json({
    success: true,
    mode: MODE,
    transferReference: nextReference('TRF', transferSequence),
    status: 'completed',
    sourceAccountId: body.sourceAccountId,
    beneficiaryId: body.beneficiaryId,
    amount,
    currency: body.currency || 'TND',
  });
});

app.listen(PORT, () => {
  console.log(`${SERVICE_NAME} running on port ${PORT}`);
});
