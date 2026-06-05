const fs = require('fs');
const path = require('path');
const env = require('../config/env');

const LOG_PREFIX = '[ATB_AGENT]';
const RESOURCE_HINTS = [
  'ATB Connect',
  'profile',
  'receipt',
  'bill',
  'card',
  'tax',
  'appointment',
  'branch',
  'SONEDE',
  'Telecom',
  'checkbook',
  'transfer',
  'certificate',
];

const isEnabled = () => process.env.ATB_DEBUG_LOGS === 'true';

const shouldSaveAiContext = () => false;

const truncate = (value = '', max = 160) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
};

const detectResourceHints = (message = '') => {
  const text = String(message || '');
  const normalized = text.toLowerCase();
  return RESOURCE_HINTS.filter((hint) => {
    const pattern = hint.toLowerCase().replace(/\s+/g, '\\s+');
    return new RegExp(`\\b${pattern}\\b`, 'i').test(normalized);
  });
};

const maskString = (value) => {
  let text = String(value);

  text = text.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    '[REDACTED_EMAIL]',
  );
  text = text.replace(
    /\b(?:\+?\d[\s.-]?){8,15}\b/g,
    (match) => {
      const digits = match.replace(/\D/g, '');
      if (digits.length < 8) return match;
      return '[REDACTED_PHONE]';
    },
  );
  text = text.replace(
    /\b(?:\d[ -]?){13,19}\b/g,
    (match) => {
      const digits = match.replace(/\D/g, '');
      if (digits.length < 13) return match;
      return `********${digits.slice(-4)}`;
    },
  );
  text = text.replace(/\b(cin|passport)\s*[:#-]?\s*[a-z0-9]{5,20}\b/gi, '$1 [REDACTED_ID]');
  text = text.replace(/\b(?:otp|password|passcode|token|api[_ -]?key|authorization)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/g, 'Bearer [REDACTED]');

  return text;
};

const redact = (value, key = '') => {
  const normalizedKey = String(key || '').toLowerCase();

  if (/(message|query|goal|reason|assistant|response|context|prompt)/i.test(normalizedKey)) {
    if (typeof value === 'string') {
      return `[text length=${value.length}]`;
    }
    if (value && typeof value === 'object') {
      return {
        keys: Object.keys(value).slice(0, 20),
        itemCount: Array.isArray(value) ? value.length : undefined,
      };
    }
  }

  if (
    /(password|otp|token|api.?key|authorization|secret|passport|cin)/i.test(normalizedKey)
  ) {
    return '[REDACTED]';
  }

  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    if (/^acc_\d+$/i.test(value) || /^user_\d+$/i.test(value) || /^\*+\d{4}$/.test(value)) {
      return value;
    }
    return maskString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) return value.map((item) => redact(item, key));

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([itemKey, itemValue]) => [
        itemKey,
        redact(itemValue, itemKey),
      ]),
    );
  }

  return value;
};

const logFilePath = () => path.resolve(__dirname, '..', '..', env.logDir, 'agent.log');

const logAgentStep = (requestId, stage, data = {}) => {
  if (!isEnabled()) return;

  const entry = {
    requestId: requestId || 'unknown',
    ts: new Date().toISOString(),
    stage,
    data: redact(data),
  };
  const line = `${LOG_PREFIX} ${JSON.stringify(entry)}`;

  console.log(line);

  try {
    const file = logFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${line}\n`, 'utf8');
  } catch (error) {
    console.error(`${LOG_PREFIX} could not write agent log: ${error.message}`);
  }
};

const safeMetadata = (value = {}) => ({
  accountId: value.accountId || value.sourceAccountId || value.debitAccountId || null,
  customerId: value.customerId || null,
  status: value.status || null,
  requestId: value.requestId || value.requestReference || null,
  billId: value.billId || value.billReference || value.billRef || null,
});

module.exports = {
  detectResourceHints,
  logAgentStep,
  safeMetadata,
  shouldSaveAiContext,
  truncate,
};
