const { matchResourceAlias } = require('./resourceAlias.service');
const { isCapabilitiesQuestion } = require('./resourceAnswer.service');

const CASES = Object.freeze({
  NORMAL_CHAT: 'normal_chat',
  GENERAL_NATURAL_CHAT: 'general_natural_chat',
  RESOURCE_MEMORY_FOLLOWUP: 'resource_memory_followup',
  LARAGON_RESOURCE_METADATA: 'laragon_resource_metadata',
  LARAGON_PDF_VISION: 'laragon_pdf_vision',
  PDF_FOLLOWUP: 'pdf_followup',
  SPECIFIC_PDF_DETAIL: 'specific_pdf_detail',
  EXPLICIT_PAGE_QUESTION: 'explicit_page_question',
  BANKING_ACTION: 'banking_action',
  RESOURCE_DOWNLOAD: 'resource_download',
  MEMORY_CONTINUE: 'memory_continue',
  UNSAFE_REQUEST: 'unsafe_request',
});

const normalizeText = (value = '') =>
  String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const unique = (values) => Array.from(new Set(values.filter(Boolean)));

const FOLLOWUP_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'can',
  'could',
  'do',
  'does',
  'for',
  'from',
  'have',
  'how',
  'i',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'please',
  'show',
  'tell',
  'the',
  'this',
  'to',
  'what',
  'when',
  'where',
  'which',
  'with',
]);

const VAGUE_MEMORY_FOLLOWUP_PATTERNS = [
  /\bshow\s+more\b/,
  /\bdownload\s+(it|that|this)\b/,
  /\bwhat\s+about\s+(it|that|this)\b/,
  /\bcontinue\b/,
  /\bconfirm\s+that\b/,
  /\bopen\s+(it|that|this)\b/,
  /\bfrom\s+(there|that|it)\b/,
  /\bsame\s+(document|pdf|resource|topic)\b/,
];

const meaningfulWords = (message = '') =>
  normalizeText(message)
    .split(/\s+/)
    .filter((word) => word.length > 2 && !FOLLOWUP_STOPWORDS.has(word));

const hasGenericNewTargetPhrase = (message = '') => {
  const text = normalizeText(message);
  const match = text.match(/\b(?:my|the|this|for|about|related\s+to)\s+([a-z0-9][a-z0-9\s]{5,})/);
  if (!match?.[1]) return false;

  return match[1]
    .split(/\s+/)
    .filter((word) => word.length > 2 && !FOLLOWUP_STOPWORDS.has(word))
    .length >= 3;
};

const hasClearNewResourceTarget = (message = '') => {
  const text = normalizeText(message);
  if (!text) return false;

  if (VAGUE_MEMORY_FOLLOWUP_PATTERNS.some((pattern) => pattern.test(text))) {
    return false;
  }

  return meaningfulWords(message).length >= 4 || hasGenericNewTargetPhrase(message);
};

const extractExplicitPage = (message = '') => {
  const text = normalizeText(message);
  const match =
    text.match(/\bpage\s+(\d{1,3})\b/) ||
    text.match(/\bp\.\s*(\d{1,3})\b/) ||
    text.match(/\bon\s+page\s+(\d{1,3})\b/);

  if (!match) return null;

  const page = Number(match[1]);
  return Number.isInteger(page) && page > 0 ? page : null;
};

const hasMemoryResource = (memoryContext = {}) =>
  Boolean(memoryContext?.lastActiveResource?.title || memoryContext?.lastActiveResource?.resourceId);

const hasMemoryVision = (memoryContext = {}) =>
  Boolean(memoryContext?.lastVisionResult?.documentSummary || memoryContext?.lastVisionResult?.evidence?.length);

const memoryResourceText = (memoryContext = {}) =>
  normalizeText([
    memoryContext?.lastActiveResource?.title,
    memoryContext?.lastActiveResource?.resourceType,
    memoryContext?.lastActiveResource?.provider,
  ].filter(Boolean).join(' '));

const resourceEntryText = (entry = {}) =>
  normalizeText([
    entry.title,
    entry.category,
    entry.resourceType,
    entry.provider,
    ...(entry.matchedAliases || []),
  ].filter(Boolean).join(' '));

const isUnsafeRequest = (message = '') => {
  const text = normalizeText(message);

  return (
    /\bignore\s+(all\s+)?(previous|prior|system|developer|safety|security|bank|backend)\s+(rules|instructions|policies)\b/.test(text) ||
    /\b(bypass|disable|override)\s+(security|safety|verification|sms|confirmation|auth|authentication|authorization)\b/.test(text) ||
    /\b(show|reveal|give|access|fetch|view)\b.{0,60}\b(another|other|someone else|different)\s+user/.test(text) ||
    /\b(another|other|someone else|different)\s+user\b.{0,60}\b(balance|account|rib|card|password|token|secret)\b/.test(text) ||
    /\b(show|reveal|give)\b.{0,40}\b(password|token|secret|sms code|otp)\b/.test(text)
  );
};

const isDownloadRequest = (message = '') => {
  const text = normalizeText(message);
  return (
    /\b(download|export|send|get|fetch)\b/.test(text) &&
    /\b(pdf|document|file|form|guide|sheet|policy)\b/.test(text)
  );
};

const isBankingActionRequest = (message = '') => {
  const text = normalizeText(message);

  if (/\b(pdf|document|resource|guide|form|policy|sheet)\b/.test(text) &&
      /\b(explain|what|which|summarize|summary|details?|required|fees?|duration)\b/.test(text)) {
    return false;
  }

  return (
    /\btransfer\b.{0,80}\b\d/.test(text) ||
    /\bsend\b.{0,80}\b\d/.test(text) ||
    /\bpay\b.{0,60}\b(bill|invoice|steg|sonede|telecom|ooredoo|orange)\b/.test(text) ||
    /\b(book|schedule|reserve)\b.{0,50}\b(appointment|meeting|visit)\b/.test(text) ||
    /\b(create|submit|open|file)\b.{0,50}\b(complaint|claim|dispute)\b/.test(text) ||
    /\b(show|check|get|view)\b.{0,40}\b(my\s+)?balance\b/.test(text) ||
    /\b(generate|create)\b.{0,40}\b(statement|certificate|document)\b/.test(text)
  );
};

const RESOURCE_TOPIC_PATTERNS = [
  /\bpersonal\s+loan(s)?\b/,
  /\bcar\s+loan(s)?\b/,
  /\bauto\s+loan(s)?\b/,
  /\bhome\s+loan(s)?\b/,
  /\bstudent\s+(pack|loan|offer)\b/,
  /\bloan(s)?\b/,
  /\bcredit\b/,
  /\brib\b/,
  /\batb\s+connect\b/,
  /\bcard\s+(limit|replacement|dispute|pickup)\b/,
  /\bcheckbook\b/,
  /\bchequebook\b/,
  /\bcomplaint\b/,
  /\bappointment\b/,
  /\bbranch(es)?\b/,
  /\bfees?\b/,
  /\bstatement\b/,
  /\bcertificate\b/,
  /\binsurance\b/,
  /\btax\b/,
];

const inferResourceHint = (message = '', memoryContext = {}) => {
  const text = normalizeText(message);
  const aliasMatch = matchResourceAlias(message);

  if (aliasMatch?.title) {
    return aliasMatch.title;
  }

  const explicitPdfMatch =
    text.match(/\b(?:in|from|inside|open|download)\s+(?:the\s+)?(.{3,80}?)\s+(?:pdf|document|resource|file)\b/) ||
    text.match(/\b(?:the\s+)?(.{3,80}?)\s+(?:pdf|document|resource|file)\b/);

  if (explicitPdfMatch?.[1]) {
    return explicitPdfMatch[1].replace(/\b(the|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim();
  }

  for (const pattern of RESOURCE_TOPIC_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[0]) return match[0].trim();
  }

  if (hasMemoryResource(memoryContext)) {
    return memoryContext.lastActiveResource.title || memoryContext.lastActiveResource.resourceType || null;
  }

  return null;
};

const DETAIL_KEYWORDS = [
  'required',
  'document',
  'documents',
  'fee',
  'fees',
  'charges',
  'pricing',
  'repayment',
  'duration',
  'maximum',
  'minimum',
  'eligibility',
  'condition',
  'conditions',
  'rate',
  'interest',
  'deadline',
  'amount',
  'limit',
  'steps',
  'how',
  'explain',
  'what',
  'which',
];

const hasDetailQuestion = (message = '') => {
  const text = normalizeText(message);
  return (
    /\?/.test(String(message || '')) ||
    DETAIL_KEYWORDS.some((keyword) => new RegExp(`\\b${keyword}\\b`).test(text)) ||
    /\bwhat\s+about\b/.test(text)
  );
};

const extractDetailHint = (message = '') => {
  const text = normalizeText(message);
  const afterQuestion =
    text.match(/\bwhat\s+(?:is|are)\s+(.*)$/)?.[1] ||
    text.match(/\bwhich\s+(.*)$/)?.[1] ||
    text.match(/\bexplain\s+(.*)$/)?.[1] ||
    text.match(/\bwhat\s+about\s+(.*)$/)?.[1];

  if (afterQuestion) {
    return afterQuestion.replace(/\b(in|from|the|a|an|pdf|document)\b/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const hints = DETAIL_KEYWORDS.filter((keyword) =>
    new RegExp(`\\b${keyword}\\b`).test(text),
  );
  return unique(hints).slice(0, 4).join(' ') || null;
};

const isMetadataQuestion = (message = '') => {
  const text = normalizeText(message);
  return (
    /\b(do you have|available|information about|info about|tell me about|resources? about|find.*information|show me|show|open|display)\b/.test(text) &&
    !/\b(required|documents?|fees?|charges|repayment|duration|maximum|minimum|page)\b/.test(text)
  );
};

const isGeneralNaturalQuestion = (message = '') => {
  const text = normalizeText(message);
  if (!text || isCapabilitiesQuestion(message)) return false;

  return (
    /\?/.test(String(message || '')) ||
    /^(what|how|why|when|where|can|could|should|would|do|does|is|are)\b/.test(text) ||
    /^(explain|describe|tell\s+me|help\s+me\s+understand)\b/.test(text)
  );
};

const isAliasMetadataRequest = (message = '') => {
  const text = normalizeText(message);
  if (!matchResourceAlias(message)) return false;

  return /\b(show|open|display|get|find|do you have|information about|info about|tell me about)\b/.test(text);
};

const isMemoryContinue = (message = '', memoryContext = {}) => {
  const text = normalizeText(message);
  if (!hasMemoryResource(memoryContext) && !hasMemoryVision(memoryContext)) return false;

  return (
    /\bcontinue\b/.test(text) ||
    /\b(from|with)\s+(there|that|it)\b/.test(text) ||
    /\bsame\s+(document|pdf|resource|topic)\b/.test(text) ||
    /\btell\s+me\s+more\b/.test(text)
  );
};

const hasResourceReferenceMarker = (message = '') => {
  const text = normalizeText(message);
  return (
    /\b(it|this|that|there)\b/.test(text) ||
    /\bthe\s+(document|notice|pdf|previous\s+one)\b/.test(text) ||
    /\bcontinue\b/.test(text) ||
    /\bexplain\s+page\b/.test(text) ||
    /\bwhat\s+about\b/.test(text)
  );
};

const hasLastResourceFieldReference = (message = '', memoryContext = {}) => {
  if (!hasMemoryResource(memoryContext)) return false;

  const text = normalizeText(message);
  const resourceText = memoryResourceText(memoryContext);
  const hasAny = (patterns) => patterns.some((pattern) => pattern.test(text));

  if (resourceText.includes('credit card limit') || resourceText.includes('card_limit_notice')) {
    return hasAny([
      /\bavailable\s+limit\b/,
      /\bcurrent\s+limit\b/,
      /\bpayment\s+due\s+date\b/,
      /\bminimum\s+payment\b/,
      /\bstatement\s+date\b/,
      /\b(card\s+number|masked\s+card)\b/,
      /^(what|which)\s+(is\s+)?(the\s+)?card\b/,
    ]);
  }

  if (resourceText.includes('personal loan offer') || resourceText.includes('loan_offer')) {
    return hasAny([
      /\bmaximum\s+amount\b/,
      /\bduration\b/,
      /\bmonthly\s+payment\b/,
      /\bestimated\s+rate\b/,
      /\bpre\s+eligible\b/,
    ]);
  }

  if (resourceText.includes('sonede') || resourceText.includes('bill_notice') || resourceText.includes('bill payment')) {
    return hasAny([
      /\bamount\b/,
      /\bdue\s+date\b/,
      /\bbill\s+reference\b/,
      /\bstatus\b/,
      /\bpaid\b/,
      /\bunpaid\b/,
    ]);
  }

  return false;
};

const REQUESTED_FIELD_PATTERNS = [
  { field: 'availableLimit', label: 'available limit', patterns: [/\bavailable\s+limit\b/] },
  { field: 'currentLimit', label: 'current limit', patterns: [/\bcurrent\s+limit\b/] },
  { field: 'paymentDueDate', label: 'payment due date', patterns: [/\bpayment\s+due(?:\s+date)?\b/, /\bdue\s+date\b/] },
  { field: 'minimumPayment', label: 'minimum payment', patterns: [/\bminimum\s+payment\b/] },
  { field: 'statementDate', label: 'statement date', patterns: [/\bstatement\s+date\b/] },
  { field: 'card', label: 'card', patterns: [/\b(card\s+number|masked\s+card)\b/, /^(what|which)\s+(is\s+)?(the\s+)?card\b/] },
  { field: 'maxAmount', label: 'maximum amount', patterns: [/\bmaximum\s+amount\b/] },
  { field: 'duration', label: 'duration', patterns: [/\bduration\b/] },
  { field: 'monthlyPaymentExample', label: 'monthly payment', patterns: [/\bmonthly\s+payment\b/] },
  { field: 'estimatedRate', label: 'estimated rate', patterns: [/\bestimated\s+rate\b/] },
  { field: 'status', label: 'status', patterns: [/\bpre\s+eligible\b/, /\bpreeligible\b/, /\bstatus\b/, /\bpaid\b/, /\bunpaid\b/] },
  { field: 'amount', label: 'amount', patterns: [/\bamount\b/] },
  { field: 'dueDate', label: 'due date', patterns: [/\bdue\s+date\b/] },
  { field: 'billReference', label: 'bill reference', patterns: [/\bbill\s+reference\b/, /\breference\b/] },
];

const FIELD_ALIASES = {
  availableLimit: ['availableLimit'],
  currentLimit: ['currentLimit'],
  paymentDueDate: ['paymentDueDate', 'dueDate'],
  minimumPayment: ['minimumPayment'],
  statementDate: ['statementDate'],
  card: ['card', 'maskedCard', 'cardNumber'],
  maxAmount: ['maxAmount', 'maximumAmount', 'amount'],
  duration: ['duration', 'repaymentDuration', 'minDurationMonths', 'maxDurationMonths'],
  monthlyPaymentExample: ['monthlyPaymentExample', 'exampleMonthlyPayment', 'monthlyPayment'],
  estimatedRate: ['estimatedRate', 'rate', 'interestRate'],
  status: ['status'],
  amount: ['amount', 'totalAmount', 'amountDue', 'total', 'maxAmount', 'maximumAmount', 'loanAmount'],
  dueDate: ['dueDate', 'paymentDueDate', 'deadline'],
  billReference: ['billReference', 'billRef', 'invoiceReference', 'reference'],
};

const getEntryFieldValue = (entry = {}, requestedField = '') => {
  const fields = entry.extractedFields || {};
  for (const key of FIELD_ALIASES[requestedField] || [requestedField]) {
    const value = fields[key] ?? entry[key];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return null;
};

const detectRequestedResourceFields = (message = '') => {
  const text = normalizeText(message);
  return REQUESTED_FIELD_PATTERNS
    .filter((item) => item.patterns.some((pattern) => pattern.test(text)))
    .map((item) => ({ field: item.field, label: item.label }));
};

const scoreResourceHistoryEntry = (entry = {}, message = '', requestedFields = []) => {
  const text = normalizeText(message);
  const entryText = resourceEntryText(entry);
  const fieldKeywords = (entry.fieldKeywords || []).map(normalizeText);
  let score = 0;
  let exactFieldMatches = 0;

  for (const requested of requestedFields) {
    const hasField = getEntryFieldValue(entry, requested.field) !== null;
    if (hasField) {
      score += 20;
      exactFieldMatches += 1;
    }
    if (fieldKeywords.some((keyword) => keyword && (text.includes(keyword) || keyword.includes(requested.label)))) {
      score += 8;
    }
  }

  const queryTokens = text.split(/\s+/).filter((token) => token.length >= 4);
  for (const token of queryTokens) {
    if (entryText.includes(token)) score += 4;
    if (fieldKeywords.some((keyword) => keyword.includes(token))) score += 2;
  }

  const recencyMs = Date.parse(entry.lastMentionedAt || 0);
  if (Number.isFinite(recencyMs)) {
    score += Math.max(0, Math.min(6, Math.round((recencyMs || 0) / 1_000_000_000_000)));
  }

  return {
    entry,
    score,
    exactFieldMatches,
  };
};

const findResourceHistoryFollowup = (message = '', memoryContext = {}) => {
  const resourceHistory = Array.isArray(memoryContext.resourceHistory)
    ? memoryContext.resourceHistory
    : [];
  if (!resourceHistory.length) return null;
  if (hasClearNewResourceTarget(message)) return null;

  const requestedFields = detectRequestedResourceFields(message);
  if (!requestedFields.length && !hasResourceReferenceMarker(message)) return null;

  const scored = resourceHistory
    .map((entry) => scoreResourceHistoryEntry(entry, message, requestedFields))
    .filter((item) => item.score > 0 && (requestedFields.length ? item.exactFieldMatches > 0 : true))
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return null;

  const exactCandidates = requestedFields.length
    ? scored.filter((item) => item.exactFieldMatches > 0)
    : scored;
  const topScore = exactCandidates[0]?.score || 0;
  const ambiguousCandidates = exactCandidates.filter((item) =>
    item.score >= topScore - 2,
  );

  if (ambiguousCandidates.length > 1) {
    return {
      ambiguous: true,
      requestedFields,
      candidates: ambiguousCandidates.slice(0, 4).map((item) => item.entry),
    };
  }

  return {
    ambiguous: false,
    requestedFields,
    entry: exactCandidates[0].entry,
  };
};

const isTrueResourceFollowup = (message = '', memoryContext = {}) => {
  if (!hasMemoryResource(memoryContext) && !hasMemoryVision(memoryContext)) return false;

  return (
    hasResourceReferenceMarker(message) ||
    hasLastResourceFieldReference(message, memoryContext)
  );
};

const isPdfFollowup = (message = '', memoryContext = {}) => {
  const text = normalizeText(message);
  if (!hasMemoryResource(memoryContext)) return false;
  if (!isTrueResourceFollowup(message, memoryContext)) return false;
  if (inferResourceHint(message, {}) && !/\bwhat\s+about\b/.test(text)) return false;

  return (
    /\bwhat\s+about\b/.test(text) ||
    /\b(and\s+)?(the\s+)?(fees?|charges|duration|requirements?|documents?|rate|conditions?)\b/.test(text) ||
    (hasDetailQuestion(message) && text.split(/\s+/).length <= 8)
  );
};

const buildDecision = ({
  caseName,
  modelMode = 'text',
  needsResourceSearch = false,
  needsPdfVision = false,
  needsActionFlow = false,
  needsMemory = true,
  resourceHint = null,
  detailHint = null,
  explicitPage = null,
  safetyDecision = 'allowed',
  resourceMemoryMatch = null,
  reason,
}) => ({
  case: caseName,
  modelMode,
  needsResourceSearch,
  needsPdfVision,
  needsActionFlow,
  needsMemory,
  resourceHint,
  detailHint,
  explicitPage,
  safetyDecision,
  resourceMemoryMatch,
  reason,
});

const routeAgentCase = ({ message, memoryContext = {} } = {}) => {
  const text = normalizeText(message);
  const explicitPage = extractExplicitPage(message);
  const trueResourceFollowup = isTrueResourceFollowup(message, memoryContext);
  const resourceHint = inferResourceHint(message, trueResourceFollowup ? memoryContext : {});
  const detailHint = extractDetailHint(message);
  const resourceHistoryMatch = findResourceHistoryFollowup(message, memoryContext);

  if (isUnsafeRequest(message)) {
    return buildDecision({
      caseName: CASES.UNSAFE_REQUEST,
      modelMode: 'text',
      needsResourceSearch: false,
      needsPdfVision: false,
      needsActionFlow: false,
      needsMemory: false,
      resourceHint: null,
      detailHint: null,
      safetyDecision: 'refuse',
      reason: 'The user asks to bypass safety or access another user or secret data.',
    });
  }

  if (isBankingActionRequest(message)) {
    return buildDecision({
      caseName: CASES.BANKING_ACTION,
      modelMode: 'text',
      needsResourceSearch: false,
      needsPdfVision: false,
      needsActionFlow: true,
      resourceHint: null,
      detailHint,
      reason: 'The user asks the backend to prepare a banking action.',
    });
  }

  if (isDownloadRequest(message)) {
    return buildDecision({
      caseName: CASES.RESOURCE_DOWNLOAD,
      modelMode: 'text',
      needsResourceSearch: true,
      needsPdfVision: false,
      resourceHint,
      detailHint,
      reason: 'The user asks to download a resource rather than analyze its content.',
    });
  }

  if (resourceHint && isAliasMetadataRequest(message)) {
    return buildDecision({
      caseName: CASES.LARAGON_RESOURCE_METADATA,
      modelMode: 'text',
      needsResourceSearch: true,
      needsPdfVision: false,
      resourceHint,
      detailHint,
      reason: 'The user asks for a known Laragon resource by title or alias.',
    });
  }

  if (/\bpdf\b|\bdocument\b|\bresource\b|\bfile\b/.test(text) && resourceHint && hasDetailQuestion(message)) {
    return buildDecision({
      caseName: CASES.SPECIFIC_PDF_DETAIL,
      modelMode: 'vision',
      needsResourceSearch: true,
      needsPdfVision: true,
      resourceHint,
      detailHint,
      reason: 'The user asks for a specific detail from a named PDF resource.',
    });
  }

  if (explicitPage && trueResourceFollowup) {
    return buildDecision({
      caseName: CASES.EXPLICIT_PAGE_QUESTION,
      modelMode: 'vision',
      needsResourceSearch: Boolean(resourceHint && !hasMemoryResource(memoryContext)),
      needsPdfVision: true,
      resourceHint,
      detailHint: detailHint || `page ${explicitPage}`,
      explicitPage,
      reason: 'The user asks about an explicit page in the active PDF/resource.',
    });
  }

  if (isMemoryContinue(message, memoryContext)) {
    return buildDecision({
      caseName: CASES.MEMORY_CONTINUE,
      modelMode: 'text',
      needsResourceSearch: false,
      needsPdfVision: false,
      resourceHint,
      detailHint,
      reason: 'The user wants to continue from backend memory.',
    });
  }

  if (resourceHistoryMatch) {
    const matchedEntry = resourceHistoryMatch.entry || resourceHistoryMatch.candidates?.[0] || null;
    return buildDecision({
      caseName: CASES.RESOURCE_MEMORY_FOLLOWUP,
      modelMode: 'text',
      needsResourceSearch: false,
      needsPdfVision: false,
      resourceHint: matchedEntry?.title || resourceHint,
      detailHint,
      resourceMemoryMatch: resourceHistoryMatch,
      reason: resourceHistoryMatch.ambiguous
        ? 'The user asks about a field found on multiple remembered resources.'
        : 'The user asks about a field found in resource history.',
    });
  }

  if (isPdfFollowup(message, memoryContext) || (trueResourceFollowup && hasLastResourceFieldReference(message, memoryContext))) {
    return buildDecision({
      caseName: CASES.PDF_FOLLOWUP,
      modelMode: 'text',
      needsResourceSearch: false,
      needsPdfVision: false,
      resourceHint,
      detailHint,
      reason: 'The user asks a follow-up about the last active PDF resource.',
    });
  }

  if (resourceHint && isMetadataQuestion(message)) {
    return buildDecision({
      caseName: CASES.LARAGON_RESOURCE_METADATA,
      modelMode: 'text',
      needsResourceSearch: true,
      needsPdfVision: false,
      resourceHint,
      detailHint,
      reason: 'The user asks whether metadata-level Laragon resources are available.',
    });
  }

  if (isGeneralNaturalQuestion(message)) {
    return buildDecision({
      caseName: CASES.GENERAL_NATURAL_CHAT,
      modelMode: 'text',
      needsResourceSearch: false,
      needsPdfVision: false,
      needsActionFlow: false,
      resourceHint: null,
      detailHint,
      reason: 'The user asks a natural question that does not require resource lookup, PDF vision, or action flow.',
    });
  }

  if (resourceHint && hasDetailQuestion(message) && !isMetadataQuestion(message)) {
    return buildDecision({
      caseName: CASES.LARAGON_PDF_VISION,
      modelMode: 'vision',
      needsResourceSearch: true,
      needsPdfVision: true,
      resourceHint,
      detailHint,
      reason: 'The user asks for content that may require reading a matching PDF.',
    });
  }

  return buildDecision({
    caseName: CASES.NORMAL_CHAT,
    modelMode: 'text',
    needsResourceSearch: false,
    needsPdfVision: false,
    needsActionFlow: false,
    resourceHint: null,
    detailHint: null,
    reason: 'The request does not require resource lookup, PDF vision, or action flow.',
  });
};

module.exports = {
  CASES,
  extractExplicitPage,
  findResourceHistoryFollowup,
  hasClearNewResourceTarget,
  isTrueResourceFollowup,
  routeAgentCase,
};
