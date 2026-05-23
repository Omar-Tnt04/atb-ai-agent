// Internal demo Account Service.
// Simulates an internal ATB account application exposed over HTTP.
// In production this URL is replaced by the real ATB account API.
const express = require('express');

const app = express();
app.use(express.json());

const SERVICE_NAME = 'account-service';
const PORT = process.env.ACCOUNT_SERVICE_PORT || 7105;
const MODE = 'internal_demo_service';

// Demo account dataset. Mirrors the backend seed accounts so balances line up
// with the rest of the MVP. In production this is the real account system.
const ACCOUNTS = {
  acc_001: {
    id: 'acc_001',
    accountNumber: '03204000123456789012',
    type: 'Current Account',
    currency: 'TND',
    balance: 2450.75,
    status: 'active',
  },
  acc_002: {
    id: 'acc_002',
    accountNumber: '03204000987654321098',
    type: 'Savings Account',
    currency: 'TND',
    balance: 8700,
    status: 'active',
  },
};

app.get('/health', (req, res) => {
  res.json({ success: true, service: SERVICE_NAME, status: 'running' });
});

app.get('/accounts/:accountId/balance', (req, res) => {
  const account = ACCOUNTS[req.params.accountId];

  if (!account) {
    return res.status(404).json({
      success: false,
      mode: MODE,
      error: 'Account not found',
    });
  }

  return res.json({
    success: true,
    mode: MODE,
    account,
  });
});

app.listen(PORT, () => {
  console.log(`${SERVICE_NAME} running on port ${PORT}`);
});
