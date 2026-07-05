// Deterministic backend gating for image resources.
//
// The Node orchestrator decides — without relying on the LLM planner alone — whether an
// image request is a plain retrieval/view ("give me the receipt image") or a content
// extraction question ("read the receipt image / what is the amount?"). It also owns the
// OCR-sufficiency judgement that lets the cheap OCR path short-circuit the vision model.
//
// These helpers are pure and side-effect free so they are trivially unit-testable.

const OCR_MIN_READABLE_CHARS = Number(process.env.OCR_MIN_READABLE_CHARS || 8);

const normalize = (value = '') =>
  String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s.:#/'&-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const readableCharacterCount = (value = '') => {
  const matches = String(value || '').match(/[A-Za-z0-9]/g);
  return matches ? matches.length : 0;
};

// --- file-type predicates (operate on the resolved resourceFileType string) -----------------

const normalizeFileType = (fileType = '') => normalize(fileType);

const isImageResource = (fileType = '') => {
  const text = normalizeFileType(fileType);
  return (
    text === 'image' ||
    /\b(image|png|jpe?g|webp|tif{1,2})\b/.test(text) ||
    text.startsWith('image/')
  );
};

const isPdfResource = (fileType = '') => {
  const text = normalizeFileType(fileType);
  return text === 'pdf' || /\bpdf\b/.test(text);
};

const isTextResource = (fileType = '') => {
  const text = normalizeFileType(fileType);
  return text === 'txt' || /\b(txt|text)\b/.test(text) || text.startsWith('text/');
};

const isJsonResource = (fileType = '') => {
  const text = normalizeFileType(fileType);
  return text === 'json' || /\bjson\b/.test(text);
};

// --- request-intent gating -------------------------------------------------------------------

const RETRIEVAL_VERB_PATTERN =
  /\b(give|show|open|display|view|see|get|grab|send|fetch|download|provide|share|pull\s+up)\b/;

// Strong signals that the user wants the content read/analysed — these always mean content
// extraction, even alongside a retrieval verb.
const STRONG_CONTENT_PATTERNS = [
  /\bread\b/,
  /\bextract\b/,
  /\bparse\b/,
  /\bscan\b/,
  /\bwhat\b/,
  /\bwhat'?s\b/,
  /\bwhich\b/,
  /\bhow\s+much\b/,
  /\bsummar(y|ise|ize|ies)\b/,
  /\bdescribe\b/,
  /\bdetails?\b/,
  /\bcontents?\b/,
  /\bsays?\b/,
  /\btell\s+me\b/,
  /\bwho\b/,
  /\bwhen\b/,
];

// Field-name words. They indicate a content question only when the message is NOT a plain
// retrieval — otherwise they are just part of a resource title (e.g. "QR Merchant Receipt").
const WEAK_FIELD_PATTERNS = [
  /\bamount\b/,
  /\bmerchant\b/,
  /\bbeneficiary\b/,
  /\breference\b/,
  /\bdue\s+date\b/,
  /\bstatus\b/,
  /\btotal\b/,
  /\bvalue\b/,
  /\bnumber\b/,
];

// Decision order: strong content signal wins; otherwise a retrieval verb means retrieval (even
// if a field-name word appears in the resource title); otherwise a bare field-name word means
// content; otherwise fall back to the planner hint, defaulting to the cheapest path (retrieval).
const requiresImageContentExtraction = (message = '', plannerIntent = null) => {
  const text = normalize(message);
  if (!text) return false;
  if (STRONG_CONTENT_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (RETRIEVAL_VERB_PATTERN.test(text)) return false;
  if (WEAK_FIELD_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (plannerIntent === 'resource_qa') return true;
  if (plannerIntent === 'document_show') return false;
  return false;
};

const isImageRetrievalRequest = (message = '', plannerIntent = null) => {
  if (requiresImageContentExtraction(message, plannerIntent)) return false;
  const text = normalize(message);
  return RETRIEVAL_VERB_PATTERN.test(text) || plannerIntent === 'document_show' || Boolean(text);
};

// --- OCR field parsing + sufficiency ---------------------------------------------------------

// Maps the field names the router detects from the user's wording onto the field keys this
// module parses out of OCR text.
const OCR_FIELD_ALIASES = {
  amount: [
    'amount',
    'maxAmount',
    'maximumAmount',
    'currentLimit',
    'availableLimit',
    'minimumPayment',
    'monthlyPaymentExample',
    'total',
    'loanAmount',
  ],
  date: ['date', 'dueDate', 'paymentDueDate', 'statementDate', 'deadline'],
  reference: ['reference', 'billReference', 'billRef', 'invoiceReference'],
  merchant: ['merchant', 'provider', 'beneficiary'],
  status: ['status'],
  card: ['card', 'maskedCard', 'cardNumber', 'account', 'accountId'],
};

// Extract only trusted banking fields from raw OCR text. Masked values are preserved verbatim
// and nothing is invented — unfound fields are simply omitted.
const parseOcrBankingFields = (ocrText = '') => {
  const text = String(ocrText || '');
  if (!text.trim()) return {};

  const fields = {};

  const amountMatch =
    text.match(/\b(?:amount|total|montant)\b\s*[:\-]?\s*([0-9][0-9.,\s]*[0-9])\s*(TND|EUR|USD|DT)?/i) ||
    text.match(/\b([0-9]+[.,][0-9]{2,3})\s*(TND|EUR|USD|DT)\b/i);
  if (amountMatch) {
    fields.amount = amountMatch[1].replace(/\s+/g, '').trim();
    if (amountMatch[2]) fields.currency = amountMatch[2].toUpperCase();
  }

  const referenceMatch = text.match(
    /\b(?:ref(?:erence)?|r[ée]f(?:[ée]rence)?|txn|transaction\s*id|trace|invoice|bill\s*ref(?:erence)?)\b\s*[:#\-]?\s*([A-Za-z0-9][A-Za-z0-9\-/]{3,})/i,
  );
  if (referenceMatch) fields.reference = referenceMatch[1].trim();

  const merchantMatch = text.match(
    /\b(?:merchant|beneficiary|payee|marchand|commer[cç]ant|provider|to)\b\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9 &.'-]{2,40})/i,
  );
  if (merchantMatch) fields.merchant = merchantMatch[1].trim().replace(/\s+/g, ' ');

  const dateMatch = text.match(/\b(\d{4}-\d{2}-\d{2}|\d{2}[/.]\d{2}[/.]\d{4})\b/);
  if (dateMatch) fields.date = dateMatch[1];

  const statusMatch = text.match(
    /\b(paid|unpaid|approved|declined|pending|completed|success(?:ful)?|failed|active|expired)\b/i,
  );
  if (statusMatch) fields.status = statusMatch[1].toLowerCase();

  const cardMatch = text.match(/([*xX•·]{4,}\s?\d{2,4}|\d{0,4}\*{2,}\d{2,4})/);
  if (cardMatch) fields.card = cardMatch[0].trim();

  return fields;
};

// Trusted, whitelisted "Label: Value" extraction from OCR text. Only canonical banking-notice
// labels are accepted, so noisy OCR lines (e.g. "Card FRR Rk: 45 5") are rejected outright
// instead of leaking into the answer. Masked card values are kept verbatim and only when they
// actually look masked.
const OCR_LABEL_LINE = /^\s*([A-Za-z][A-Za-z0-9 /&.'-]{1,40}?)\s*[:\-]\s+(.+?)\s*$/;

// normalised label -> canonical field key
const OCR_LABEL_WHITELIST = {
  'notice id': 'noticeId',
  card: 'card',
  'card number': 'card',
  'masked card': 'card',
  'card type': 'cardType',
  'activation channel': 'activationChannel',
  expiry: 'expiry',
  'expiry date': 'expiry',
  expires: 'expiry',
  status: 'status',
  'recommended step': 'recommendedStep',
  recommendation: 'recommendedStep',
  'next step': 'recommendedStep',
  merchant: 'merchant',
  beneficiary: 'merchant',
  payee: 'merchant',
  provider: 'merchant',
  amount: 'amount',
  total: 'amount',
  currency: 'currency',
  reference: 'reference',
  'bill reference': 'reference',
  'transaction id': 'reference',
  date: 'date',
  'due date': 'date',
  'transaction date': 'date',
  account: 'account',
  'account id': 'account',
};

// Human labels used to rebuild a clean trusted text block for the response writer.
const OCR_FIELD_DISPLAY_LABELS = {
  noticeId: 'Notice ID',
  card: 'Card',
  cardType: 'Card type',
  activationChannel: 'Activation channel',
  expiry: 'Expiry',
  status: 'Status',
  recommendedStep: 'Recommended step',
  merchant: 'Merchant',
  amount: 'Amount',
  currency: 'Currency',
  reference: 'Reference',
  date: 'Date',
  account: 'Account',
};

const OCR_FIELD_ORDER = [
  'noticeId',
  'card',
  'cardType',
  'activationChannel',
  'expiry',
  'status',
  'recommendedStep',
  'merchant',
  'amount',
  'currency',
  'reference',
  'date',
  'account',
];

const isMaskedCardValue = (value = '') =>
  /[*xX•·]{2,}/.test(String(value)) && /\d/.test(String(value));

const normalizeOcrLabel = (label = '') =>
  String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const parseOcrLabeledLines = (ocrText = '') => {
  const fields = {};
  for (const line of String(ocrText || '').split(/\r?\n/)) {
    const match = line.match(OCR_LABEL_LINE);
    if (!match) continue;
    const key = OCR_LABEL_WHITELIST[normalizeOcrLabel(match[1])];
    if (!key) continue; // reject unknown / corrupted OCR labels
    const value = match[2].trim();
    if (!value || value.length > 80) continue;
    if (key === 'card' && !isMaskedCardValue(value)) continue; // reject corrupted card values
    if (fields[key] === undefined) fields[key] = value;
  }
  return fields;
};

// Combined trusted OCR field set. Whitelisted labeled lines win over the regex banking parse so
// full values ("Pending activation") are kept rather than a single word ("pending").
const extractOcrFields = (ocrText = '') => ({
  ...parseOcrBankingFields(ocrText),
  ...parseOcrLabeledLines(ocrText),
});

// Rebuilds a clean "Label: Value" block from trusted fields in a stable order. Used to ground
// the response writer without ever passing raw / corrupted OCR text downstream.
const buildTrustedOcrText = (fields = {}) =>
  OCR_FIELD_ORDER.filter(
    (key) => fields[key] !== undefined && fields[key] !== null && fields[key] !== '',
  )
    .map((key) => `${OCR_FIELD_DISPLAY_LABELS[key]}: ${fields[key]}`)
    .join('\n');

// Bold-label Markdown ("**Label:** value" per line) from trusted fields, in the stable order.
// Used as a deterministic, LLM-free answer when the vision fallback is unavailable so a weak-OCR
// image still returns the fields we could read instead of a generic failure message.
const buildTrustedOcrMarkdown = (fields = {}) =>
  OCR_FIELD_ORDER.filter(
    (key) => fields[key] !== undefined && fields[key] !== null && fields[key] !== '',
  )
    .map((key) => `**${OCR_FIELD_DISPLAY_LABELS[key]}:** ${fields[key]}`)
    .join('\n');

const requestedFieldKey = (requestedField) =>
  typeof requestedField === 'string' ? requestedField : requestedField?.field;

// Returns the trusted OCR value for a requested field (via alias mapping, else a direct key
// lookup), or null. Used both to test presence and to build a deterministic field answer.
const getOcrFieldValue = (fields = {}, requestedField) => {
  const key = requestedFieldKey(requestedField);
  if (!key) return null;
  for (const [ocrKey, aliases] of Object.entries(OCR_FIELD_ALIASES)) {
    if (aliases.includes(key) && fields[ocrKey] !== undefined && fields[ocrKey] !== null && fields[ocrKey] !== '') {
      return fields[ocrKey];
    }
  }
  const direct = fields[key];
  return direct !== undefined && direct !== null && direct !== '' ? direct : null;
};

const isRequestedFieldPresent = (fields = {}, requestedField) =>
  getOcrFieldValue(fields, requestedField) !== null;

// Key fields that must ALL be present in OCR output before it is considered sufficient for a
// card / activation notice image. If any are missing, the vision model fallback must be used.
const CARD_NOTICE_REQUIRED_OCR_FIELDS = [
  'noticeId',
  'card',
  'cardType',
  'activationChannel',
  'expiry',
  'status',
  'recommendedStep',
];

// Minimum number of distinct OCR fields required when the caller did not name a specific field
// (e.g. "what is shown in this image"). A single parsed field is not a complete answer.
const OCR_MIN_FIELDS_FOR_FULL_SCAN = 3;

const isCardNoticeResource = (resourceContext = {}) => {
  const metadata = resourceContext?.resourceJson || resourceContext?.metadata || resourceContext || {};
  const title = String(metadata.title || '').toLowerCase();
  const resourceType = String(metadata.resourceType || metadata.category || '').toLowerCase();
  return (
    title.includes('card activation') ||
    title.includes('activation notice') ||
    resourceType.includes('card_activation') ||
    resourceType.includes('activation_notice')
  );
};

// OCR is sufficient when the text is readable AND:
//  - for card/activation-notice images: all seven key fields are present (otherwise fall back
//    to the vision model which reads the full image);
//  - for specific field requests: every requested field was parsed out;
//  - for general "what is shown" scans (no specific field): at least OCR_MIN_FIELDS_FOR_FULL_SCAN
//    distinct fields were found (a single field is not enough to represent a complete image).
// resourceContext is optional and used only for the card-notice specialisation.
const isOcrSufficient = (ocrResult = {}, requestedFields = [], resourceContext = {}) => {
  const text = String(ocrResult?.text || '');
  const fields = ocrResult?.fields || {};

  if (readableCharacterCount(text) < OCR_MIN_READABLE_CHARS) return false;

  // A specific field was asked for: OCR is sufficient as soon as that field (each requested field)
  // is present — there is no need to read the whole image with the vision model. This applies even
  // to card/activation notices: "what is the activation channel?" is answered from OCR if the
  // channel was read, and only falls back to vision when that field is missing.
  if (Array.isArray(requestedFields) && requestedFields.length) {
    return requestedFields.every((requestedField) => isRequestedFieldPresent(fields, requestedField));
  }

  // General "what is shown" scan of a card/activation notice (no specific field): require all key
  // fields, otherwise fall back to the vision model which reads the complete image.
  if (isCardNoticeResource(resourceContext)) {
    return CARD_NOTICE_REQUIRED_OCR_FIELDS.every(
      (key) => fields[key] !== undefined && fields[key] !== null && fields[key] !== '',
    );
  }

  return Object.keys(fields).length >= OCR_MIN_FIELDS_FOR_FULL_SCAN;
};

module.exports = {
  isImageResource,
  isPdfResource,
  isTextResource,
  isJsonResource,
  isImageRetrievalRequest,
  requiresImageContentExtraction,
  parseOcrBankingFields,
  parseOcrLabeledLines,
  extractOcrFields,
  buildTrustedOcrText,
  buildTrustedOcrMarkdown,
  getOcrFieldValue,
  isCardNoticeResource,
  isOcrSufficient,
};
