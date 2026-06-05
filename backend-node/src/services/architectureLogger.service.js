const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const env = require('../config/env');

const SENSITIVE_KEY_PATTERN =
  /(password|passwd|token|jwt|authorization|secret|sms|otp|code|rib|iban|accountnumber|account_number|cardnumber|card_number|pdfbase64|imagebase64|base64|prompt|privatecontext|filetext|fulltext|rawoutput|rawresponse|responsebody)/i;

const LARGE_CONTEXT_KEY_PATTERN =
  /(resourcejson|resourcecontext|resolvedresourcecontext|matchedresource|matchedresources|resources|filecontext|conversationhistory|privatecontext)/i;

const TEXT_LENGTH_ONLY_KEY_PATTERN =
  /(message|query|goal|reason|assistant|response)(?!_?preview)/i;

const MAX_STRING_LENGTH = 160;
const MAX_PREVIEW_LENGTH = 120;

const ensureLogDir = () => {
  if (!env.architectureLogsEnabled) return null;
  const logDir = path.resolve(__dirname, '..', '..', env.logDir);
  fs.mkdirSync(logDir, { recursive: true });
  return logDir;
};

const logDir = ensureLogDir();
const architectureLogPath = logDir ? path.join(logDir, 'architecture.log') : null;
const architectureJsonlPath = logDir ? path.join(logDir, 'architecture.jsonl') : null;
const errorsLogPath = logDir ? path.join(logDir, 'errors.log') : null;

const truncate = (value, limit = MAX_STRING_LENGTH) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
};

const maskScalar = (key, value) => {
  if (value === null || value === undefined) return value;
  const keyText = String(key || '');
  const text = String(value);

  if (SENSITIVE_KEY_PATTERN.test(keyText)) {
    if (/pdfbase64|imagebase64|base64/i.test(keyText)) return `[base64 length=${text.length}]`;
    if (/account|card|rib|iban/i.test(keyText)) return maskIdentifier(text);
    return '[redacted]';
  }

  if (TEXT_LENGTH_ONLY_KEY_PATTERN.test(keyText)) {
    return `[text length=${text.length}]`;
  }

  if (/^Bearer\s+/i.test(text)) return '[redacted bearer token]';
  if (/data:image\/[^;]+;base64,/i.test(text)) return '[image base64 redacted]';
  if (/^[A-Za-z0-9+/=]{500,}$/.test(text)) return `[large base64-like value length=${text.length}]`;

  return truncate(text);
};

const maskIdentifier = (value) => {
  const text = String(value || '').trim();
  const compact = text.replace(/\s+/g, '');
  if (compact.length <= 4) return '****';
  return `${'*'.repeat(Math.min(8, Math.max(4, compact.length - 4)))}${compact.slice(-4)}`;
};

const compactObjectSummary = (payload) => {
  if (!payload || typeof payload !== 'object') return payload;
  if (Array.isArray(payload)) {
    return {
      itemCount: payload.length,
      itemTypes: payload.slice(0, 5).map((item) => typeof item),
    };
  }

  return {
    keys: Object.keys(payload).slice(0, 20),
    title: payload.title || payload.name || payload.fileName || null,
    resourceId: payload.resourceId || payload.id || null,
    resourceType: payload.resourceType || payload.type || null,
    contentType: payload.contentType || payload.mimeType || null,
    extractionStatus: payload.extractionStatus || null,
    fileSize: payload.fileSize || payload.size || null,
    hasPdfPayload: Boolean(payload.pdfBase64),
    hasFileText: Boolean(payload.fileText),
  };
};

const maskLogPayload = (payload, key = '') => {
  if (payload === null || payload === undefined) return payload;

  if (LARGE_CONTEXT_KEY_PATTERN.test(String(key || ''))) {
    return compactObjectSummary(payload);
  }

  if (Array.isArray(payload)) {
    return payload.slice(0, 12).map((item) => maskLogPayload(item, key));
  }

  if (typeof payload === 'object') {
    return Object.fromEntries(
      Object.entries(payload).map(([itemKey, itemValue]) => [
        itemKey,
        maskLogPayload(itemValue, itemKey),
      ]),
    );
  }

  return maskScalar(key, payload);
};

const compactValue = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const writeLine = (filePath, line) => {
  if (!filePath) return;
  fs.appendFile(filePath, `${line}\n`, (error) => {
    if (error) {
      console.error('[architecture-logger] write failed:', error.message);
    }
  });
};

const logArchitecture = (stage, payload = {}, options = {}) => {
  if (!env.architectureLogsEnabled) return;

  const masked = maskLogPayload(payload || {});
  const timestamp = new Date().toISOString();
  const requestId = masked.requestId || options.requestId || 'no-request-id';
  const message = options.message || masked.message || stage;
  const record = {
    timestamp,
    level: options.level || 'info',
    requestId,
    stage,
    message,
    data: masked,
  };

  writeLine(architectureJsonlPath, JSON.stringify(record));

  const fields = Object.entries(masked)
    .filter(([key]) => !['requestId', 'message'].includes(key))
    .map(([key, value]) => `${key}=${compactValue(value)}`)
    .join(' ');
  writeLine(
    architectureLogPath,
    `[${timestamp}] [${requestId}] [${stage}] ${message}${fields ? ` | ${fields}` : ''}`,
  );
};

const logError = (stage, error, payload = {}) => {
  const errorPayload = {
    ...payload,
    errorName: error?.name,
    errorMessage: error?.message,
  };
  logArchitecture(stage, errorPayload, { level: 'error', message: 'error' });
  if (env.architectureLogsEnabled) {
    writeLine(errorsLogPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      stage,
      data: maskLogPayload(errorPayload),
    }));
  }
};

const startTimer = () => performance.now();

const endTimer = (startedAt) =>
  Number.isFinite(startedAt) ? Math.max(0, Math.round(performance.now() - startedAt)) : null;

const messagePreview = (message = '') => `[text length=${String(message || '').length}]`;

module.exports = {
  endTimer,
  logArchitecture,
  logError,
  maskLogPayload,
  messagePreview,
  startTimer,
};
