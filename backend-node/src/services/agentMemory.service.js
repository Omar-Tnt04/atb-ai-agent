const crypto = require('crypto');

const MEMORY_TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const MAX_RECENT_MESSAGES = 10;
const MAX_THREAD_MESSAGES = 100;
const MAX_RESOURCE_HISTORY = 20;
const MEMORY_TEXT_LIMIT = Number(process.env.MAX_MEMORY_TEXT_CHARS || 500);
const memories = new Map();

const nowIso = () => new Date().toISOString();

const normalizeIdPart = (value, fallback) => {
  const text = String(value || '').trim();
  return (text || fallback)
    .replace(/[^a-zA-Z0-9_.:-]/g, '_')
    .slice(0, 120);
};

const memoryKey = ({ userId, threadId }) =>
  `${normalizeIdPart(userId, 'anonymous')}::${normalizeIdPart(threadId, 'default')}`;

const hashText = (value = '') =>
  crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24);

const emptyMemory = () => ({
  recentMessages: [],
  threadMessages: [],
  resourceHistory: [],
  lastActiveResource: null,
  lastVisionResult: null,
  lastCase: null,
  lastTopic: null,
  updatedAt: nowIso(),
});

const isExpired = (item) =>
  !item?.updatedAt || Date.now() - Date.parse(item.updatedAt) > MEMORY_TTL_MS;

const cleanupExpiredMemory = () => {
  for (const [key, item] of memories.entries()) {
    if (isExpired(item)) {
      memories.delete(key);
    }
  }
};

const cleanupTimer = setInterval(cleanupExpiredMemory, CLEANUP_INTERVAL_MS);
if (typeof cleanupTimer.unref === 'function') {
  cleanupTimer.unref();
}

const redactSensitiveText = (value = '') => {
  let text = String(value || '');

  text = text.replace(/\b(?:\d[\s-]?){20,}\b/g, '[redacted-rib]');
  text = text.replace(/\b(?:\d[\s-]?){13,19}\b/g, '[redacted-card-or-account]');
  text = text.replace(/\b(sms\s+code|verification\s+code|otp|password|passcode|token|secret|code)\s*[:=]?\s*\S+/gi, '$1 [redacted]');
  text = text.replace(/\b\d{4,8}\b(?=\s*(?:is my|code|otp|sms|password|passcode)\b)/gi, '[redacted-code]');

  return text.slice(0, MEMORY_TEXT_LIMIT);
};

const sanitizeMessage = ({ role, content }) => ({
  role: role === 'assistant' ? 'assistant' : 'user',
  content: redactSensitiveText(content),
  createdAt: nowIso(),
});

const sanitizeStoredValue = (value) => {
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(sanitizeStoredValue);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/password|token|secret|sms|otp|rib|card|accountnumber/i.test(key))
        .map(([key, item]) => [key, sanitizeStoredValue(item)]),
    );
  }

  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }

  return value;
};

const SAFE_RESOURCE_KEYS = new Set([
  'resourceId',
  'resourceType',
  'title',
  'summary',
  'description',
  'category',
  'keywords',
  'language',
  'service',
  'serviceName',
  'provider',
  'status',
  'fileName',
  'category',
  'downloadId',
  'safeDownloadUrl',
  'downloadUrl',
  'card',
  'maskedCard',
  'cardNumber',
  'currentLimit',
  'availableLimit',
  'statementDate',
  'paymentDueDate',
  'minimumPayment',
  'maxAmount',
  'maximumAmount',
  'minDurationMonths',
  'maxDurationMonths',
  'duration',
  'repaymentDuration',
  'estimatedRate',
  'monthlyPaymentExample',
  'billReference',
  'billRef',
  'amount',
  'currency',
  'dueDate',
  // security-notice / advisory fields
  'recommendedAction',
  'recommendation',
  'advice',
  'topic',
  'subject',
  'riskLevel',
  'risk',
  'lastUpdate',
  'updatedAt',
  'noticeId',
  // card / activation-notice fields (image OCR + vision grounding)
  'cardType',
  'activationChannel',
  'expiry',
  'recommendedStep',
]);

const RESOURCE_FIELD_KEYS = [
  'card',
  'maskedCard',
  'cardNumber',
  'currentLimit',
  'availableLimit',
  'statementDate',
  'paymentDueDate',
  'minimumPayment',
  'maxAmount',
  'maximumAmount',
  'minDurationMonths',
  'maxDurationMonths',
  'duration',
  'repaymentDuration',
  'estimatedRate',
  'monthlyPaymentExample',
  'status',
  'billReference',
  'billRef',
  'amount',
  'currency',
  'dueDate',
  'paymentDueDate',
  'provider',
];

const FIELD_KEYWORDS_BY_TYPE = {
  card_limit_notice: [
    'available limit',
    'current limit',
    'payment due date',
    'payment due',
    'minimum payment',
    'statement date',
    'card',
  ],
  loan_offer: [
    'maximum amount',
    'amount',
    'duration',
    'monthly payment',
    'estimated rate',
    'rate',
    'pre eligible',
    'pre-eligible',
    'status',
  ],
  bill_notice: [
    'amount',
    'due date',
    'bill reference',
    'reference',
    'status',
    'paid',
    'unpaid',
  ],
  utility_bill: [
    'amount',
    'due date',
    'bill reference',
    'reference',
    'status',
    'paid',
    'unpaid',
  ],
  bill_payment: [
    'amount',
    'due date',
    'bill reference',
    'reference',
    'status',
    'paid',
    'unpaid',
  ],
};

const sanitizeResourceMetadata = (resource = {}) => {
  const metadata = resource.metadata || resource.resourceJson || resource;
  const safe = {};

  for (const key of SAFE_RESOURCE_KEYS) {
    const value = metadata?.[key] ?? resource?.[key];
    if (value === undefined || value === null || value === '') continue;
    safe[key] = value;
  }

  if (!safe.resourceId) {
    safe.resourceId = hashText([
      safe.title,
      safe.resourceType,
      safe.fileName,
    ].filter(Boolean).join('|'));
  }

  return safe;
};

const normalizeResourceType = (value = '') =>
  String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, '_')
    .trim();

const fieldLabelToKeyword = (value = '') =>
  String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const compactObject = (value = {}) =>
  Object.fromEntries(
    Object.entries(value || {})
      .filter(([, item]) => item !== undefined && item !== null && item !== '')
      .map(([key, item]) => [key, sanitizeStoredValue(item)]),
  );

const extractResourceFields = (resource = {}) => {
  const fields = {};
  for (const key of RESOURCE_FIELD_KEYS) {
    const value = resource?.[key] ?? resource?.extractedFields?.[key];
    if (value !== undefined && value !== null && value !== '') {
      fields[key] = sanitizeStoredValue(value);
    }
  }
  return fields;
};

const buildFieldKeywords = (resource = {}, extractedFields = {}) => {
  const resourceType = normalizeResourceType(resource.resourceType);
  const keywords = [
    ...(FIELD_KEYWORDS_BY_TYPE[resourceType] || []),
    ...Object.keys(extractedFields).map(fieldLabelToKeyword),
  ];

  if (resource.title) keywords.push(fieldLabelToKeyword(resource.title));
  if (resource.provider) keywords.push(fieldLabelToKeyword(resource.provider));

  return Array.from(new Set(keywords.filter(Boolean)));
};

const buildResourceHistoryEntry = (resource = {}) => {
  const safe = sanitizeResourceMetadata(resource);
  if (!safe.title && !safe.resourceId) return null;

  const extractedFields = compactObject({
    ...extractResourceFields(resource),
    ...(resource.extractedFields || {}),
  });

  return {
    resourceId: safe.resourceId,
    title: safe.title || 'Resource',
    category: safe.category || safe.resourceType || null,
    resourceType: safe.resourceType || null,
    provider: safe.provider || null,
    matchedAliases: Array.isArray(resource.matchedAliases)
      ? resource.matchedAliases.map((item) => redactSensitiveText(item)).slice(0, 10)
      : [],
    extractedFields,
    downloadId: safe.downloadId || null,
    safeDownloadUrl: safe.safeDownloadUrl || safe.downloadUrl || null,
    lastMentionedAt: nowIso(),
    fieldKeywords: buildFieldKeywords(safe, extractedFields),
  };
};

const upsertResourceHistory = (resourceHistory = [], resource = {}) => {
  const entry = buildResourceHistoryEntry(resource);
  if (!entry) return resourceHistory || [];

  const existingIndex = resourceHistory.findIndex((item) =>
    item.resourceId === entry.resourceId ||
    (item.title && entry.title && item.title === entry.title),
  );
  const nextHistory = existingIndex >= 0
    ? [
        ...resourceHistory.slice(0, existingIndex),
        {
          ...resourceHistory[existingIndex],
          ...entry,
          extractedFields: {
            ...(resourceHistory[existingIndex].extractedFields || {}),
            ...entry.extractedFields,
          },
          fieldKeywords: Array.from(new Set([
            ...(resourceHistory[existingIndex].fieldKeywords || []),
            ...entry.fieldKeywords,
          ])),
          lastMentionedAt: nowIso(),
        },
        ...resourceHistory.slice(existingIndex + 1),
      ]
    : [entry, ...(resourceHistory || [])];

  return nextHistory
    .sort((a, b) => Date.parse(b.lastMentionedAt || 0) - Date.parse(a.lastMentionedAt || 0))
    .slice(0, MAX_RESOURCE_HISTORY);
};

const sanitizeVisionResult = (value = {}) => {
  const ai = value.data?.ai || value.ai || value;
  const extractedFields = ai.extractedFields && typeof ai.extractedFields === 'object'
    ? ai.extractedFields
    : {};
  const toolInput = ai.toolInput && typeof ai.toolInput === 'object'
    ? ai.toolInput
    : {};
  const evidence = [];

  if (ai.evidence_text || extractedFields.evidence_text) {
    evidence.push({
      page: ai.page || extractedFields.page || toolInput.page || null,
      text: redactSensitiveText(ai.evidence_text || extractedFields.evidence_text),
    });
  }

  if (Array.isArray(extractedFields.evidence)) {
    extractedFields.evidence.forEach((item) => {
      if (!item) return;
      evidence.push({
        page: item.page || null,
        text: redactSensitiveText(item.text || item.evidence_text || item),
      });
    });
  }

  return {
    documentSummary: redactSensitiveText(
      ai.documentSummary ||
      toolInput.documentSummary ||
      ai.assistantMessage ||
      value.assistantMessage ||
      '',
    ),
    pageSummaries: Array.isArray(toolInput.pageSummaries)
      ? sanitizeStoredValue(toolInput.pageSummaries.slice(0, 10))
      : Array.isArray(extractedFields.pageSummaries)
        ? sanitizeStoredValue(extractedFields.pageSummaries.slice(0, 10))
        : [],
    extractedFields: {
      ...Object.fromEntries(
        Object.entries(extractedFields)
          .filter(([key, item]) =>
            !/password|token|secret|sms|otp|rib|card|accountnumber/i.test(key) &&
            item !== undefined &&
            item !== null,
          )
          .slice(0, 30)
          .map(([key, item]) => [key, sanitizeStoredValue(item)]),
      ),
    },
    evidence: evidence.slice(0, 10),
    confidence: Number.isFinite(ai.confidence) ? ai.confidence : 0,
    updatedAt: nowIso(),
  };
};

const getAgentMemory = ({ userId, threadId }) => {
  cleanupExpiredMemory();

  const key = memoryKey({ userId, threadId });
  const existing = memories.get(key);
  if (existing && !isExpired(existing)) {
    return existing;
  }

  const memory = emptyMemory();
  memories.set(key, memory);
  return memory;
};

const updateAgentMemory = ({
  userId,
  threadId,
  userMessage,
  assistantMessage,
  lastActiveResource,
  lastVisionResult,
  lastCase,
  lastTopic,
} = {}) => {
  const memory = getAgentMemory({ userId, threadId });
  memory.recentMessages = Array.isArray(memory.recentMessages) ? memory.recentMessages : [];
  memory.threadMessages = Array.isArray(memory.threadMessages) ? memory.threadMessages : [];
  memory.resourceHistory = Array.isArray(memory.resourceHistory) ? memory.resourceHistory : [];

  if (userMessage) {
    const sanitized = sanitizeMessage({ role: 'user', content: userMessage });
    memory.recentMessages.push(sanitized);
    memory.threadMessages.push(sanitized);
  }
  if (assistantMessage) {
    const sanitized = sanitizeMessage({ role: 'assistant', content: assistantMessage });
    memory.recentMessages.push(sanitized);
    memory.threadMessages.push(sanitized);
  }

  memory.recentMessages = memory.recentMessages.slice(-MAX_RECENT_MESSAGES);
  memory.threadMessages = memory.threadMessages.slice(-MAX_THREAD_MESSAGES);

  if (lastActiveResource) {
    memory.lastActiveResource = sanitizeResourceMetadata(lastActiveResource);
    memory.resourceHistory = upsertResourceHistory(
      memory.resourceHistory || [],
      lastActiveResource,
    );
  }
  void lastVisionResult;
  if (lastCase) {
    memory.lastCase = lastCase;
  }
  if (lastTopic !== undefined) {
    memory.lastTopic = redactSensitiveText(lastTopic);
  }

  memory.updatedAt = nowIso();
  memories.set(memoryKey({ userId, threadId }), memory);
  return memory;
};

const getPdfVisionCache = () => null;

const setPdfVisionCache = () => null;

const resetAgentMemoryForTests = () => {
  memories.clear();
};

module.exports = {
  MAX_RECENT_MESSAGES,
  MAX_RESOURCE_HISTORY,
  MAX_THREAD_MESSAGES,
  buildResourceHistoryEntry,
  getAgentMemory,
  getPdfVisionCache,
  redactSensitiveText,
  resetAgentMemoryForTests,
  sanitizeResourceMetadata,
  sanitizeVisionResult,
  setPdfVisionCache,
  upsertResourceHistory,
  updateAgentMemory,
};
