// Internal demo Document Service.
// Simulates an internal ATB document application exposed over HTTP.
// In production this URL is replaced by the real ATB document API.
const express = require('express');

const app = express();
app.use(express.json());

const SERVICE_NAME = 'document-service';
const PORT = process.env.DOCUMENT_SERVICE_PORT || 7102;
const BASE_URL = process.env.DOCUMENT_SERVICE_BASE_URL || `http://localhost:${PORT}`;
const MODE = 'internal_demo_service';

let documentSequence = 0;
const documents = new Map();

const nextDocumentId = (sequence) =>
  `DOC-DEMO-${new Date().getFullYear()}-${String(sequence).padStart(6, '0')}`;

const isMissing = (value) => value === undefined || value === null || value === '';

const titleFor = (documentType, period) => {
  const type = String(documentType || 'document').toLowerCase();
  const label = type === 'statement' ? 'Account statement' : `Account ${type}`;
  return period ? `${label} - ${period}` : label;
};

app.get('/health', (req, res) => {
  res.json({ success: true, service: SERVICE_NAME, status: 'running' });
});

app.post('/documents/generate', (req, res) => {
  const body = req.body || {};
  const missing = ['userId', 'accountId', 'documentType', 'period'].filter(
    (field) => isMissing(body[field]),
  );

  if (missing.length > 0) {
    return res.status(400).json({
      success: false,
      mode: MODE,
      error: `Missing required fields: ${missing.join(', ')}`,
    });
  }

  documentSequence += 1;
  const documentId = nextDocumentId(documentSequence);
  const title = titleFor(body.documentType, body.period);

  documents.set(documentId, {
    documentId,
    title,
    userId: body.userId,
    accountId: body.accountId,
    documentType: body.documentType,
    period: body.period,
    generatedAt: new Date().toISOString(),
  });

  return res.json({
    success: true,
    mode: MODE,
    documentId,
    status: 'generated',
    title,
    downloadUrl: `${BASE_URL}/documents/${documentId}/download`,
  });
});

app.get('/documents/:documentId/download', (req, res) => {
  const document = documents.get(req.params.documentId);

  if (!document) {
    return res.status(404).json({
      success: false,
      mode: MODE,
      error: 'Document not found',
    });
  }

  const lines = [
    'ARAB TUNISIAN BANK - INTERNAL DEMO DOCUMENT SERVICE',
    '====================================================',
    '',
    `Document ID : ${document.documentId}`,
    `Title       : ${document.title}`,
    `Account     : ${document.accountId}`,
    `Type        : ${document.documentType}`,
    `Period      : ${document.period}`,
    `Generated   : ${document.generatedAt}`,
    '',
    'This is a simulated document produced by the internal demo service.',
  ];

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${document.documentId}.txt"`,
  );
  return res.send(lines.join('\n'));
});

app.listen(PORT, () => {
  console.log(`${SERVICE_NAME} running on port ${PORT}`);
});
