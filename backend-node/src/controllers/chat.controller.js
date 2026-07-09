const fs = require('fs/promises');
const { randomUUID } = require('crypto');
const sharp = require('sharp');
const {
  getConnectedActionsByRole,
} = require('../actions/actionRegistry');
const env = require('../config/env');
const { selectModel } = require('../config/modelRouting');
const { confirmAction, executeAction } = require('../services/actionExecution.service');
const { prepareAction } = require('../services/actionPreparation.service');
const {
  analyzeMessage,
  analyzeVisionDocument,
  // NOTE: answerFromDescriptions (/agent/answer-from-descriptions) is intentionally NOT imported.
  // It answers freely from full catalog descriptions and is NOT part of the trusted banking answer
  // path. Descriptions are used for retrieval/selection only; answers come from trusted files +
  // fact extraction + reformulation + deterministic fallback. Do not reintroduce it here.
  decideMessage,
  planIntent,
  reformulateAnswer,
  rerankResources,
} = require('../services/aiClient.service');
const { createAuditLog } = require('../services/auditLog.service');
const { buildFileContext } = require('../services/fileContext.service');
const {
  isImageRetrievalRequest,
  requiresImageContentExtraction,
  buildTrustedOcrText,
  buildTrustedOcrMarkdown,
  getOcrFieldValue,
} = require('../services/imageRequestRouting.service');
const { generateFile } = require('../services/generatedFile.service');
const mockBeneficiaries = require('../data/mockBeneficiaries');
const {
  RESOURCE_JSON_BASE_URL,
  ResourceCatalogUnavailableError,
  findMatchingResources,
  normalizeResourceSearchQuery,
  selectCatalogFile,
} = require('../services/resourceCatalog.service');
const {
  resolveResource,
  resolveResourcePayload,
} = require('../services/resourceResolver.service');
const { createResourceDownload, createResourceView } = require('../services/resourceDownload.service');
const {
  CASES,
  detectRequestedResourceFields,
  hasClearNewResourceTarget,
  hasResourceObjectDetected,
  isComplaintStatusEligible,
  routeAgentCase,
} = require('../services/agentCaseRouter.service');
const {
  getAgentMemory,
  sanitizeResourceMetadata,
  updateAgentMemory,
} = require('../services/agentMemory.service');
const { selectPdfPages } = require('../services/pdfPageSelection.service');
const {
  buildFallbackAssistantMessage,
  buildGeneralBankingFallbackAnswer,
  buildMetadataFirstAnswer,
  buildSpecificResourceAnswer,
  buildBranchAnswerFromFacts,
  describeBranchMatch,
  extractBranchFacts,
  buildResourceFollowupAnswer,
  extractBillPaymentFields,
  isCapabilitiesQuestion,
  isGeneralBankingFallbackQuestion,
  isGenericCapabilitiesResponse,
  isMetadataAnswerLikelyEnough,
  isAlreadyPaidOrReceiptResource,
} = require('../services/resourceAnswer.service');
const {
  appearsToNeedResourceLookup,
  buildPlannerParseFallbackDecision,
  buildPlannerRouterDecision,
  isResourceRetrievalDownloadRequest,
  normalizePlannerDecision,
  plannerDecisionToAiDecision,
} = require('../services/intentPlanner.service');
const {
  endTimer,
  logArchitecture,
  logError,
  messagePreview,
  startTimer,
} = require('../services/architectureLogger.service');
const {
  detectResourceHints,
  logAgentStep,
  safeMetadata,
  truncate,
} = require('../services/agentLogger.service');
const { traceRoute, isVerboseRequestLog } = require('../services/routeTrace.service');
const { stepLog: _stepLog, isDemoMode: _isDemoMode } = require('../utils/demoLogger');

const escapeRegExp = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isWidgetChatRequest = (req = {}) =>
  String(req.originalUrl || req.path || '').startsWith('/api/widget/chat');

const WIDGET_FILE_ANALYSIS_FORBIDDEN_TEXT = [
  'I received the uploaded file',
  'could not extract readable text',
  'provide the key details manually',
];

const containsWidgetFileAnalysisText = (value = '') => {
  const text = String(value || '').toLowerCase();
  return WIDGET_FILE_ANALYSIS_FORBIDDEN_TEXT.some((item) =>
    text.includes(item.toLowerCase()),
  );
};

const getWidgetBlockedFileAnalysisReason = (value = {}) => {
  const ai = value?.data?.ai || value?.ai || value || {};
  const routerDecision = value?.data?.routerDecision || value?.routerDecision || {};
  const fields = [
    ai.responseIntent,
    ai.mode,
    ai.selectedCase,
    ai.responseType,
    ai.agentMode,
    ai.intent,
    value.responseIntent,
    value.mode,
    value.selectedCase,
    value.responseType,
    value.agentMode,
    value.status,
    routerDecision.case,
    routerDecision.selectedCase,
  ];

  if (fields.some((field) => String(field || '').toLowerCase() === 'file_analysis')) {
    return 'file_analysis';
  }

  if (
    containsWidgetFileAnalysisText(value.assistantMessage) ||
    containsWidgetFileAnalysisText(value.message) ||
    containsWidgetFileAnalysisText(ai.assistantMessage)
  ) {
    return 'uploaded_file_fallback_text';
  }

  return null;
};

const isStatusQuestion = (message = '') =>
  /\bstatus\b/i.test(String(message || ''));

const extractSourceAccountIdFromMessage = (message = '') => {
  const match = normalizeText(message).match(/\bacc\s*_?\s*(\d{3,})\b/);
  return match?.[1] ? `acc_${match[1]}` : null;
};
const RESOURCE_JSON_URL_PATTERN = new RegExp(
  `${escapeRegExp(RESOURCE_JSON_BASE_URL)}/[^\\s<>"')]+`,
  'i',
);

const toAiAction = (action) => ({
  name: action.name,
  riskLevel: action.riskLevel,
  requiredFields: action.requiredFields,
});

const getAvailableAiActions = (role) =>
  getConnectedActionsByRole(role).map(toAiAction);

const extractResourceJsonUrl = (value) => {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    const match = value.match(RESOURCE_JSON_URL_PATTERN);
    return match ? match[0] : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nestedUrl = extractResourceJsonUrl(item);
      if (nestedUrl) return nestedUrl;
    }
    return null;
  }

  if (typeof value === 'object') {
    for (const item of Object.values(value)) {
      const nestedUrl = extractResourceJsonUrl(item);
      if (nestedUrl) return nestedUrl;
    }
  }

  return null;
};

const normalizeText = (value = '') =>
  String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeResourceType = (value = '') =>
  normalizeText(value).replace(/\s+/g, '_');

const RESOURCE_NOT_FOUND_MESSAGE =
  'I could not find a matching resource for that request in the resource server.';

const RESOURCE_NOT_FOUND_OPTIONS = [
  'Account statement',
  'RIB certificate',
  'Receipt',
  'Appointment',
  'Complaint',
  'Branch directory',
].map((label) => ({
  label,
  value: label,
  action: 'prompt',
  prompt: label,
}));

const RESPONSE_WRITER_INSTRUCTION =
  'You are ATB digital banking assistant writing the final user-facing answer. Use only agentContext.resourceResponseWriter, which is compact trusted JSON extracted by the backend from the actual resource. Ground every statement in that data and never invent values. Write professional Markdown. ' +
  'Answer naturally, adapt to the user wording and intent, and hide internal metadata. Do not mechanically list every field. Do not use labels like "Summary", "Category", "Recommended next step", or "Status" unless that wording sounds natural in the sentence. Never mention file names, resource IDs, match reasons, intents, MIME types, internal categories, backend URLs, OCR, or model names. ' +
  'Every final answer must include at least one meaningful Markdown bold element using **bold**. Use 1-3 short natural paragraphs for a single resource. Use concise bullets only for broad search or when the user asks for a list. Use Markdown bold for important labels and values such as status, amount, dates, references, account/card endings, card type, merchants, limits, branch names, product names, document names, and IDs. Do not bold filler words. ' +
  'Answer the user intent first, then use directly relevant trusted facts as evidence, then add optional supporting context only if it helps. Do not include every extracted field just because it exists. For due/payable/active/ready/confirmed/paid/available/blocked/issued/pending/completed questions, answer that status first. For "how much", start with the amount. For "when", start with the date or time. For "where", start with the branch or location. For "who", start with the person or beneficiary. For "what should I do", start with the recommended action. For problems, disputes, alerts, or errors, explain what happened first, then the next step. ' +
  'Preserve acronyms, abbreviations, document names, branch names, IDs, and banking field values exactly as provided in trustedFacts or keyFields. Do not expand acronyms unless that exact expansion is present in the trusted context. Never infer meanings, countries, or definitions for abbreviations such as CIN, RIB, IBAN, OTP, SME, TND, or CAD. ' +
  'Do not infer payment status. Never say no outstanding payment, nothing to pay, already paid, settled, or cleared unless trustedFacts explicitly include that payment status. If minimumPayment and paymentDueDate are present, say the minimum payment is due. ' +
  'Use clean sentence spacing; do not join two sentences without a space. ' +
  'For yes/no questions, answer yes or no first. For "what happened" questions, explain the event as a short story. For "why" questions, state the reason first, then the recommended action. For "who/what is" questions, identify the entity first, then relevant details. For show/find/open/download wording, be concise and do not expose metadata. ' +
  'When the user asks what is shown, what is visible, or about the elements or structure of an image or document, list the actual elements and fields present in the data (such as header, title, table, Notice ID, masked card number, card type, activation channel, expiry, status, and recommended step). ' +
  'Preserve masked or partially hidden values exactly as provided, for example ************4455. Never replace them with X characters or a generic placeholder, and never unmask them. ' +
  'Never tell the user to review, open, scan, or check the image or document to find information that is already present in the provided data; you have already analysed it. If a specific requested detail is genuinely missing from the data, say it is not available rather than inventing it or deflecting to the file. ' +
  'For status questions, state the status first. For bills, receipts, SMS alerts, and notices, cover provider or merchant, amount, date or time, reference, and status when present. For action-related resources, do not execute automatically; offer to prepare the allowed action. For prepared actions, explain what is ready and that confirmation is required before execution. Do not execute actions or change masked sensitive values.';

const IMAGE_QA_RESPONSE_WRITER_INSTRUCTION =
  'You are ATB digital banking assistant writing the final widget answer for an image resource. Use only agentContext.resourceResponseWriter.ocr.extractedFields, requestedFields, missingFields, and visibleTextSummary. OCR is the extraction layer and the only source of factual values. Write one short natural answer, like a normal assistant response. Every final answer must include at least one meaningful Markdown bold element using **bold**. Use clean bullets only when many fields make bullets clearer. Use Markdown bold for the resource title when mentioned, for important field labels when named, and for every extracted value used in the answer. Do not bold every word. Preserve every OCR value exactly, including units, dates, times, percentages, statuses, IDs, names, masked values, and TND. Do not invent, infer, convert, rename, round, or complete values. If a requested field is missing, say that specific field was not clearly found. Do not output raw subtitle-style label lines such as "Status: Scheduled" or old templates like "The amount shown in X is Y". Do not mention backend metadata, model names, OCR, or internal field names.';

const isBroadGeneralMessage = (message = '') => {
  const text = normalizeText(message);
  return [
    'hello',
    'hi',
    'hey',
    'help',
    'services',
    'what can you do',
    'what do you do',
  ].includes(text);
};

const isEducationalBankingQuestion = (message = '') => {
  const text = normalizeText(message);
  if (!text) return false;

  if (
    /\b(my|mine)\b/.test(text) ||
    /\b(status|balance|appointment|receipt|request|certificate|document|form|statement|report|pdf)\b/.test(text)
  ) {
    return false;
  }

  return (
    /^what is (a |an |the )?(current account|savings account|saving account|debit card|credit card|rib|iban|loan|overdraft)\b/.test(text) ||
    /^what are (a |an |the )?(current account|savings account|saving account|debit card|credit card|rib|iban|loans|overdrafts)\b/.test(text) ||
    /^what does .+ mean\b/.test(text) ||
    /^explain\b/.test(text) ||
    text.includes('difference between') ||
    text.includes('how can i protect') ||
    text.includes('how do i protect') ||
    text.includes('how to protect')
  );
};

const isSpecificResourceRequest = (message = '') => {
  const text = normalizeText(message);
  if (!text || isBroadGeneralMessage(text) || isEducationalBankingQuestion(text)) {
    return false;
  }

  const hasResourceAction =
    /\b(show|get|open|download|view|summarize|find|fetch)\b/.test(text);
  const hasResourceNoun =
    /\b(document|form|certificate|receipt|report|guide|product sheet|sheet|pdf|statement|notice|policy|request|resource|file)\b/.test(text);

  if (hasResourceAction && hasResourceNoun) {
    return true;
  }

  return (
    /\bstatus\b.*\b(request|complaint|dispute|replacement|checkbook|chequebook)\b/.test(text) ||
    /\b(request|complaint|dispute|replacement|checkbook|chequebook)\b.*\bstatus\b/.test(text) ||
    /\bdo i have\b.*\b(appointment|receipt|request|certificate|document)\b/.test(text)
  );
};

const isAccountDetailsRequest = (message = '') => {
  const text = normalizeText(message);
  return (
    /\baccounts?\b.*\b(details?|information|info|summary|status)\b/.test(text) ||
    /\b(details?|information|info|summary|status)\b.*\baccounts?\b/.test(text) ||
    /\b(show|view|give|get|display|list)\b.*\bmy accounts?\b/.test(text) ||
    /\b(show|view|give|get|display|list)\b.*\baccounts?\b/.test(text)
  );
};

const messageSpecifiesAccount = (message = '') => {
  const text = normalizeText(message);
  return (
    /\bacc\s*\d+\b/.test(text) ||
    text.includes('current account') ||
    text.includes('savings account') ||
    text.includes('saving account')
  );
};

const shouldSearchResourceCatalog = (message = '') => {
  const text = normalizeText(message);
  return [
    'account',
    'appointment',
    'balance',
    'beneficiary',
    'bill',
    'branch',
    'card',
    'checkbook',
    'chequebook',
    'certificate',
    'claim',
    'closing balance',
    'complaint',
    'connect',
    'dispute',
    'fees',
    'hiba',
    'invoice',
    'kyc',
    'loan',
    'payment',
    'profile',
    'pickup',
    'rib',
    'sonede',
    'steg',
    'statement',
    'telecom',
    'transfer',
    'limit',
    'notice',
    'receipt',
    'alert',
    'sms',
    'qr',
  ].some((keyword) => text.includes(keyword));
};

const getRouterMatchedKeywords = (message = '', routerDecision = {}) =>
  Array.from(new Set([
    ...(detectResourceHints(message) || []),
    routerDecision.resourceHint,
    routerDecision.detailHint,
  ].filter(Boolean)));

const logRouterDecisionStep = (trace, message, routerDecision = {}) => {
  const matchedKeywords = getRouterMatchedKeywords(message, routerDecision);
  logAgentStep(trace?.requestId, 'router_decision', {
    selectedCase: routerDecision.case,
    needsResourceSearch: routerDecision.needsResourceSearch,
    needsPdfVision: routerDecision.needsPdfVision,
    needsActionFlow: routerDecision.needsActionFlow,
    matchedKeywords,
    reason: routerDecision.reason,
  });

  if (!routerDecision.needsResourceSearch) {
    logAgentStep(trace?.requestId, 'resource_search_skipped', {
      reason: routerDecision.reason,
      selectedCase: routerDecision.case,
      messagePreview: trace?.messagePreview || messagePreview(message),
      matchedKeywords,
      missedResourceHints: detectResourceHints(message),
    });
  }
};

const safeJsonLength = (value) => {
  try {
    return JSON.stringify(value || {}).length;
  } catch {
    return 0;
  }
};

const logAiContextPrepared = ({
  trace,
  mode = 'text',
  message = '',
  resources = [],
  context = {},
  provider = 'python_ai_service',
  model = null,
}) => {
  const resourceList = Array.isArray(resources)
    ? resources.filter(Boolean)
    : resources
      ? [resources]
      : [];
  const contextCharCount = safeJsonLength(context);
  const promptCharCount = String(message || '').length + contextCharCount;
  logAgentStep(trace?.requestId, 'ai_context_prepared', {
    mode,
    resourcesIncluded: resourceList.length,
    contextCharCount,
    promptCharCount,
    model,
    provider,
  });
};

const runIntentPlanner = async ({
  trace,
  req,
  message,
  conversationHistory = [],
  fileContext = null,
  profileContext = {},
  agentContext = {},
  conversationContext = null,
  requestContext = null,
  agentPlan = null,
}) => {
  const availableActions = getAvailableAiActions(req.user.role);
  logAgentStep(trace?.requestId, 'planner_started', {
    endpoint: '/agent/plan',
    messagePreview: trace?.messagePreview || messagePreview(message),
    model: null,
    provider: 'python_ai_service_ollama',
  });

  try {
    const plannerResponse = await planIntent({
      requestId: trace?.requestId,
      threadId: trace?.threadId,
      message,
      userRole: req.user.role,
      availableActions,
      conversationHistory,
      fileContext,
      profileContext: sanitizeProfileContext(profileContext),
      agentContext,
      threadContext: conversationContext,
      requestContext,
      agentPlan,
    });
    const plannerDecision = normalizePlannerDecision(plannerResponse.data);
    logAgentStep(trace?.requestId, 'planner_finished', {
      intentType: plannerDecision.intentType,
      mode: plannerDecision.mode,
      resourceNeed: plannerDecision.resourceNeed,
      needsResourceSearch: plannerDecision.needsResourceSearch,
      resourceSearchQueryLength: String(plannerDecision.resourceSearchQuery || '').length,
      needsActionFlow: plannerDecision.needsActionFlow,
      needsDownload: plannerDecision.needsDownload,
      needsVision: plannerDecision.needsVision,
      actionType: plannerDecision.actionType,
      missingFieldCount: plannerDecision.missingFields.length,
      userGoalLength: String(plannerDecision.userGoal || '').length,
      confidence: plannerDecision.confidence,
    });
    return { plannerDecision, error: null };
  } catch (error) {
    if (error.isPlannerJsonParseFailure) {
      logAgentStep(trace?.requestId, 'planner_json_parse_failed', {
        message: error.message,
        fallbackUsed: 'safe_resource_search',
      });
    } else {
      logAgentStep(trace?.requestId, 'error', {
        failingStage: 'planner',
        message: error.message,
        fallbackUsed: 'safe_resource_search',
        ...(env.nodeEnv === 'development' ? { stack: error.stack } : {}),
      });
    }
    logAgentStep(trace?.requestId, 'planner_safe_fallback_used', {
      intentType: 'multi_resource_search',
      resourceNeed: true,
      resourceSearchQueryLength: String(message || '').length,
      reason: 'Planner failed; falling back to generic resource search.',
    });
    return { plannerDecision: null, error };
  }
};

const findResourceValue = (value, keys) => {
  if (!value || typeof value !== 'object') return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const nestedValue = findResourceValue(item, keys);
      if (nestedValue !== null && nestedValue !== undefined && nestedValue !== '') {
        return nestedValue;
      }
    }
    return null;
  }

  const normalizedMap = Object.entries(value).reduce((items, [key, item]) => ({
    ...items,
    [String(key).toLowerCase()]: item,
  }), {});

  for (const key of keys) {
    const item = normalizedMap[String(key).toLowerCase()];
    if (item !== null && item !== undefined && item !== '') {
      return item;
    }
  }

  for (const item of Object.values(value)) {
    const nestedValue = findResourceValue(item, keys);
    if (nestedValue !== null && nestedValue !== undefined && nestedValue !== '') {
      return nestedValue;
    }
  }

  return null;
};

const getResourceAccountId = (metadata = {}) =>
  findResourceValue(metadata, ['accountId', 'sourceAccountId', 'debitAccountId']);

const getAccountChoiceLabel = (accountId, metadata = {}) => {
  const text = normalizeText([
    metadata.title,
    metadata.accountType,
    metadata.type,
    metadata.productName,
  ].filter(Boolean).join(' '));

  if (text.includes('current') || accountId === 'acc_001') return 'Current account';
  if (text.includes('saving') || accountId === 'acc_002') return 'Savings account';

  return accountId || 'Account';
};

const isPdfFileReference = (fileUrl = '', contentType = '') =>
  String(contentType || '').toLowerCase().includes('pdf') ||
  String(fileUrl || '').toLowerCase().split(/[?#]/)[0].endsWith('.pdf');

const isImageFileReference = (fileUrl = '', contentType = '', resourceJson = {}) => {
  const fileText = String(fileUrl || '').toLowerCase().split(/[?#]/)[0];
  const mimeText = String(
    contentType ||
    resourceJson.mimeType ||
    resourceJson.contentType ||
    '',
  ).toLowerCase();
  const typeText = normalizeText([
    resourceJson.resourceFileType,
    resourceJson.resourceType,
    resourceJson.category,
    resourceJson.type,
    resourceJson.documentType,
  ].filter(Boolean).join(' '));

  return (
    /\.(png|jpe?g)$/i.test(fileText) ||
    ['image/png', 'image/jpeg', 'image/jpg'].some((mime) => mimeText.includes(mime)) ||
    /\b(image|scan|scanned|screenshot|visual document|visual)\b/.test(typeText)
  );
};

const isVisualResourceContext = (resourceContext = {}) => {
  const resourceJson = resourceContext.resourceJson || {};
  if (resourceContext.resourceFileType === 'image') return true;
  if (isImageFileReference(resourceContext.fileUrl, resourceContext.contentType, resourceJson)) return true;
  return Boolean(
    resourceContext.needsVision &&
    isPdfFileReference(resourceContext.fileUrl, resourceContext.contentType)
  );
};

const getFileNameFromUrl = (value = '') => {
  try {
    const parsed = new URL(value);
    return parsed.pathname.split('/').pop() || 'document.pdf';
  } catch {
    return String(value || '').split(/[\\/]/).pop() || 'document.pdf';
  }
};

const _VISION_BUILD_TS = '2026-06-11T00:00:00';
console.log(`[vision-debug] node image pipeline version: ${_VISION_BUILD_TS}`);

const IMAGE_VISION_MAX_DIMENSION = 1536;
const IMAGE_VISION_JPEG_QUALITY = 92;

const logImageMetric = (stage, trace, payload = {}) => {
  if (!env.architectureLogsEnabled) return;
  logArchitecture(stage, {
    requestId: trace?.requestId,
    threadId: trace?.threadId,
    ...payload,
  });
};

const debugResourceSearchLog = (...args) => {
  if (env.debugResourceSearch) {
    console.log(...args);
  }
};

const preprocessImageForVision = async (fileBuffer, { trace = null, fileName = null } = {}) => {
  if (!Buffer.isBuffer(fileBuffer) || !fileBuffer.length) {
    console.log(`[vision-diag] node_preprocess_skip fileName=${fileName} reason=no_buffer`);
    return null;
  }

  const originalSize = fileBuffer.length;
  console.log(`[vision-diag] node_preprocess_start fileName=${fileName} buffer_bytes=${originalSize}`);
  logImageMetric('image_original_size', trace, {
    image_original_size: originalSize,
    fileName,
  });

  let dimensionsBefore = {};
  try {
    const metadata = await sharp(fileBuffer, { limitInputPixels: false }).metadata();
    dimensionsBefore = {
      width: metadata.width || null,
      height: metadata.height || null,
      format: metadata.format || null,
    };
  } catch (error) {
    dimensionsBefore = { width: null, height: null, format: null };
    console.error('[vision-image] metadata read failed:', error.message);
  }
  logImageMetric('image_dimensions_before', trace, {
    image_dimensions_before: dimensionsBefore,
    fileName,
  });

  let processedBuffer = await sharp(fileBuffer, { limitInputPixels: false })
    .rotate()
    .flatten({ background: '#ffffff' })
    .toColorspace('srgb')
    .resize({
      width: IMAGE_VISION_MAX_DIMENSION,
      height: IMAGE_VISION_MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({
      quality: IMAGE_VISION_JPEG_QUALITY,
      chromaSubsampling: '4:4:4',
    })
    .toBuffer();

  const processedSize = processedBuffer.length;
  logImageMetric('image_processed_size', trace, {
    image_processed_size: processedSize,
    fileName,
  });

  let dimensionsAfter = {};
  try {
    const processedMetadata = await sharp(processedBuffer).metadata();
    dimensionsAfter = {
      width: processedMetadata.width || null,
      height: processedMetadata.height || null,
      format: processedMetadata.format || null,
    };
  } catch (error) {
    dimensionsAfter = { width: null, height: null, format: 'jpeg' };
    console.error('[vision-image] processed metadata read failed:', error.message);
  }
  logImageMetric('image_dimensions_after', trace, {
    image_dimensions_after: dimensionsAfter,
    fileName,
  });

  const base64 = processedBuffer.toString('base64');
  processedBuffer = null;
  console.log(`[vision-diag] node_preprocess_done fileName=${fileName} base64_length=${base64.length} original_bytes=${originalSize} processed_bytes=${processedSize}`);
  return {
    base64,
    mimeType: 'image/jpeg',
    originalSize,
    processedSize,
    dimensionsBefore,
    dimensionsAfter,
  };
};

const prepareVisionPayloadFromResourceContext = async ({
  resourceContext,
  isImageResource,
  trace = null,
  fileName = null,
}) => {
  if (isImageResource && resourceContext?.fileBuffer) {
    return preprocessImageForVision(resourceContext.fileBuffer, { trace, fileName });
  }

  if (resourceContext?.pdfBase64) {
    return {
      base64: resourceContext.pdfBase64,
      mimeType: resourceContext.contentType || 'application/pdf',
    };
  }

  return null;
};

const buildVisionPdfErrorResponse = ({
  status = 'vision_pdf_unavailable',
  assistantMessage =
    'I found the PDF, but visual document analysis is currently unavailable. Please try again later.',
} = {}) => ({
  success: true,
  status,
  agentMode: 'file_analysis',
  assistantMessage,
  data: {
    ai: {
      source: 'backend_vision_pdf',
      language: 'english',
      agentMode: 'file_analysis',
      intent: status,
      actionName: null,
      confidence: 1,
      missingFields: [],
      extractedFields: {},
      requiredTool: 'none',
      toolInput: {},
      assistantMessage,
    },
  },
});

const buildVisionPdfErrorFromException = (error, options = {}) => {
  const isImagePayload = Boolean(options.isImagePayload);
  const detail = String(error?.response?.data?.detail || error?.message || '');
  const statusCode = error?.response?.status;
  // Distinct, accurate label so an image failure is never mislabelled as a PDF failure. Safe
  // diagnostic fields only — no base64, OCR text, or prompt.
  console.error(`[${isImagePayload ? 'ocr-image' : 'vision-pdf'}] analysis failed:`, {
    payloadType: isImagePayload ? 'image' : 'pdf',
    endpoint: '/agent/analyze-vision-document',
    ocrOnly: isImagePayload,
    statusCode: statusCode || 'none',
    detail: detail || 'unknown_error',
  });
  console.log(`[ocr-diag] node_ocr_error statusCode=${statusCode || 'none'} detail="${detail || 'unknown_error'}" errorCode=${error?.code || 'none'}`);

  if ((!isImagePayload && !env.enableVisionPdfAnalysis) || /disabled/i.test(detail)) {
    if (isImagePayload || /image/i.test(detail)) {
      return buildVisionPdfErrorResponse({
        status: 'vision_image_disabled',
        assistantMessage:
          'I found the image resource, but visual image analysis is disabled in the current configuration.',
      });
    }
    return buildVisionPdfErrorResponse({
      status: 'vision_pdf_disabled',
      assistantMessage:
        'I found the PDF, but visual PDF analysis is disabled in the current configuration.',
    });
  }

  if (statusCode === 422 || /render|pages/i.test(detail)) {
    return buildVisionPdfErrorResponse({
      status: 'vision_pdf_render_failed',
      assistantMessage:
        'I found the PDF, but it could not be rendered for visual analysis.',
    });
  }

  if (/empty_ollama_response/i.test(detail)) {
    return buildVisionPdfErrorResponse({
      status: isImagePayload ? 'vision_image_unreadable' : 'vision_pdf_empty_response',
      assistantMessage:
        isImagePayload
          ? 'I found the image resource, but I could not read enough banking details from it.'
          : 'I found the PDF, but the vision model returned an empty response. Please try again.',
    });
  }

  if (
    isImagePayload &&
    (
      error?.code === 'VISION_TIMEOUT' ||
      /timeout|timed?\s*out|vision_timeout/i.test(detail)
    )
  ) {
    return buildVisionPdfErrorResponse({
      status: 'vision_image_timeout',
      assistantMessage:
        'I found the image resource, but visual analysis timed out. Please try again or use a smaller image.',
    });
  }

  return isImagePayload
    ? buildVisionPdfErrorResponse({
        status: 'vision_image_unavailable',
        assistantMessage:
          'I found the image resource, but visual image analysis is currently unavailable. Please try again later.',
      })
    : buildVisionPdfErrorResponse();
};

const SENSITIVE_RESOURCE_METADATA_KEYS = new Set([
  'url',
  'fileurl',
  'documenturl',
  'resourceurl',
  'localpathhint',
  'path',
  'filepath',
]);

const sanitizeResourceMetadataForVision = (value) => {
  if (Array.isArray(value)) {
    return value.map(sanitizeResourceMetadataForVision);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_RESOURCE_METADATA_KEYS.has(String(key).toLowerCase()))
      .map(([key, item]) => [key, sanitizeResourceMetadataForVision(item)]),
  );
};

const buildPdfDownloadAction = ({ fileUrl, fileName, resourceId = null, title = null }) => {
  if (!fileUrl) return null;

  try {
    const download = createResourceDownload({ fileUrl, fileName });
    return {
      id: download.id,
      label: 'Download PDF',
      action: 'download',
      type: 'download_pdf',
      resourceId,
      title,
      url: download.downloadUrl,
      downloadUrl: download.downloadUrl,
    };
  } catch (error) {
    console.error('[resource-download] could not create approved download:', {
      reason: error.message,
    });
    return null;
  }
};

const buildImageViewAction = ({ fileUrl, fileName, resourceId = null, title = null }) => {
  if (!fileUrl) return null;

  try {
    const view = createResourceView({ fileUrl, fileName });
    return {
      id: view.id,
      label: 'View image',
      action: 'open',
      type: 'view_image',
      resourceId,
      title,
      url: view.viewUrl,
      viewUrl: view.viewUrl,
    };
  } catch (error) {
    console.error('[resource-view] could not create approved image view:', {
      reason: error.message,
    });
    return null;
  }
};

const buildConfirmationQuickActions = (confirmationId) => {
  if (!confirmationId) return [];
  return [
    {
      id: `${confirmationId}:confirm`,
      label: 'Confirm',
      action: 'confirm_pending',
      type: 'confirm',
      confirmationId,
    },
    {
      id: `${confirmationId}:cancel`,
      label: 'Cancel',
      action: 'cancel',
      type: 'cancel',
      confirmationId,
    },
  ];
};

const attachQuickActions = (ai = {}, quickActions = []) => {
  const normalizedQuickActions = dedupeQuickActions([
    ...(ai.toolInput?.quickActions || []),
    ...quickActions,
  ]);

  return {
    ...ai,
    toolInput: {
      ...(ai.toolInput || {}),
      ...(normalizedQuickActions.length ? { quickActions: normalizedQuickActions } : {}),
    },
  };
};

const getQuickActionUrl = (action = {}) =>
  action.url || action.downloadUrl || action.fileUrl || '';

const isDownloadLikeQuickAction = (action = {}) => {
  const actionType = action.action || action.type || '';
  const label = normalizeText(
    action.label || action.title || action.text || action.name || '',
  );
  const url = String(getQuickActionUrl(action) || '').toLowerCase();

  return (
    ['download', 'open_url'].includes(actionType) &&
    (
      label.includes('download pdf') ||
      label.includes('download document') ||
      label.includes('pdf') ||
      url.includes('/resources/download/') ||
      url.split(/[?#]/)[0].endsWith('.pdf') ||
      Boolean(action.downloadUrl || action.fileUrl)
    )
  );
};

const getQuickActionKey = (action = {}) => {
  if (action.id) return `id:${action.id}`;

  const actionType = action.action || action.type || '';
  const url = String(getQuickActionUrl(action) || '').trim();

  if (url) {
    const urlActionType = isDownloadLikeQuickAction(action) ? 'download' : actionType;
    return `${urlActionType || 'url'}:${url}`;
  }

  const label = action.label || action.title || action.text || action.name || '';
  return `${actionType}:${label}:${action.value || action.prompt || ''}`;
};

const dedupeQuickActions = (actions = []) => {
  const seen = new Set();

  return actions.filter((action) => {
    if (!action || !action.label) return false;
    const key = getQuickActionKey(action);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const attachPdfDownloadAction = (ai = {}, downloadAction = null) => {
  if (!downloadAction) return ai;

  const toolInput = ai.toolInput || {};
  const quickActions = Array.isArray(toolInput.quickActions)
    ? toolInput.quickActions
    : [];
  const normalizedQuickActions = dedupeQuickActions([
    downloadAction,
    ...quickActions.filter((action) => !isDownloadLikeQuickAction(action)),
  ]);

  return {
    ...ai,
    toolInput: {
      ...toolInput,
      quickActions: normalizedQuickActions,
    },
  };
};

const stripPdfDownloadActions = (ai = {}) => {
  const toolInput = ai.toolInput || {};
  const quickActions = Array.isArray(toolInput.quickActions)
    ? toolInput.quickActions.filter((action) => !isDownloadLikeQuickAction(action))
    : [];

  return {
    ...ai,
    toolInput: {
      ...toolInput,
      ...(quickActions.length ? { quickActions } : {}),
      ...(!quickActions.length ? { quickActions: undefined } : {}),
    },
  };
};

const pdfDownloadActionForResourceContext = (resolvedResourceContext = {}) => {
  if (!resolvedResourceContext?.fileUrl) return null;
  const fileUrl = resolvedResourceContext.fileUrl;
  const mimeType = resolvedResourceContext.contentType ||
    resolvedResourceContext.resourceJson?.mimeType || '';
  if (!isPdfFileReference(fileUrl, mimeType)) {
    return null;
  }
  return buildPdfDownloadAction({
    fileUrl,
    fileName: getFileNameFromUrl(fileUrl),
    resourceId: resolvedResourceContext.resourceJson?.resourceId ||
      resolvedResourceContext.matchedResource?.fileName ||
      null,
    title: resolvedResourceContext.resourceJson?.title ||
      resolvedResourceContext.matchedResource?.title ||
      null,
  });
};

const applyResourceResponseStyle = ({
  ai = {},
  message = '',
  resolvedResourceContext = null,
  aiDecision = {},
  routerDecision = {},
  trace = null,
} = {}) => {
  const responseStyle = classifyResourceResponseStyle({
    message,
    resourceJson: resolvedResourceContext?.resourceJson || {},
    aiDecision,
    routerDecision,
  });
  let styledAi = {
    ...ai,
    responseStyle,
    toolInput: {
      ...(ai.toolInput || {}),
      responseStyle,
    },
  };

  if (responseStyle === RESPONSE_STYLES.DOCUMENT_SUMMARY) {
    const downloadAction = pdfDownloadActionForResourceContext(resolvedResourceContext);
    styledAi = attachPdfDownloadAction(
      styledAi,
      downloadAction,
    );
  } else if (responseStyle === RESPONSE_STYLES.RESOURCE_QUESTION_ANSWER) {
    styledAi = stripPdfDownloadActions(styledAi);
    styledAi = {
      ...styledAi,
      toolInput: {
        ...(styledAi.toolInput || {}),
        responseStyle,
      },
    };
  }

  const fieldInfo = resolvedResourceContext?.resourceJson
    ? collectSearchListFields(resolvedResourceContext.resourceJson).fieldsByKey
    : new Map();
  const importantFields = resolvedResourceContext?.resourceJson
    ? importantResourceFieldsForList(resolvedResourceContext.resourceJson, 4).map((field) => field.label)
    : [];
  logArchitecture('response_style', {
    requestId: trace?.requestId,
    threadId: trace?.threadId,
    responseStyle,
  });
  logArchitecture('resource_answer', {
    requestId: trace?.requestId,
    threadId: trace?.threadId,
    normalizedFieldCount: fieldInfo.size,
    importantFieldsSelected: importantFields,
    downloadActionGenerated: Boolean(
      styledAi.toolInput?.quickActions?.some((action) => isDownloadLikeQuickAction(action)),
    ),
    backendDownloadRoutes: (styledAi.toolInput?.quickActions || [])
      .filter((action) => isDownloadLikeQuickAction(action))
      .map((action) => action.downloadUrl || action.url),
  });

  return styledAi;
};

const VISION_SAFE_ACTIONS = new Set([
  'pay_bill',
  'make_transfer',
  'create_complaint',
  'book_appointment',
]);
const VISION_PREPARABLE_ACTIONS = new Set([
  'pay_bill',
  'make_transfer',
  'create_complaint',
  'book_appointment',
]);

const VISION_FIELD_ALIASES = {
  provider: 'provider',
  biller: 'provider',
  merchant: 'provider',
  billreference: 'billReference',
  billref: 'billReference',
  invoicereference: 'billReference',
  invoiceid: 'billReference',
  reference: 'billReference',
  amount: 'amount',
  totalamount: 'amount',
  amountdue: 'amount',
  dueamount: 'amount',
  currency: 'currency',
  duedate: 'dueDate',
  sourceaccountid: 'sourceAccountId',
  debitaccountid: 'sourceAccountId',
  fromaccountid: 'sourceAccountId',
  accountid: 'accountId',
  beneficiaryid: 'beneficiaryId',
  beneficiaryname: 'beneficiaryName',
  beneficiaryaccount: 'beneficiaryAccount',
  beneficiaryrib: 'beneficiaryAccount',
  beneficiaryiban: 'beneficiaryAccount',
  description: 'description',
  purpose: 'description',
  period: 'period',
  openingbalance: 'openingBalance',
  closingbalance: 'closingBalance',
  holdername: 'holderName',
  holder: 'holderName',
  rib: 'rib',
  iban: 'iban',
  branch: 'branch',
  warnings: 'warnings',
  tables: 'tables',
};

const VISION_DOCUMENT_TYPES = {
  bill: 'bill',
  invoice: 'invoice',
  utilitybill: 'bill',
  billpaymentreceipt: 'payment_receipt',
  paymentreceipt: 'payment_receipt',
  transferorder: 'transfer_order',
  transferrequest: 'transfer_order',
  internationaltransferrequest: 'international_transfer_request',
  accountstatement: 'account_statement',
  bankstatement: 'account_statement',
  ribcertificate: 'rib_certificate',
  accountcertificate: 'account_certificate',
  fxreceipt: 'fx_receipt',
  foreigncurrencyexchangereceipt: 'fx_receipt',
  atmreceipt: 'atm_receipt',
  atmwithdrawalreceipt: 'atm_receipt',
  customerprofile: 'customer_profile',
  customerprofileoverview: 'customer_profile',
  digitalbankingguide: 'digital_banking_guide',
  atbconnectguide: 'digital_banking_guide',
  activationguide: 'digital_banking_guide',
  securitynotice: 'security_notice',
  mobilebankingsecuritynotice: 'security_notice',
  cardlimitnotice: 'card_limit_notice',
  standingorder: 'standing_order',
  internationaltransferrequest: 'international_transfer_request',
  cardservicerequest: 'card_service_request',
  debitcardreplacementrequest: 'card_service_request',
  carddispute: 'card_dispute',
  onlinepurchasedispute: 'card_dispute',
  loanoffer: 'loan_offer',
  productsheet: 'product_sheet',
  salarycertificate: 'salary_certificate',
  salarydomiciliationcertificate: 'salary_certificate',
  taxform: 'tax_form',
  taxresidencyselfcertification: 'tax_form',
  insurancepolicy: 'insurance_policy',
  homeinsurancepolicysummary: 'insurance_policy',
  accountclosurerequest: 'account_closure_request',
  accountclosurerequestdraft: 'account_closure_request',
  checkbookrequest: 'checkbook_request',
  chequebookrequest: 'checkbook_request',
  appointmentconfirmation: 'appointment_confirmation',
  cardpickupappointment: 'appointment_confirmation',
  beneficiaryprofile: 'beneficiary_profile',
};

const normalizeVisionKey = (value = '') =>
  String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const normalizeVisionDocumentType = (value = '') => {
  const text = String(value || '').trim();
  if (!text) return null;

  return VISION_DOCUMENT_TYPES[normalizeVisionKey(text)] ||
    text.toLowerCase().replace(/[\s-]+/g, '_');
};

const DOCUMENT_TYPE_LABELS = {
  fx_receipt: 'foreign currency exchange receipt',
  atm_receipt: 'ATM withdrawal receipt',
  payment_receipt: 'payment receipt',
  bill: 'bill',
  invoice: 'invoice',
  payment_receipt: 'payment receipt',
  transfer_order: 'transfer order',
  international_transfer_request: 'international transfer request',
  customer_profile: 'customer profile overview',
  digital_banking_guide: 'ATB Connect activation guide',
  security_notice: 'mobile banking security notice',
  card_limit_notice: 'credit card limit notice',
  standing_order: 'standing order',
  card_service_request: 'debit card replacement request',
  card_dispute: 'online purchase dispute',
  loan_offer: 'student loan offer',
  product_sheet: 'product sheet',
  salary_certificate: 'salary domiciliation certificate',
  tax_form: 'tax residency self-certification form',
  insurance_policy: 'home insurance policy summary',
  account_closure_request: 'account closure request draft',
  checkbook_request: 'checkbook request',
  appointment_confirmation: 'card pickup appointment',
  beneficiary_profile: 'beneficiary profile',
  rib_certificate: 'RIB certificate',
  account_statement: 'account statement',
  account_certificate: 'account certificate',
};

const getRequestedDocumentType = (message = '') => {
  const text = normalizeText(message);
  if (
    text.includes('foreign currency') ||
    text.includes('currency exchange') ||
    text.includes('foreign exchange') ||
    /\bfx\b/.test(text)
  ) {
    return 'fx_receipt';
  }
  if (text.includes('atm') || text.includes('cash withdrawal')) return 'atm_receipt';
  if (
    text.includes('payment receipt') ||
    (text.includes('bill') && text.includes('receipt'))
  ) {
    return 'payment_receipt';
  }
  if (text.includes('bill') || text.includes('invoice')) return 'bill';
  if (text.includes('customer profile') || (text.includes('profile') && text.includes('overview'))) {
    return 'customer_profile';
  }
  if (text.includes('atb connect') || (text.includes('connect') && text.includes('activate'))) {
    return 'digital_banking_guide';
  }
  if (text.includes('mobile banking security') || (text.includes('security') && text.includes('notice'))) {
    return 'security_notice';
  }
  if (text.includes('card') && text.includes('limit')) return 'card_limit_notice';
  if (text.includes('standing order') || (text.includes('order') && text.includes('rent'))) {
    return 'standing_order';
  }
  if (text.includes('transfer request') || text.includes('international transfer')) {
    return 'international_transfer_request';
  }
  if (text.includes('debit card replacement') || text.includes('card replacement')) {
    return 'card_service_request';
  }
  if (text.includes('online purchase dispute') || text.includes('card dispute')) {
    return 'card_dispute';
  }
  if (text.includes('student') && (text.includes('loan') || text.includes('offer'))) {
    return 'loan_offer';
  }
  if (text.includes('product sheet') || (text.includes('product') && text.includes('sheet'))) {
    return 'product_sheet';
  }
  if (text.includes('salary') || text.includes('domiciliation')) return 'salary_certificate';
  if (text.includes('tax') || text.includes('self certification') || text.includes('residency')) {
    return 'tax_form';
  }
  if (text.includes('home insurance') || text.includes('insurance policy')) {
    return 'insurance_policy';
  }
  if (text.includes('account closure') || (text.includes('closure') && text.includes('request'))) {
    return 'account_closure_request';
  }
  if (text.includes('checkbook') || text.includes('chequebook')) return 'checkbook_request';
  if (text.includes('card pickup') && text.includes('appointment')) {
    return 'appointment_confirmation';
  }
  if (text.includes('beneficiary profile') || text.includes('hiba msallem')) {
    return 'beneficiary_profile';
  }
  if (text.includes('rib')) return 'rib_certificate';
  if (text.includes('statement')) return 'account_statement';
  return null;
};

const resourceFieldsForAction = (actionName, resourceJson = {}, user) => {
  if (!actionName || !resourceJson || typeof resourceJson !== 'object') {
    return {};
  }

  if (actionName === 'pay_bill') {
    return normalizeVisionFields({
      provider: findResourceValue(resourceJson, ['provider', 'biller', 'merchant']),
      billReference: findResourceValue(resourceJson, [
        'billReference',
        'billRef',
        'invoiceReference',
        'reference',
      ]),
      amount: findResourceValue(resourceJson, ['amount', 'totalAmount', 'total', 'amountDue']),
      currency: findResourceValue(resourceJson, ['currency']),
      dueDate: findResourceValue(resourceJson, ['dueDate', 'paymentDueDate', 'deadline']),
      sourceAccountId: findResourceValue(resourceJson, [
        'sourceAccountId',
        'accountId',
        'debitAccountId',
      ]),
    });
  }

  if (actionName === 'make_transfer') {
    const fields = normalizeVisionFields({
      sourceAccountId: findResourceValue(resourceJson, [
        'sourceAccountId',
        'accountId',
        'debitAccountId',
        'fromAccountId',
      ]),
      beneficiaryId: findResourceValue(resourceJson, ['beneficiaryId']),
      beneficiaryName: findResourceValue(resourceJson, ['beneficiaryName', 'beneficiary']),
      beneficiaryAccount: findResourceValue(resourceJson, [
        'beneficiaryAccount',
        'beneficiaryRib',
        'beneficiaryIban',
        'accountNumber',
      ]),
      amount: findResourceValue(resourceJson, ['amount', 'transferAmount', 'totalAmount']),
      currency: findResourceValue(resourceJson, ['currency']),
      description: findResourceValue(resourceJson, ['reason', 'purpose', 'memo', 'relationship']),
    });
    const beneficiaryId = resolveVisionBeneficiaryId(fields, user);
    return beneficiaryId ? { ...fields, beneficiaryId } : fields;
  }

  if (actionName === 'create_complaint') {
    const disputeReference = findResourceValue(resourceJson, [
      'disputeId',
      'complaintId',
      'reference',
      'requestId',
    ]);
    const merchant = findResourceValue(resourceJson, ['merchant', 'provider']);
    const amount = findResourceValue(resourceJson, ['amount', 'totalAmount']);
    const currency = findResourceValue(resourceJson, ['currency']);
    const date = findResourceValue(resourceJson, ['date', 'transactionDate', 'purchaseDate', 'createdAt']);
    const card = findResourceValue(resourceJson, ['card', 'maskedCard', 'cardNumber']);
    const status = findResourceValue(resourceJson, ['status']);
    const deadline = findResourceValue(resourceJson, ['deadline', 'dueDate', 'responseDeadline']);
    const category = normalizeResourceType(resourceJson.resourceType).includes('card')
      ? 'Card issue'
      : 'Other';
    const description = [
      resourceJson.title || category,
      disputeReference ? `reference ${disputeReference}` : '',
      merchant ? `merchant ${merchant}` : '',
      amount ? `amount ${amount}` : '',
      status ? `status ${status}` : '',
    ].filter(Boolean).join(', ');

    const fields = normalizeVisionFields({
      category,
      description,
      relatedReference: disputeReference,
      sourceAccountId: findResourceValue(resourceJson, ['sourceAccountId', 'accountId']),
      amount,
      currency,
      status,
      deadline,
      date,
      card,
    });
    return {
      ...fields,
      ...(merchant ? { merchant } : {}),
      ...(disputeReference ? { disputeId: disputeReference } : {}),
    };
  }

  if (actionName === 'book_appointment') {
    return normalizeVisionFields({
      branch: findResourceValue(resourceJson, ['branch', 'requestedBranch']),
      date: findResourceValue(resourceJson, ['date', 'requestedDate', 'appointmentDate']),
      time: findResourceValue(resourceJson, ['time', 'requestedTime', 'appointmentTime']),
      advisor: findResourceValue(resourceJson, ['advisor', 'advisorType']),
      purpose: findResourceValue(resourceJson, ['purpose', 'title']),
    });
  }

  return {};
};

const stripPrivateResourceFields = (fields = {}) =>
  Object.fromEntries(
    Object.entries(fields || {}).filter(
      ([key]) => !String(key).toLowerCase().startsWith('_resource'),
    ),
  );

const forceVisionActionFromDecision = ({
  ai,
  actionName,
  resourceJson,
  user,
  contextFields = {},
}) => {
  if (!VISION_PREPARABLE_ACTIONS.has(actionName)) {
    return ai;
  }

  const resourceFields = resourceFieldsForAction(actionName, resourceJson, user);
  const extractedFields = {
    ...(ai.extractedFields || {}),
    ...stripPrivateResourceFields(contextFields || {}),
    ...resourceFields,
  };

  if (!extractedFields.sourceAccountId && extractedFields.accountId) {
    extractedFields.sourceAccountId = extractedFields.accountId;
  }

  return {
    ...ai,
    agentMode: 'banking_action',
    intent: actionName,
    actionName,
    suggestedAction: actionName,
    extractedFields,
    requiredTool: 'connector_action',
    toolInput: {
      ...(ai.toolInput || {}),
      suggestedAction: actionName,
    },
  };
};

const isCompatibleDetectedDocumentType = (requestedType, detectedType) => {
  if (!requestedType || !detectedType || detectedType === 'unknown') return true;
  if (requestedType === detectedType) return true;
  if (requestedType === 'bill') {
    return ['bill', 'invoice'].includes(detectedType);
  }
  if (requestedType === 'payment_receipt') {
    return detectedType === 'payment_receipt';
  }
  if (requestedType === 'international_transfer_request') {
    return detectedType === 'transfer_order';
  }
  return false;
};

const buildDocumentMismatchResponse = ({ requestedType, detectedType }) => {
  const requestedLabel = DOCUMENT_TYPE_LABELS[requestedType] || requestedType;
  const detectedLabel = DOCUMENT_TYPE_LABELS[detectedType] || detectedType;
  const assistantMessage =
    `I found a document, but it appears to be ${detectedLabel}, not ${requestedLabel}.`;

  return {
    success: true,
    status: 'resource_mismatch',
    agentMode: 'informational_answer',
    assistantMessage,
    data: {
      ai: {
        source: 'resource_catalog',
        language: 'english',
        agentMode: 'informational_answer',
        intent: 'resource_mismatch',
        actionName: null,
        confidence: 1,
        missingFields: [],
        extractedFields: {},
        requiredTool: 'none',
        toolInput: {},
        assistantMessage,
      },
    },
  };
};

const normalizeVisionAmount = (value) => {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;

  const normalized = value.replace(/\s/g, '').replace(',', '.');
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return value;

  const amount = Number(match[0]);
  return Number.isFinite(amount) ? amount : value;
};

const normalizeVisionFields = (fields = {}) => {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(fields)
      .filter(([, value]) => hasFieldValue(value))
      .map(([key, value]) => {
        const normalizedKey =
          VISION_FIELD_ALIASES[normalizeVisionKey(key)] || key;
        return [
          normalizedKey,
          normalizedKey === 'amount' ? normalizeVisionAmount(value) : value,
        ];
      }),
  );
};

const isExplicitTransferActionRequest = (message = '') => {
  const text = normalizeText(message);
  if (!text) return false;

  return (
    /\b(make|create|initiate|start|send|execute|prepare|confirm)\b.{0,50}\b(transfer|money|funds)\b/.test(text) ||
    (/\btransfer\b.{0,30}\b(to|for)\b/.test(text) &&
      /\b(send|make|execute|prepare|confirm)\b/.test(text))
  );
};

const isExistingTransferDetailRequest = (message = '') => {
  const text = normalizeText(message);
  if (!text || isExplicitTransferActionRequest(message)) return false;

  const hasTransferRequest =
    text.includes('transfer request') ||
    text.includes('international transfer') ||
    (text.includes('transfer') && text.includes('request'));
  const asksForDetails =
    /\b(what are|what is|show|view|get|give|display|find|check)\b.{0,60}\b(details?|status|information|summary)\b/.test(text) ||
    /\b(details?|status|information|summary)\b.{0,60}\b(of|for|about)\b/.test(text) ||
    /\bstatus\b.*\btransfer\b/.test(text);

  return hasTransferRequest && asksForDetails;
};

const shouldAllowVisionActionPreparation = (message = '', aiDecision = {}) => {
  if (isExistingTransferDetailRequest(message)) {
    return false;
  }

  if (aiDecision.decision === 'search_resource' && !aiDecision.action) {
    return false;
  }

  return true;
};

const DIRECT_RESOURCE_QA_PATTERNS = [
  /^what\s+(is|are|does)\b/,
  /^when\s+(is|was)\b/,
  /^how\s+much\b/,
  /^how\s+(do|can)\s+i\b/,
  /^do\s+i\s+have\b/,
  /^which\b/,
  /^where\b/,
  /^who\b/,
  /^what\s+services?\b/,
  /\bwhat\s+(?:are|is)\s+the\b.*\bservices?\b/,
  /\bservices?\b.*\b(available|provide|provided|offer|offered|does|do)\b/,
  /\b(available|provide|provided|offer|offered)\b.*\bservices?\b/,
  /\bstatus\s+of\b/,
  /\bwhat\s+is\s+the\s+status\b/,
  /\bwhat\s+.*\brecommend\b/,
  /\bwhat\s+branches\s+are\s+available\b/,
  /\bwhat\s+loan\s+offer\b/,
];

const DOCUMENT_DOWNLOAD_PATTERNS = [
  /\b(show|get|open|download|view|fetch)\b/,
  /\b(document|pdf|form|guide|policy|product sheet|certificate|receipt|statement|notice|profile overview|policy summary|request draft)\b/,
];

const RESPONSE_STYLES = {
  DOCUMENT_SUMMARY: 'document_summary',
  RESOURCE_QUESTION_ANSWER: 'resource_question_answer',
  RESOURCE_SEARCH_LIST: 'resource_search_list',
  ACTION_CONTEXT: 'action_context',
  GENERAL_NATURAL_CHAT: 'general_natural_chat',
};

const DOCUMENT_SUMMARY_STRONG_PATTERNS = [
  /\b(show\s+me|show|get\s+my|get|can\s+you\s+get|can\s+you\s+show|open|display|download|view|fetch)\b/,
];

const DOCUMENT_SUMMARY_NOUN_PATTERNS = [
  /\b(document|pdf|form|certificate|receipt|notice)\b/,
  /\bprofile\s+overview\b/,
  /\bpolicy\s+summary\b/,
  /\bproduct\s+sheet\b/,
  /\brequest\s+draft\b/,
];

const classifyResourceResponseStyle = ({
  message = '',
  resourceJson = {},
  aiDecision = {},
  routerDecision = {},
  defaultStyle = null,
} = {}) => {
  if (aiDecision?.action || routerDecision?.needsActionFlow) {
    return RESPONSE_STYLES.ACTION_CONTEXT;
  }

  if (defaultStyle === RESPONSE_STYLES.RESOURCE_SEARCH_LIST) {
    return RESPONSE_STYLES.RESOURCE_SEARCH_LIST;
  }

  const text = normalizeText(message);
  if (!text) return defaultStyle || RESPONSE_STYLES.GENERAL_NATURAL_CHAT;

  // "What/which documents do I need" is a checklist CONTENT question (resource QA), not a request to
  // download a file — even though it contains a retrieval-like verb ("open an account") and the noun
  // "document". Keep it on the QA answer path so the deterministic checklist builder is used.
  if (/\bdocuments?\b/.test(text) && /\b(need|needed|require|required|necessary|do i need)\b/.test(text)) {
    return RESPONSE_STYLES.RESOURCE_QUESTION_ANSWER;
  }

  const resourceType = normalizeResourceType(resourceJson?.resourceType);
  const isDirectQuestion = DIRECT_RESOURCE_QA_PATTERNS.some((pattern) => pattern.test(text));
  const hasStrongDocumentVerb = DOCUMENT_SUMMARY_STRONG_PATTERNS.some((pattern) => pattern.test(text));
  const hasDocumentNoun = DOCUMENT_SUMMARY_NOUN_PATTERNS.some((pattern) => pattern.test(text));
  const hasDocumentSummaryPhrase =
    /\b(profile overview|policy summary|product sheet|request draft)\b/.test(text);

  // A direct fact question that does not name a document/file is QA, even if it contains an
  // incidental verb like "get" ("where can I get premium desk service?"). This keeps such questions
  // on the resource_qa answer path instead of the document-summary/metadata path.
  if (isDirectQuestion && !hasDocumentNoun) {
    return RESPONSE_STYLES.RESOURCE_QUESTION_ANSWER;
  }

  if (hasStrongDocumentVerb && (hasDocumentNoun || resourceType || hasDocumentSummaryPhrase)) {
    return RESPONSE_STYLES.DOCUMENT_SUMMARY;
  }

  if (hasDocumentSummaryPhrase && !isDirectQuestion) {
    return RESPONSE_STYLES.DOCUMENT_SUMMARY;
  }

  if (isDirectQuestion) {
    return RESPONSE_STYLES.RESOURCE_QUESTION_ANSWER;
  }

  if (hasDocumentNoun) {
    return RESPONSE_STYLES.DOCUMENT_SUMMARY;
  }

  return defaultStyle || RESPONSE_STYLES.RESOURCE_QUESTION_ANSWER;
};

const shouldAttachPdfDownloadForRequest = (message = '', resourceJson = {}) => {
  const text = normalizeText(message);
  const resourceType = normalizeResourceType(resourceJson?.resourceType);

  if (!text) return false;

  if (
    ['digital_banking_guide', 'atb_connect_guide'].includes(resourceType) &&
    /\bactivate\b/.test(text) &&
    /\batb connect\b/.test(text)
  ) {
    return true;
  }

  return classifyResourceResponseStyle({
    message,
    resourceJson,
  }) === RESPONSE_STYLES.DOCUMENT_SUMMARY;
};

const JSON_ANSWERABLE_RESOURCE_TYPES = new Set([
  'appointment_confirmation',
  'appointment_request',
  'branch_directory',
  'branch_list',
  'card_dispute',
  'card_limit_notice',
  'card_pickup_appointment',
  'card_service_request',
  'checkbook_request',
  'digital_banking_guide',
  'international_transfer_request',
  'loan_offer',
  'security_notice',
  'standing_order',
]);

const shouldAnswerResourceFromJson = (message = '', resolvedResourceContext = {}, aiDecision = {}) => {
  if (!resolvedResourceContext?.resourceJson || aiDecision?.action) {
    return false;
  }
  if (isVisualResourceContext(resolvedResourceContext)) {
    return false;
  }

  const text = normalizeText(message);
  const resourceType = normalizeResourceType(resolvedResourceContext.resourceJson.resourceType);
  const responseStyle = classifyResourceResponseStyle({
    message,
    resourceJson: resolvedResourceContext.resourceJson,
    aiDecision,
  });

  if (
    responseStyle === RESPONSE_STYLES.DOCUMENT_SUMMARY ||
    responseStyle === RESPONSE_STYLES.RESOURCE_QUESTION_ANSWER
  ) {
    return true;
  }

  return (
    DIRECT_RESOURCE_QA_PATTERNS.some((pattern) => pattern.test(text)) ||
    JSON_ANSWERABLE_RESOURCE_TYPES.has(resourceType)
  );
};

const normalizeComparableAccount = (value = '') =>
  String(value || '').replace(/[^a-z0-9]+/gi, '').toLowerCase();

const resolveVisionBeneficiaryId = (fields = {}, user) => {
  if (fields.beneficiaryId) return fields.beneficiaryId;

  const account = normalizeComparableAccount(
    fields.beneficiaryAccount || fields.beneficiaryRib || fields.beneficiaryIban,
  );
  const name = normalizeText(fields.beneficiaryName || '');
  const beneficiary = mockBeneficiaries.find((item) => {
    if (item.userId !== user.id) return false;
    if (account && normalizeComparableAccount(item.rib) === account) return true;
    return name && normalizeText(item.name) === name;
  });

  return beneficiary?.beneficiaryId || null;
};

const inferVisionSuggestedAction = ({ documentType, fields = {}, rawAction = null }) => {
  const action = typeof rawAction === 'string' ? rawAction.trim() : '';
  if (VISION_SAFE_ACTIONS.has(action)) {
    return action;
  }

  if (
    ['bill', 'invoice'].includes(documentType) &&
    (fields.provider || fields.billReference || fields.amount)
  ) {
    return 'pay_bill';
  }

  if (
    documentType === 'transfer_order' &&
    (fields.beneficiaryId || fields.beneficiaryName || fields.beneficiaryAccount || fields.amount)
  ) {
    return 'make_transfer';
  }

  if (
    ['card_dispute', 'complaint_document', 'complaint_request'].includes(documentType) &&
    (fields.disputeId || fields.relatedReference || fields.merchant || fields.status)
  ) {
    return 'create_complaint';
  }

  return null;
};

const normalizeVisionAiForBackend = (ai = {}, user) => {
  const documentType = normalizeVisionDocumentType(
    ai.documentType || ai.documentTypeDetected || ai.resourceType || ai.toolInput?.documentType,
  );
  const extractedFields = normalizeVisionFields(ai.extractedFields || ai.fields || {});

  if (!extractedFields.sourceAccountId && extractedFields.accountId) {
    extractedFields.sourceAccountId = extractedFields.accountId;
  }

  const beneficiaryId = resolveVisionBeneficiaryId(extractedFields, user);
  if (beneficiaryId) {
    extractedFields.beneficiaryId = beneficiaryId;
  }

  const warnings = Array.isArray(ai.warnings)
    ? ai.warnings.filter(Boolean).map(String)
    : Array.isArray(extractedFields.warnings)
      ? extractedFields.warnings.filter(Boolean).map(String)
      : [];
  const suggestedAction = inferVisionSuggestedAction({
    documentType,
    fields: extractedFields,
    rawAction: ai.suggestedAction || ai.actionName,
  });
  const markdown = ai.markdown || ai.assistantMessage || '';
  if (!suggestedAction) {
    extractedFields._visionNoAction = true;
  }

  return {
    ...ai,
    agentMode: suggestedAction ? 'banking_action' : 'file_analysis',
    intent: suggestedAction || ai.intent || 'vision_pdf_analysis',
    actionName: suggestedAction,
    suggestedAction,
    documentType,
    documentTypeDetected: documentType,
    warnings,
    markdown,
    extractedFields,
    requiredTool: suggestedAction ? 'connector_action' : 'none',
    toolInput: {
      ...(ai.toolInput || {}),
      documentType,
      suggestedAction,
      warnings,
    },
    assistantMessage: markdown || ai.assistantMessage,
  };
};

const buildVisionPreparedActionResponse = ({ req, ai, fileContext = null }) => {
  const finalPayload = mergePayloadWithExtractedFields({
    extractedFields: ai.extractedFields || {},
    payload: {},
  });
  const preparation = prepareAction({
    actionName: ai.actionName,
    payload: finalPayload,
    user: req.user,
  });

  const fileData = fileContext
    ? {
        fileContext: {
          files: buildSafeFileAttachments(fileContext),
          extractedContextUsed: false,
        },
      }
    : {};

  if (preparation.body.status === 'missing_fields') {
    const missingFields = preparation.body.missingFields;
    const enrichedAi = withClarificationQuickActions(
      { ...ai, missingFields },
      ai.actionName,
      missingFields,
      finalPayload,
    );
    const pendingAction = {
      actionName: ai.actionName,
      missingFields,
      collectedFields: finalPayload,
    };

    return {
      success: true,
      status: 'missing_fields',
      agentMode: 'banking_action',
      assistantMessage:
        createClarificationMessage(missingFields, ai.actionName, finalPayload) ||
        createMissingFieldsMessage(missingFields, ai.actionName),
      data: {
        ai: enrichedAi,
        finalPayload,
        missingFields,
        pendingAction,
        ...fileData,
      },
    };
  }

  if (preparation.body.status === 'prepared') {
    const preparationData = preparation.body.data;
    return {
      success: true,
      status: 'action_prepared',
      agentMode: 'banking_action',
      assistantMessage: buildPreparedActionMessage(preparationData, {
        fromFile: true,
      }),
      data: {
        ai,
        finalPayload,
        preparation: preparationData,
        ...fileData,
      },
    };
  }

  return {
    httpStatus: preparation.httpStatus,
    success: preparation.body.success,
    status: preparation.body.status,
    agentMode: 'banking_action',
    assistantMessage:
      preparation.body.message ||
      'I analyzed the PDF, but I could not prepare the suggested action.',
    data: {
      ai,
      finalPayload,
      ...(preparation.body.data || {}),
      ...fileData,
    },
  };
};

const toVisionPdfResponse = async ({
  req,
  trace = null,
  message,
  conversationHistory = [],
  profileContext = {},
  agentContext = {},
  source,
  fileName,
  fileUrl = null,
  mimeType,
  pdfBase64,
  resourceJson = null,
  allowActionPreparation = true,
  attachDownloadAction = true,
  downloadAction: providedDownloadAction = null,
  viewAction: providedViewAction = null,
  requestedActionName = null,
  maxPages = null,
  pageNumbers = null,
  detailMode = false,
}) => {
  const isImagePayload = String(mimeType || '').toLowerCase().startsWith('image/');
  if (!isImagePayload) {
    return buildVisionPdfErrorFromException(new Error(
      'Vision PDF analysis is disabled',
    ), { isImagePayload });
  }

  if (!pdfBase64) {
    console.error(`[${isImagePayload ? 'vision-image' : 'vision-pdf'}] missing visual base64 payload`);
    return buildVisionPdfErrorResponse({
      status: isImagePayload ? 'vision_image_missing_payload' : 'vision_pdf_missing_payload',
      assistantMessage:
        isImagePayload
          ? 'I found the image resource, but the backend could not prepare it for visual analysis.'
          : 'I found the PDF, but the backend could not prepare it for visual analysis.',
    });
  }

  try {
    const visionTimer = startTimer();
    if (env.architectureLogsEnabled) {
      console.log('[ocr-image] backend payload ready:', {
        source,
        payloadType: 'image',
        mimeType: mimeType || 'application/pdf',
        endpoint: '/agent/analyze-vision-document',
        ocrOnly: true,
        payloadLength: String(pdfBase64).length,
        pageNumbers,
        detailMode: Boolean(detailMode),
      });
    }
    logArchitecture('pdf_vision_flow', {
      requestId: trace?.requestId,
      threadId: trace?.threadId,
      event: 'pdf_render_finished',
      selectedPages: pageNumbers || [],
      detailMode: Boolean(detailMode),
      pdfRenderFinished: true,
    });
    logAiContextPrepared({
      trace,
      mode: 'ocr',
      message,
      resources: resourceJson ? [resourceJson] : [],
      context: {
        userRole: req.user.role,
        conversationHistory,
        profileContext: sanitizeProfileContext(profileContext),
        agentContext,
        source,
        fileName,
        mimeType: mimeType || 'application/pdf',
        maxPages,
        pageNumbers,
        detailMode,
        resourceJson: sanitizeResourceMetadataForVision(resourceJson),
      },
    });
    console.log(`[ocr-diag] node_calling_python source=${source} fileName=${fileName} mimeType=${mimeType || 'application/pdf'} payload_length=${String(pdfBase64 || '').length} aiServiceUrl=${env.aiServiceUrl}`);
    const visionResponse = await analyzeVisionDocument({
      requestId: trace?.requestId,
      threadId: trace?.threadId,
      message,
      userRole: req.user.role,
      conversationHistory,
      profileContext: sanitizeProfileContext(profileContext),
      agentContext,
      source,
      fileName,
      mimeType: mimeType || 'application/pdf',
      pdfBase64,
      resourceJson: sanitizeResourceMetadataForVision(resourceJson),
      maxPages,
      pageNumbers,
      detailMode,
    });
    console.log(`[ocr-diag] node_python_response status=${visionResponse?.success} has_data=${Boolean(visionResponse?.data)}`);
    logArchitecture('pdf_vision_flow', {
      requestId: trace?.requestId,
      threadId: trace?.threadId,
      event: 'vision_response_received',
      selectedPages: pageNumbers || [],
      detailMode: Boolean(detailMode),
      latencyMs: endTimer(visionTimer),
    });
    const downloadAction = attachDownloadAction && !isImagePayload
      ? providedDownloadAction || buildPdfDownloadAction({
          fileUrl,
          fileName,
          resourceId: resourceJson?.resourceId || null,
          title: resourceJson?.title || fileName || null,
        })
      : null;
    const viewAction = isImagePayload
      ? providedViewAction || buildImageViewAction({
          fileUrl,
          fileName,
          resourceId: resourceJson?.resourceId || null,
          title: resourceJson?.title || fileName || null,
        })
      : null;
    const visualActions = dedupeQuickActions([downloadAction, viewAction].filter(Boolean));
    let ai = attachPdfDownloadAction(
      normalizeVisionAiForBackend(visionResponse.data, req.user),
      downloadAction,
    );
    if (viewAction) {
      ai = attachQuickActions(ai, [viewAction]);
    }
    ai = {
      ...ai,
      toolInput: {
        ...(ai.toolInput || {}),
        selectedPages: pageNumbers || [],
        detailMode: Boolean(detailMode),
      },
    };
    if (allowActionPreparation && requestedActionName) {
      ai = attachPdfDownloadAction(
        forceVisionActionFromDecision({
          ai,
          actionName: requestedActionName,
          resourceJson,
          user: req.user,
          contextFields: agentContext?.extractedFields || {},
        }),
        downloadAction,
      );
    }
    if (env.architectureLogsEnabled) {
      console.log('[vision-pdf] backend normalized response:', {
        documentType: ai.documentType || 'unknown',
        suggestedAction: ai.suggestedAction || 'none',
        confidence: ai.confidence,
        extractedFieldCount: Object.keys(ai.extractedFields || {}).length,
      });
    }
    const requestedType = getRequestedDocumentType(message);
    const documentMatchesRequest = ai.toolInput?.documentMatchesRequest !== false;
    if (
      !documentMatchesRequest ||
      !isCompatibleDetectedDocumentType(requestedType, ai.documentType)
    ) {
      debugResourceSearchLog('[vision-pdf] rejected mismatched document:', {
        requestedType,
        detectedType: ai.documentType,
        reason: documentMatchesRequest ? 'detected_type_mismatch' : 'model_reported_mismatch',
      });
      return buildDocumentMismatchResponse({
        requestedType,
        detectedType: ai.documentType,
      });
    }

    if (
      allowActionPreparation &&
      ai.actionName &&
      VISION_PREPARABLE_ACTIONS.has(ai.actionName)
    ) {
      return buildVisionPreparedActionResponse({ req, ai });
    }

    if (!allowActionPreparation && VISION_PREPARABLE_ACTIONS.has(ai.actionName)) {
      ai.agentMode = 'file_analysis';
      ai.intent = 'vision_pdf_analysis';
      ai.actionName = null;
      ai.suggestedAction = null;
      ai.requiredTool = 'none';
      ai.extractedFields = {
        ...(ai.extractedFields || {}),
        _visionNoAction: true,
      };
    }

    return {
      success: true,
      status: 'file_analyzed',
      agentMode: ai.agentMode || 'file_analysis',
      assistantMessage: ai.assistantMessage,
      data: {
        ai,
        ...(visualActions.length
          ? {
              document: {
                fileName,
                fileType: isImagePayload ? 'image' : 'pdf',
                ...(downloadAction ? { downloadUrl: downloadAction.downloadUrl } : {}),
                ...(viewAction ? { viewUrl: viewAction.viewUrl } : {}),
              },
              actions: visualActions,
            }
          : {}),
      },
      ...(visualActions.length
        ? {
            document: {
              fileName,
              fileType: isImagePayload ? 'image' : 'pdf',
              ...(downloadAction ? { downloadUrl: downloadAction.downloadUrl } : {}),
              ...(viewAction ? { viewUrl: viewAction.viewUrl } : {}),
            },
            actions: visualActions,
          }
        : {}),
    };
  } catch (error) {
    return buildVisionPdfErrorFromException(error, { isImagePayload });
  }
};

const sanitizeResolvedResourceContextForAi = (resourceContext) => {
  if (!resourceContext) return null;
  const {
    pdfBase64,
    fileBuffer,
    fileText,
    fileTextPreview,
    ...safeContext
  } = resourceContext;
  void pdfBase64;
  void fileBuffer;
  const shouldIncludeText = safeContext.extractionStatus === 'extracted' && typeof fileText === 'string';
  void fileTextPreview;
  return {
    ...safeContext,
    fileText: shouldIncludeText ? fileText : '',
    fileTextPreview: '',
  };
};

const getCatalogLookupText = (resourceQuery, options = {}) => {
  const originalMessage = String(options.originalMessage || resourceQuery || '').trim();
  const lookupText = String(resourceQuery || originalMessage || '').trim();
  if (['receipt', 'document', 'request', 'statement', 'profile', 'overview']
    .includes(normalizeText(lookupText))
  ) {
    return String(originalMessage || lookupText).trim();
  }

  // Description-only catalog scoring needs the FULL user message (e.g. "SME support", "hours"),
  // not a reduced router hint ("branch"). Collapsing a rich question to one weak token mis-ranks
  // the catalog (e.g. picks Customer Profile over Branch Directory). When the original message
  // carries more terms than the hint, search on the message plus the hint as a light booster.
  const messageNorm = normalizeText(originalMessage);
  const hintNorm = normalizeText(lookupText);
  const messageIsRicher =
    messageNorm &&
    messageNorm !== hintNorm &&
    messageNorm.split(/\s+/).filter(Boolean).length > hintNorm.split(/\s+/).filter(Boolean).length;
  const searchBase = messageIsRicher ? `${originalMessage} ${lookupText}`.trim() : lookupText;

  return normalizeResourceSearchQuery(searchBase) || searchBase;
};

const summarizeMatchedResources = (matchedResources = []) =>
  matchedResources.map((resource) => ({
    fileName: resource.fileName,
    score: resource.score,
    resourceType: resource.metadata?.resourceType,
    title: resource.metadata?.title,
    category: resource.metadata?.category || resource.metadata?.resourceType,
    description: resource.metadata?.description || '',
    exampleQueries: Array.isArray(resource.metadata?.exampleQueries)
      ? resource.metadata.exampleQueries
      : [],
    intents: Array.isArray(resource.metadata?.intents) ? resource.metadata.intents : [],
    relatedActions: Array.isArray(resource.metadata?.relatedActions)
      ? resource.metadata.relatedActions
      : [],
    accountId: getResourceAccountId(resource.metadata),
    provider: resource.metadata?.provider,
    period: resource.metadata?.period,
    beneficiaryName: resource.metadata?.beneficiaryName,
    branch: resource.metadata?.branch,
    status: resource.metadata?.status,
  }));

const toResolvedResourceContext = ({
  resolved,
  resourceUrl,
  matchedResource = null,
  matchedResources = [],
  lookupText,
  originalMessage,
  extractionError = null,
}) => {
  const resourceFileType = resolved.resourceFileType || (
    resolved.fileUrl ? 'pdf' : 'json'
  );
  return ({
    resourceUrl,
  resourceJson: resolved.resourceJson,
  fileUrl: resolved.fileUrl,
  fileTextPreview: '',
  fileText: resolved.fileText || '',
  pdfBase64: resourceFileType === 'pdf' && resolved.fileBuffer ? resolved.fileBuffer.toString('base64') : null,
  fileBuffer: resourceFileType === 'image' && resolved.fileBuffer ? resolved.fileBuffer : null,
  fileSize: resolved.fileSize || null,
  contentType: resolved.contentType,
  resourceFileType,
  needsVision: Boolean(resolved.needsVision),
  extractionStatus: resolved.extractionStatus,
    resourceQuery: lookupText || originalMessage,
    matchedResources: summarizeMatchedResources(matchedResources),
    ...(matchedResource
      ? {
          matchedResource: {
            fileName: matchedResource.fileName,
            score: matchedResource.score,
            resourceType: matchedResource.metadata?.resourceType,
            title: matchedResource.metadata?.title,
            category: matchedResource.metadata?.category || matchedResource.metadata?.resourceType,
            description: matchedResource.metadata?.description || '',
            exampleQueries: Array.isArray(matchedResource.metadata?.exampleQueries)
              ? matchedResource.metadata.exampleQueries
              : [],
            intents: Array.isArray(matchedResource.metadata?.intents)
              ? matchedResource.metadata.intents
              : [],
            relatedActions: Array.isArray(matchedResource.metadata?.relatedActions)
              ? matchedResource.metadata.relatedActions
              : [],
          },
        }
      : {}),
    ...(resolved.extractionError || extractionError
      ? { extractionError: resolved.extractionError || extractionError }
      : {}),
  });
};

const selectedCatalogFileForRequest = (metadata = {}, message = '') =>
  selectCatalogFile(Array.isArray(metadata.files) ? metadata.files : [], {
    messageText: message,
  });

const isDocumentRetrievalOnlyRequest = (message = '') => {
  const text = normalizeText(message);
  if (!text) return false;
  const hasRetrievalVerb = /\b(show|open|view|display|download|get|give|fetch|retrieve|send|provide|share)\b/.test(text);
  const hasDocumentNoun = /\b(pdf|document|file|form|guide|sheet|policy|notice|certificate|statement|receipt)\b/.test(text);
  const hasContentQuestion = /\b(read|extract|summarize|summary|what|when|which|how|details?|recommend|contain|say|happened|amount|limit|due|status)\b/.test(text);
  return hasRetrievalVerb && hasDocumentNoun && !hasContentQuestion;
};

const shouldFetchSelectedResourceFile = ({ selectedFile = null, metadata = {}, message = '' } = {}) => {
  const fileType = normalizeText(selectedFile?.fileType || metadata.resourceFileType || '');
  if (fileType === 'image') {
    return requiresImageContentExtraction(message);
  }
  if (fileType === 'pdf') {
    return !isDocumentRetrievalOnlyRequest(message);
  }
  return Boolean(selectedFile?.fileUrl || metadata.fileUrl || metadata.documentUrl || metadata.url);
};

const buildMetadataOnlyResourceContext = ({
  matchedResource = null,
  matchedResources = [],
  lookupText,
  originalMessage,
}) => {
  const metadata = matchedResource?.metadata || {};
  const selectedFile = selectedCatalogFileForRequest(metadata, originalMessage) || {};
  const resourceFileType = selectedFile.fileType || metadata.resourceFileType || 'json';
  return toResolvedResourceContext({
    resolved: {
      resourceJson: {
        ...metadata,
        ...(selectedFile.fileUrl
          ? {
              fileUrl: selectedFile.fileUrl,
              resourceFileType,
              mimeType: selectedFile.mimeType || metadata.mimeType,
            }
          : {}),
      },
      fileUrl: selectedFile.fileUrl || metadata.fileUrl || metadata.documentUrl || metadata.url || null,
      contentType: selectedFile.mimeType || metadata.mimeType || null,
      resourceFileType,
      needsVision: false,
      extractionStatus: 'metadata_only',
    },
    resourceUrl: null,
    matchedResource,
    matchedResources,
    lookupText,
    originalMessage,
  });
};

const resolveMatchedResourceContext = async ({
  resourceUrl,
  matchedResource = null,
  matchedResources = [],
  lookupText,
  originalMessage,
  requestId = null,
}) => {
  const timer = startTimer();
  try {
    const selectedFile = selectedCatalogFileForRequest(matchedResource?.metadata || {}, originalMessage);
    const availableFiles = Array.isArray(matchedResource?.metadata?.files)
      ? matchedResource.metadata.files
      : [];
    // Request-kind for the trace label only (file selection itself is done by selectCatalogFile).
    // Explicit image/visual words → image_read; show/open/download → view_download; otherwise QA.
    const userRequestKind = /\b(image|photo|picture|scan|scanned|qr|screenshot|visual)\b/i.test(originalMessage || '')
      ? 'image_read'
      : isDocumentRetrievalOnlyRequest(originalMessage)
        ? 'view_download'
        : 'qa';
    traceRoute(requestId, 'file_selection', {
      userRequestKind,
      availableFiles: availableFiles.map((file) => ({
        fileType: file.fileType,
        preferredFor: Array.isArray(file.preferredFor) ? file.preferredFor.join('|') : '',
      })),
      selectedFileName: selectedFile?.fileName || null,
      selectedFileType: selectedFile?.fileType || null,
      selectedPreferredFor: Array.isArray(selectedFile?.preferredFor)
        ? selectedFile.preferredFor.join('|')
        : '',
      reason:
        userRequestKind === 'qa'
          ? 'qa_prefers_json_or_field_extraction_sibling'
          : userRequestKind === 'image_read'
            ? 'image_content_requested'
            : 'view_or_download_prefers_pdf',
    });
    if (
      matchedResource?.metadata &&
      !resourceUrl &&
      !shouldFetchSelectedResourceFile({
        selectedFile,
        metadata: matchedResource.metadata,
        message: originalMessage,
      })
    ) {
      traceRoute(requestId, 'trusted_fetch', {
        fetchedUrl: selectedFile?.fileUrl || matchedResource.metadata.fileUrl || 'none',
        didFetchTrustedFile: false,
        fetchStatus: 'metadata_only',
        payloadKind: 'metadata_only',
      });
      const metadataOnlyContext = buildMetadataOnlyResourceContext({
        matchedResource,
        matchedResources,
        lookupText,
        originalMessage,
      });
      logAgentStep(requestId, 'resource_result', {
        success: true,
        resourceId: matchedResource?.fileName || null,
        elapsedMs: endTimer(timer),
        charCount: 0,
        extractionStatus: 'metadata_only',
      });
      return metadataOnlyContext;
    }

    const resolved = resourceUrl
      ? await resolveResource(resourceUrl)
      : await resolveResourcePayload(matchedResource.metadata, null, {
          messageText: originalMessage,
        });
    logAgentStep(requestId, 'pdf_result', {
      success: resolved.extractionStatus !== 'failed',
      resourceId: matchedResource?.fileName || null,
      elapsedMs: endTimer(timer),
      charCount: resolved.fileText ? String(resolved.fileText).length : 0,
      pageCount: resolved.pageCount || null,
      extractionStatus: resolved.extractionStatus,
    });
    const resolvedJson = resolved.resourceJson || {};
    const importantArrays = Object.entries(resolvedJson)
      .filter(([, value]) => Array.isArray(value) && value.length)
      .map(([key]) => key);
    traceRoute(requestId, 'trusted_fetch', {
      fetchedUrl: resolved.fileUrl || 'none',
      didFetchTrustedFile: !['metadata_only', 'blocked_url', 'failed'].includes(resolved.extractionStatus),
      fetchStatus: resolved.extractionStatus,
      contentType: resolved.contentType || null,
      payloadKind: resolved.resourceFileType || 'unknown',
    });
    traceRoute(requestId, 'trusted_parse', {
      hasParsedJson: importantArrays.length > 0 || Object.values(resolvedJson).some((v) => v && typeof v === 'object'),
      jsonTopLevelKeys: Object.keys(resolvedJson).slice(0, 20).join(','),
      detectedImportantArrays: importantArrays.join(',') || 'none',
    });
    return toResolvedResourceContext({
      resolved,
      resourceUrl,
      matchedResource,
      matchedResources,
      lookupText,
      originalMessage,
    });
  } catch (error) {
    if (matchedResource?.metadata) {
      const resolved = await resolveResourcePayload(matchedResource.metadata, null, {
        messageText: originalMessage,
      });
      logAgentStep(requestId, 'pdf_result', {
        success: resolved.extractionStatus !== 'failed',
        resourceId: matchedResource?.fileName || null,
        elapsedMs: endTimer(timer),
        charCount: resolved.fileText ? String(resolved.fileText).length : 0,
        pageCount: resolved.pageCount || null,
        extractionStatus: resolved.extractionStatus,
      });
      return toResolvedResourceContext({
        resolved: {
          ...resolved,
          extractionError: resolved.extractionError || error.message,
        },
        resourceUrl,
        matchedResource,
        matchedResources,
        lookupText,
        originalMessage,
        extractionError: resolved.extractionError || error.message,
      });
    }

    logAgentStep(requestId, 'pdf_result', {
      success: false,
      resourceId: null,
      elapsedMs: endTimer(timer),
      charCount: 0,
      pageCount: null,
      extractionStatus: 'failed',
    });
    return {
      resourceUrl,
      resourceJson: null,
      fileUrl: null,
      fileTextPreview: '',
      fileText: '',
      pdfBase64: null,
      fileSize: null,
      contentType: null,
      extractionStatus: 'failed',
      extractionError: error.message || 'Resource resolution failed',
    };
  }
};

const buildResolvedResourceCandidates = async (resourceQuery, options = {}) => {
  const originalMessage = options.originalMessage || resourceQuery;
  const lookupText = String(resourceQuery || originalMessage || '').trim();
  const catalogLookupText = getCatalogLookupText(resourceQuery, options);
  const explicitResourceUrl =
    extractResourceJsonUrl(originalMessage) || extractResourceJsonUrl(lookupText);

  if (!explicitResourceUrl && isEducationalBankingQuestion(originalMessage)) {
    return [];
  }

  if (explicitResourceUrl) {
    logAgentStep(options.requestId, 'resource_search_started', {
      searchQuery: lookupText,
      filters: { explicitResourceUrl: true },
      indexPath: RESOURCE_JSON_BASE_URL,
    });
    return [
      await resolveMatchedResourceContext({
        resourceUrl: explicitResourceUrl,
        lookupText,
        originalMessage,
        requestId: options.requestId,
      }),
    ];
  }

  logAgentStep(options.requestId, 'resource_search_started', {
    searchQuery: catalogLookupText || originalMessage,
    filters: {
      limit: options.limit || 6,
      minScore: options.minScore || null,
      searchMode: options.searchMode || null,
      allowedResourceTypes: options.allowedResourceTypes || null,
      excludedResourceTypes: options.excludedResourceTypes || null,
    },
    indexPath: RESOURCE_JSON_BASE_URL,
  });
  const effectiveCatalogSearchInput = catalogLookupText || originalMessage;
  // fullMessageKept: did the catalog search retain the message's content tokens (incl. identifiers
  // like the "1" in "Lac 1")? Question words/fillers are intentionally dropped; require >=60% of
  // length>=2 tokens to survive.
  const messageContentTokens = normalizeText(originalMessage)
    .split(/\s+/)
    .filter((token) => token.length >= 2);
  const searchInputNorm = normalizeText(effectiveCatalogSearchInput);
  const keptTokenCount = messageContentTokens.filter((token) => searchInputNorm.includes(token)).length;
  traceRoute(options.requestId, 'catalog_search_input', {
    originalUserMessage: originalMessage,
    resourceHint: lookupText,
    catalogSearchInput: effectiveCatalogSearchInput,
    fullMessageKept: messageContentTokens.length
      ? keptTokenCount / messageContentTokens.length >= 0.6
      : true,
    searchMode: options.searchMode || 'keyword',
  });
  const matchedResources = await findMatchingResources(catalogLookupText || originalMessage, {
    catalog: options.catalog,
    limit: options.limit || 6,
    requestId: options.requestId,
    threadId: options.threadId,
    searchMode: options.searchMode,
    semanticSearch: options.semanticSearch,
    minScore: options.minScore,
    minMargin: options.minMargin,
    allowedResourceTypes: options.allowedResourceTypes,
    excludedResourceTypes: options.excludedResourceTypes,
  });
  traceRoute(options.requestId, 'catalog_candidates', {
    count: matchedResources.length,
    matchFields:
      matchedResources[0]?.metadata?.selectionPolicy?.matchFields?.join(',') || 'description',
    top: matchedResources.slice(0, 5).map((resource, index) => ({
      id: resource.metadata?.resourceId || resource.fileName,
      score: resource.score,
      margin:
        index === 0 && matchedResources[1]
          ? Number(resource.score || 0) - Number(matchedResources[1].score || 0)
          : 0,
    })),
  });
  logAgentStep(options.requestId, 'resource_candidates_found', {
    count: matchedResources.length,
    candidates: matchedResources.slice(0, 3).map((resource) => ({
      resourceId: resource.fileName,
      type: resource.metadata?.resourceType || resource.metadata?.type || null,
      score: resource.score,
    })),
  });

  if (!matchedResources.length) {
    traceRoute(options.requestId, 'resource_selected', {
      selectedResourceId: 'none',
      selectionReason: 'no_catalog_candidates',
    });
    return [];
  }

  if (matchedResources[0]?.ambiguous) {
    traceRoute(options.requestId, 'resource_selected', {
      selectedResourceId: 'none',
      selectionReason: matchedResources[0].selectionReason || 'ambiguous_weak_margin',
    });
    return [{
      ambiguous: true,
      selectionReason: matchedResources[0].selectionReason || 'weak_margin',
      matchedResources,
      resourceQuery: lookupText,
    }];
  }

  const contexts = [];
  const matchedResource = matchedResources[0];
  const resourceUrl = matchedResource.url || null;
  if (matchedResource) {
    debugResourceSearchLog('[resource-catalog] selected candidate:', {
      resourceId: matchedResource.fileName || 'unknown_resource',
      resourceType: matchedResource.metadata?.resourceType || 'unknown',
      score: matchedResource.score,
    });
  }
  const resolvedTopContext = await resolveMatchedResourceContext({
    resourceUrl,
    matchedResource,
    matchedResources,
    lookupText,
    originalMessage,
    requestId: options.requestId,
  });
  if (resolvedTopContext) {
    // Carry the exact text the catalog scored on, for the [ANSWER_PROOF] debug line.
    resolvedTopContext.catalogSearchInput = catalogLookupText || originalMessage || lookupText;
  }
  contexts.push(resolvedTopContext);

  const selectedContext = contexts[0];
  const selectedJson = selectedContext?.resourceJson || selectedContext?.matchedResource || {};
  if (selectedContext) {
    logAgentStep(options.requestId, 'resource_selected', {
      resourceId: selectedContext.matchedResource?.fileName || selectedJson.resourceId || null,
      type: selectedJson.resourceType || selectedContext.matchedResource?.resourceType || null,
      reasonCode: 'highest_scoring_resource_candidate',
      metadata: safeMetadata(selectedJson),
    });
    traceRoute(options.requestId, 'resource_selected', {
      selectedResourceId:
        selectedJson.resourceId || matchedResource.metadata?.resourceId || matchedResource.fileName || 'none',
      selectedTitle: selectedJson.title || matchedResource.metadata?.title || null,
      selectedScore: matchedResource.score,
      selectionReason: 'highest_scoring_description_match',
    });
  }

  return contexts;
};

const buildResolvedResourceContext = async (resourceQuery, options = {}) => {
  const candidates = await buildResolvedResourceCandidates(resourceQuery, options);
  const best = candidates[0] || null;

  if (best?.matchedResource) {
    debugResourceSearchLog('[resource-catalog] resource selected:', {
      resourceId: best.matchedResource.fileName || 'unknown_resource',
      resourceType: best.matchedResource.resourceType || 'unknown',
      score: best.matchedResource.score,
    });
  }

  return best;
};

const buildVisionResponseFromResourceCandidates = async ({
  req,
  trace = null,
  message,
  conversationHistory = [],
  profileContext = {},
  agentContext = {},
  aiDecision = {},
  candidates = [],
  pageNumbers = null,
  detailMode = false,
}) => {
  let lastMismatch = null;

  for (const resolvedResourceContext of candidates) {
    if (!isVisualResourceContext(resolvedResourceContext)) {
      continue;
    }
    const isImageResource = isImageFileReference(
      resolvedResourceContext.fileUrl,
      resolvedResourceContext.contentType,
      resolvedResourceContext.resourceJson || {},
    ) || resolvedResourceContext.resourceFileType === 'image';
    if (isImageResource) {
      const imageResponse = await resolveImageResourceResponse({
        req,
        message,
        trace,
        routerDecision: {
          case: CASES.LARAGON_RESOURCE_METADATA,
          modelMode: 'text',
          needsResourceSearch: true,
          needsPdfVision: false,
          plannerDecision: aiDecision,
        },
        memory: {
          recentMessages: Array.isArray(conversationHistory)
            ? conversationHistory.map((entry) => ({
                role: entry.role,
                content: entry.content || entry.message || '',
              }))
            : [],
        },
        resourceContext: resolvedResourceContext,
      });
      return {
        visionResult: imageResponse.response,
        resolvedResourceContext,
      };
    }

    lastMismatch = buildVisionPdfErrorResponse({
      status: 'vision_pdf_disabled',
      assistantMessage:
        'I found the PDF, but visual PDF analysis is disabled. I can answer only from extracted text or metadata.',
    });
    continue;

    const fileName = getFileNameFromUrl(resolvedResourceContext.fileUrl);
    let visionPayload = await prepareVisionPayloadFromResourceContext({
      resourceContext: resolvedResourceContext,
      isImageResource,
      trace,
      fileName,
    });
    if (!visionPayload?.base64) {
      lastMismatch = buildVisionPdfErrorResponse({
        status: isImageResource ? 'vision_image_missing_payload' : 'vision_pdf_missing_payload',
        assistantMessage: isImageResource
          ? 'I found the image resource, but the backend could not prepare it for visual analysis.'
          : 'I found the PDF, but the backend could not prepare it for visual analysis.',
      });
      continue;
    }

    let visionResult;
    try {
      visionResult = await toVisionPdfResponse({
        req,
        trace,
        message,
        conversationHistory,
        profileContext,
        agentContext: mergeDecisionIntoAgentContext(agentContext, aiDecision),
        source: isImageResource ? 'laragon_resource_image' : 'laragon_resource',
        fileName,
        fileUrl: resolvedResourceContext.fileUrl,
        mimeType: visionPayload.mimeType || resolvedResourceContext.contentType || (isImageResource ? 'image/jpeg' : 'application/pdf'),
        pdfBase64: visionPayload.base64,
        resourceJson: resolvedResourceContext.resourceJson,
        allowActionPreparation: shouldAllowVisionActionPreparation(
          message,
          aiDecision,
        ) && !detailMode,
        attachDownloadAction: !isImageResource && shouldAttachPdfDownloadForRequest(
          message,
          resolvedResourceContext.resourceJson,
        ),
        viewAction: isImageResource
          ? buildImageViewAction({
              fileUrl: resolvedResourceContext.fileUrl,
              fileName,
              resourceId: resolvedResourceContext.resourceJson?.resourceId || resolvedResourceContext.matchedResource?.fileName || null,
              title: resolvedResourceContext.resourceJson?.title || fileName || null,
            })
          : null,
        requestedActionName: aiDecision.action || null,
        maxPages: pageNumbers?.length || null,
        pageNumbers,
        detailMode,
      });
    } finally {
      if (visionPayload) {
        visionPayload.base64 = '';
      }
      visionPayload = null;
      if (isImageResource && resolvedResourceContext.fileBuffer) {
        resolvedResourceContext.fileBuffer = null;
      }
    }

    if (visionResult.status === 'resource_mismatch') {
      lastMismatch = visionResult;
      debugResourceSearchLog('[vision-pdf] trying next resource candidate after mismatch');
      continue;
    }

    return { visionResult, resolvedResourceContext };
  }

  return lastMismatch ? { visionResult: lastMismatch, resolvedResourceContext: null } : null;
};

const formatResourceQueryLabel = (value = '') =>
  normalizeText(value)
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();

const buildResourceNotFoundResponse = (resourceQuery = '') => {
  const queryLabel = formatResourceQueryLabel(resourceQuery);
  const assistantMessage = queryLabel
    ? `I could not find a matching ${queryLabel} resource in the resource server.`
    : RESOURCE_NOT_FOUND_MESSAGE;

  return {
    success: true,
    status: 'resource_not_found',
    agentMode: 'informational_answer',
    assistantMessage,
    data: {
      ai: {
        source: 'resource_catalog',
        language: 'english',
        agentMode: 'informational_answer',
        intent: 'resource_not_found',
        actionName: null,
        confidence: 1,
        missingFields: [],
        extractedFields: {},
        requiredTool: 'none',
        toolInput: { quickActions: RESOURCE_NOT_FOUND_OPTIONS },
        assistantMessage,
      },
    },
  };
};

// Documents the assistant can generate on demand (no static resource file exists for them).
const GENERATABLE_STATEMENT_TYPE = 'account_statement';

// True only when the user explicitly wants a NEW statement produced. A retrieval verb
// (download/open/view/get/show...) always means "fetch the existing file", never generate, so
// "Download my card statement PDF" goes through the normal resource download flow.
const isStatementGenerationRequest = (message = '') => {
  const text = normalizeText(message);
  if (!/\b(statement|releve|report)\b/.test(text)) return false;
  if (/\b(download|open|view|show|get|fetch|find|access|retrieve)\b/.test(text)) return false;
  return /\b(generate|create|produce|issue|make|prepare|new)\b/.test(text);
};

// Asked only when a NEW statement must be generated and no existing PDF resource matched.
// Carries no Download action because no file is ready yet.
const buildStatementGenerationClarification = () => {
  const assistantMessage =
    'I can generate a new **account statement** for you. I just need two details:\n' +
    '**Account:** which account should it cover, for example acc_001?\n' +
    '**Period:** which statement period do you need, for example May 2026?';

  return {
    success: true,
    status: 'answered',
    agentMode: 'informational_answer',
    assistantMessage,
    data: {
      ai: {
        source: 'resource_catalog',
        language: 'english',
        agentMode: 'informational_answer',
        intent: 'document_generation_clarification',
        actionName: null,
        confidence: 1,
        missingFields: ['accountId', 'period'],
        extractedFields: { documentType: GENERATABLE_STATEMENT_TYPE },
        requiredTool: 'none',
        toolInput: { resourceFound: false, requiresGeneration: true },
        assistantMessage,
      },
    },
  };
};

const buildPlannerResourceNoMatchResponse = () => {
  const assistantMessage =
    'I checked the available banking resources, but I could not find a matching document or record for that request. You can give me a reference, provider, document name, account, or date and I will search again.';

  return {
    success: true,
    status: 'resource_no_match',
    agentMode: 'informational_answer',
    assistantMessage,
    data: {
      ai: {
        source: 'resource_catalog',
        language: 'english',
        agentMode: 'informational_answer',
        intent: 'resource_no_match',
        actionName: null,
        confidence: 1,
        missingFields: [],
        extractedFields: {},
        requiredTool: 'none',
        toolInput: {
          resourceFound: false,
        },
        assistantMessage,
      },
    },
  };
};

const buildResourceAmbiguityResponse = (matches = []) => {
  const candidates = matches
    .slice(0, 5)
    .map((resource) => ({
      title: resource.metadata?.title || 'Resource',
      resourceId: resource.metadata?.resourceId || resource.metadata?.id || null,
      score: resource.score,
    }));
  const names = candidates.map((candidate) => `**${candidate.title}**`).join(', ');
  const assistantMessage = candidates.length
    ? `I found multiple close resource matches: ${names}. Which one should I use?`
    : 'I found multiple close resource matches. Which one should I use?';
  const quickActions = candidates.map((candidate) => ({
    label: candidate.title,
    action: 'prompt',
    prompt: `Use ${candidate.title}`,
    value: candidate.resourceId || candidate.title,
  }));

  return {
    success: true,
    status: 'resource_clarification',
    agentMode: 'informational_answer',
    assistantMessage,
    data: {
      ai: {
        source: 'resource_catalog',
        language: 'english',
        agentMode: 'informational_answer',
        intent: 'resource_clarification',
        actionName: null,
        confidence: 0.6,
        missingFields: [],
        extractedFields: {},
        requiredTool: 'none',
        toolInput: {
          clarificationRequired: true,
          quickActions,
        },
        assistantMessage,
      },
      resourceMatches: candidates,
    },
  };
};

const buildSpecificDocumentNotFoundResponse = () => {
  const assistantMessage =
    'I could not find that specific document. Do you want me to search another document type?';

  return {
    success: true,
    status: 'resource_not_found',
    agentMode: 'informational_answer',
    assistantMessage,
    data: {
      ai: {
        source: 'resource_catalog',
        language: 'english',
        agentMode: 'informational_answer',
        intent: 'specific_document_not_found',
        actionName: null,
        confidence: 1,
        missingFields: [],
        extractedFields: {},
        requiredTool: 'none',
        toolInput: { quickActions: RESOURCE_NOT_FOUND_OPTIONS },
        assistantMessage,
      },
    },
  };
};

const buildTransferRequestNotFoundResponse = () => {
  const assistantMessage =
    'I could not find the transfer request. Do you want me to prepare a new transfer instead?';

  return {
    success: true,
    status: 'resource_not_found',
    agentMode: 'informational_answer',
    assistantMessage,
    data: {
      ai: {
        source: 'resource_catalog',
        language: 'english',
        agentMode: 'informational_answer',
        intent: 'transfer_request_not_found',
        actionName: null,
        confidence: 1,
        missingFields: [],
        extractedFields: { _visionNoAction: true },
        requiredTool: 'none',
        toolInput: {
          quickActions: [
            {
              label: 'Prepare transfer',
              value: 'Prepare transfer',
              action: 'prompt',
              prompt: 'Prepare a new transfer',
            },
          ],
        },
        assistantMessage,
      },
    },
  };
};

const BROAD_RESOURCE_SEARCH_CONFIG = {
  account: {
    label: 'acc_001-linked',
    query: 'acc_001 account sourceAccountId accountId',
    allowedResourceTypes: null,
    priority: [
      'bill_payment',
      'bill',
      'standing_order',
      'salary_certificate',
      'atm_receipt',
      'customer_profile',
      'account_statement',
      'payment_receipt',
      'international_transfer_request',
      'checkbook_request',
    ],
  },
  card: {
    label: 'card-related',
    query: 'card debit card credit card card limit card replacement card dispute card pickup appointment',
    allowedResourceTypes: [
      'card_limit_notice',
      'card_service_request',
      'card_dispute',
      'appointment_confirmation',
      'card_pickup_appointment',
      'atm_receipt',
      'payment_receipt',
    ],
    priority: [
      'card_limit_notice',
      'card_service_request',
      'card_dispute',
      'appointment_confirmation',
      'card_pickup_appointment',
      'atm_receipt',
      'payment_receipt',
    ],
  },
  payments: {
    label: 'payment-related',
    query: 'payment payments bill bills receipt receipts invoice provider transfer standing order exchange',
    allowedResourceTypes: [
      'bill',
      'bill_notice',
      'bill_payment',
      'utility_bill',
      'invoice',
      'payment_receipt',
      'atm_receipt',
      'fx_receipt',
      'standing_order',
      'transfer_order',
      'international_transfer_request',
      'beneficiary_profile',
    ],
    priority: [
      'bill',
      'bill_notice',
      'payment_receipt',
      'atm_receipt',
      'fx_receipt',
      'standing_order',
      'transfer_order',
      'international_transfer_request',
      'beneficiary_profile',
    ],
  },
  appointments: {
    label: 'appointment-related',
    query: 'appointment appointments meeting branch advisor request date time',
    allowedResourceTypes: [
      'appointment_confirmation',
      'card_pickup_appointment',
      'appointment_request',
    ],
    priority: [
      'appointment_confirmation',
      'card_pickup_appointment',
      'appointment_request',
    ],
  },
  documents: {
    label: 'document-related',
    query: 'document documents form certificate statement product sheet guide notice policy receipt request pdf',
    allowedResourceTypes: [
      'account_statement',
      'rib_certificate',
      'account_certificate',
      'salary_certificate',
      'tax_form',
      'product_sheet',
      'digital_banking_guide',
      'atb_connect_guide',
      'security_notice',
      'insurance_policy',
      'account_closure_request',
      'checkbook_request',
      'cheque_book_request',
      'card_service_request',
      'atm_receipt',
      'payment_receipt',
      'fx_receipt',
      'transfer_order',
      'beneficiary_profile',
    ],
    priority: [
      'account_statement',
      'rib_certificate',
      'account_certificate',
      'salary_certificate',
      'tax_form',
      'product_sheet',
      'digital_banking_guide',
      'security_notice',
      'insurance_policy',
      'account_closure_request',
      'checkbook_request',
      'card_service_request',
      'atm_receipt',
      'payment_receipt',
      'fx_receipt',
      'beneficiary_profile',
    ],
  },
  transfers: {
    label: 'transfer-related',
    query: 'transfer transfers standing order beneficiary international request source account amount status',
    allowedResourceTypes: null,
    priority: [
      'transfer_order',
      'international_transfer_request',
      'standing_order',
      'beneficiary_profile',
      'transfer_dispute',
      'payment_receipt',
    ],
  },
  insurance: {
    label: 'insurance-related',
    query: 'insurance policy premium certificate document notice status',
    allowedResourceTypes: null,
    priority: [
      'insurance_policy',
      'salary_certificate',
      'account_certificate',
      'tax_form',
    ],
  },
};

const broadSearchCategoryFromMessage = (message = '') => {
  const text = normalizeText(message);
  if (!text) return null;

  const hasSearchVerb = /\b(find|show|list|search|get|look for|which|display)\b/.test(text) ||
    /\bdo i have\b/.test(text);
  const hasBroadScope = /\b(anything|everything|all|any|linked|related|about|resources?|records?|files?|documents?|certificates?)\b/.test(text);
  if (/\bacc\s*[_-]?\s*\d{3,}\b/.test(text) && hasBroadScope) return 'account';
  if (!hasSearchVerb || !hasBroadScope) return null;

  if (
    text.includes('card pickup') &&
    /\b(appointment|meeting|visit|rendez vous)\b/.test(text)
  ) {
    return null;
  }

  if (/\bacc\s*[_-]?\s*\d{3,}\b/.test(text)) return 'account';
  if (/\b(cards?|debit card|credit card)\b/.test(text)) return 'card';
  if (/\b(payments?|bills?|receipts?|invoices?)\b/.test(text)) return 'payments';
  if (/\b(appointments?|meetings?|rendez vous)\b/.test(text)) return 'appointments';
  if (/\b(documents?|forms?|certificates?|pdfs?|files?)\b/.test(text)) return 'documents';
  if (/\b(transfers?|standing order|beneficiar(?:y|ies))\b/.test(text)) return 'transfers';
  if (/\b(insurance|policy|premium)\b/.test(text)) return 'insurance';

  return null;
};

const isExplicitBroadResourceSearchMessage = (message = '') => {
  const text = normalizeText(message);
  const hasSearchVerb = /\b(find|show|list|search|get|look for|which|display)\b/.test(text) ||
    /\bdo i have\b/.test(text);
  const hasBroadScope = /\b(anything|everything|all|any|linked|related|about|resources?|records?|files?|documents?|certificates?)\b/.test(text);
  return hasSearchVerb && hasBroadScope;
};

const resourceMetadataText = (metadata = {}) =>
  normalizeText(JSON.stringify(metadata || {}));

const isImageResourceMetadata = (metadata = {}) =>
  metadata.resourceFileType === 'image' ||
  isImageFileReference(
    metadata.fileUrl || metadata.documentUrl || metadata.url || metadata.fileName || '',
    metadata.mimeType || metadata.contentType || '',
    metadata,
  );

const SEARCH_LIST_STOP_WORDS = new Set([
  'about',
  'all',
  'any',
  'anything',
  'are',
  'display',
  'documents',
  'everything',
  'files',
  'find',
  'get',
  'have',
  'linked',
  'list',
  'look',
  'me',
  'my',
  'records',
  'related',
  'resources',
  'search',
  'show',
  'the',
  'to',
  'which',
]);

const tokenizeSearchText = (value = '') =>
  normalizeText(value)
    .split(/\s+/)
    .map((token) => token.replace(/^\.+|\.+$/g, ''))
    .filter((token) => token.length >= 2 && !SEARCH_LIST_STOP_WORDS.has(token));

const firstAccountIdFromMessage = (message = '') => {
  const match = String(message || '').match(/\bacc\s*[_-]?\s*(\d{3,})\b/i);
  return match ? `acc_${match[1]}` : null;
};

const buildGenericResourceSearchQuery = (message = '') => {
  const accountId = firstAccountIdFromMessage(message);
  if (accountId) return accountId;

  const text = normalizeText(message)
    .replace(/\b(do i have|look for|related to|linked to|associated with)\b/g, ' ')
    .replace(/\bor\b/g, ' ');
  return Array.from(new Set(tokenizeSearchText(text))).join(' ');
};

const CATEGORY_ONLY_SEARCH_TERMS = {
  account: new Set(['account', 'accounts']),
  card: new Set(['card', 'cards', 'debit', 'credit']),
  payments: new Set(['payment', 'payments', 'bill', 'bills', 'receipt', 'receipts', 'invoice', 'invoices']),
  appointments: new Set(['appointment', 'appointments', 'meeting', 'meetings', 'rendez', 'vous']),
  documents: new Set(['document', 'documents', 'certificate', 'certificates', 'form', 'forms', 'pdf', 'pdfs', 'file', 'files']),
  transfers: new Set(['transfer', 'transfers', 'beneficiary', 'beneficiaries']),
  insurance: new Set(['insurance', 'policy', 'premium']),
};

const hasSpecificSearchListQuery = (category, genericQuery = '') => {
  const categoryTerms = CATEGORY_ONLY_SEARCH_TERMS[category] || new Set();
  const tokens = tokenizeSearchText(genericQuery);
  return tokens.some((token) => !categoryTerms.has(token));
};

const SPECIFIC_RESOURCE_QUERY_NOISE_TERMS = new Set([
  ...SEARCH_LIST_STOP_WORDS,
  'download',
  'file',
  'give',
  'image',
  'img',
  'open',
  'pdf',
  'photo',
  'picture',
  'please',
  'read',
  'resource',
  'view',
]);

const specificResourceTokens = (value = '') =>
  tokenizeSearchText(value).filter((token) => !SPECIFIC_RESOURCE_QUERY_NOISE_TERMS.has(token));

const titleMatchProfile = (resource = {}, query = '') => {
  const title = normalizeText(broadResourceTitle(resource));
  const titleTokens = specificResourceTokens(title);
  const queryText = normalizeText(query);
  const queryTokens = new Set(specificResourceTokens(queryText));
  const matchedTokens = titleTokens.filter((token) => queryTokens.has(token));
  const coverage = titleTokens.length ? matchedTokens.length / titleTokens.length : 0;

  return {
    phraseMatch: Boolean(title && queryText.includes(title)),
    matchedCount: matchedTokens.length,
    coverage,
  };
};

const findDominantSpecificResourceMatch = (query = '', matches = []) => {
  const best = matches[0] || null;
  if (!best) return null;

  const profile = titleMatchProfile(best, query);
  const strongTitleMatch =
    profile.phraseMatch ||
    (profile.coverage >= 0.75 && profile.matchedCount >= 3);
  if (!strongTitleMatch) return null;

  const second = matches[1] || null;
  const bestScore = Number(best.score || 0);
  const secondScore = Number(second?.score || 0);
  const hasClearLead =
    !second ||
    bestScore >= secondScore + 15 ||
    bestScore >= secondScore * 1.5;

  return hasClearLead ? best : null;
};

// Returns true when Ollama should rerank: small score gap OR entity-specific query with no
// dominant deterministic winner. Never called when matches has only one entry.
const shouldOllamaRerank = (message = '', matches = [], specificMatch = null) => {
  if (matches.length < 2) return false;
  if (specificMatch) return false; // deterministic already found a clear winner
  const topScore = Number(matches[0]?.score || 0);
  const secondScore = Number(matches[1]?.score || 0);
  // Tight gap: second candidate is close enough that entity semantics should decide
  if (topScore - secondScore < 12) return true;
  // Mixed message: contains a proper-name entity alongside generic banking words
  const hasProperName = /\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})+\b/.test(message);
  const hasGenericBanking = /\b(payment|card|receipt|alert|account|transfer|bill|invoice|statement)\b/i.test(message);
  return hasProperName && hasGenericBanking;
};

// Calls Ollama reranker and returns the candidate match that best fits the user message.
// Falls back silently to matches[0] on any error.
const rerankMatchCandidates = async ({ message, matches, requestId, threadId }) => {
  const candidates = matches.slice(0, 5).map((m, idx) => ({
    id: m.metadata?.resourceId || m.metadata?.id || m.resourceId || `candidate-${idx}`,
    title: m.metadata?.title || m.title || '',
    category: m.metadata?.category || m.metadata?.resourceType || '',
    description: m.metadata?.description || '',
    exampleQueries: Array.isArray(m.metadata?.exampleQueries) ? m.metadata.exampleQueries : [],
    intents: Array.isArray(m.metadata?.intents) ? m.metadata.intents : [],
    relatedActions: Array.isArray(m.metadata?.relatedActions) ? m.metadata.relatedActions : [],
  }));
  try {
    const rerankResult = await rerankResources({ requestId, threadId, message, candidates });
    const chosenId = rerankResult?.data?.chosenId;
    if (chosenId) {
      const chosen = matches.find((m, idx) => {
        const id = m.metadata?.resourceId || m.metadata?.id || m.resourceId || `candidate-${idx}`;
        return id === chosenId;
      });
      if (chosen) return chosen;
    }
  } catch {
    // Reranker unavailable — fall through to matches[0]
  }
  return matches[0];
};

const resourceSearchListRequestFromMessage = (message = '', aiDecision = {}) => {
  const category = broadSearchCategoryFromMessage(message);
  const accountId = firstAccountIdFromMessage(message);

  if (category && isExplicitBroadResourceSearchMessage(message)) {
    const config = BROAD_RESOURCE_SEARCH_CONFIG[category] || {};
    const genericQuery = buildGenericResourceSearchQuery(message);
    const query = accountId || [config.query, genericQuery].filter(Boolean).join(' ');
    return {
      category,
      label: accountId ? `${accountId}-linked` : (config.label || `${category}-related`),
      query,
      priority: config.priority || [],
      accountId,
      scoreFirst: hasSpecificSearchListQuery(category, genericQuery),
    };
  }

  if (aiDecision.intent === 'broad_resource_search') {
    const decisionCategory = normalizeResourceType(aiDecision.resourceQuery);
    const config = BROAD_RESOURCE_SEARCH_CONFIG[decisionCategory] || {};
    return {
      category: config.query ? decisionCategory : 'generic',
      label: config.label || 'matching',
      query: config.query || aiDecision.resourceQuery || buildGenericResourceSearchQuery(message),
      priority: config.priority || [],
      accountId,
      scoreFirst: false,
    };
  }

  if (!isExplicitBroadResourceSearchMessage(message)) return null;

  const query = buildGenericResourceSearchQuery(message);
  if (!query) return null;

  return {
    category: 'generic',
    label: 'matching',
    query,
    priority: [],
    accountId,
    scoreFirst: true,
  };
};

const shouldIncludeBroadResourceMatch = (category, resource = {}) => {
  const resourceType = normalizeResourceType(resource.metadata?.resourceType);
  const text = resourceMetadataText(resource.metadata);

  if (category === 'card') {
    if (['atm_receipt', 'payment_receipt'].includes(resourceType)) {
      return /\b(card|debit|credit)\b/.test(text);
    }
    if (resourceType === 'appointment_confirmation') {
      return text.includes('card pickup') || text.includes('pickup');
    }
  }

  if (category === 'account') {
    return /\b(account|source account|debit account|iban|rib|salary|standing order|bill|receipt|certificate)\b/.test(text);
  }

  return true;
};

const broadResourcePriority = (category, resource = {}) => {
  const config = BROAD_RESOURCE_SEARCH_CONFIG[category];
  const resourceType = normalizeResourceType(resource.metadata?.resourceType);
  const index = config?.priority?.indexOf(resourceType) ?? -1;
  if (category === 'payments') {
    const text = resourceMetadataText(resource.metadata);
    if (isImageResourceMetadata(resource.metadata) && /\b(payment|receipt|invoice|merchant|qr)\b/.test(text)) {
      return 2.5;
    }
    if (resource.metadata?.resourceFileType === 'txt' && /\b(payment|bill|receipt|invoice|merchant)\b/.test(text)) {
      return 4.5;
    }
  }
  return index >= 0 ? index : 999;
};

const broadResourceTitle = (resource = {}) =>
  resource.metadata?.title || resource.fileName || 'Resource';

const SEARCH_LIST_TECHNICAL_FIELDS = new Set([
  'body',
  'content',
  'customerid',
  'debug',
  'documenturl',
  'environment',
  'fileurl',
  'jsonurl',
  'keywords',
  'localpathhint',
  'metadata',
  'mimetype',
  'path',
  'resourceid',
  'resourcetype',
  'resourceurl',
  'service',
  'synthetic',
  'text',
  'url',
]);

const SEARCH_LIST_FIELD_PRIORITY = [
  'name',
  'fullname',
  'customername',
  'segment',
  'branch',
  'primarybranch',
  'preferredlanguage',
  'provider',
  'beneficiaryname',
  'amount',
  'limit',
  'currentlimit',
  'availablelimit',
  'fee',
  'rate',
  'premium',
  'status',
  'requeststatus',
  'signaturestatus',
  'risklevel',
  'duedate',
  'paymentduedate',
  'statementdate',
  'nextexecutiondate',
  'appointmentdate',
  'date',
  'time',
  'startdate',
  'relationshipstartdate',
  'enddate',
  'sourceaccountid',
  'accountid',
  'requestid',
  'receiptid',
  'billid',
  'certificateid',
  'policyid',
  'reference',
];

const SEARCH_LIST_FIELD_CONTAINERS = new Set([
  'fields',
  'extractedfields',
  'metadata',
  'data',
  'content',
  'parsedfields',
]);

const SEARCH_LIST_LABEL_OVERRIDES = {
  accountid: 'Account',
  availablelimit: 'Available limit',
  billreference: 'Bill reference',
  currentlimit: 'Current limit',
  fullname: 'Full name',
  paymentduedate: 'Payment due date',
  preferredlanguage: 'Preferred language',
  primarybranch: 'Primary branch',
  sourceaccountid: 'Source account',
};

const normalizedResourceKey = (key = '') =>
  String(key || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const humanizeResourceFieldLabel = (key = '') => {
  const normalizedKey = normalizedResourceKey(key);
  if (SEARCH_LIST_LABEL_OVERRIDES[normalizedKey]) {
    return SEARCH_LIST_LABEL_OVERRIDES[normalizedKey];
  }

  const words = String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  if (!words) return '';

  return words
    .replace(/^./, (char) => char.toUpperCase())
    .replace(/\b(id|rib|iban|atm|pdf)\b/gi, (match) => match.toUpperCase());
};

const searchListFieldRank = (key = '') => {
  const normalizedKey = normalizedResourceKey(key);
  const exactIndex = SEARCH_LIST_FIELD_PRIORITY.indexOf(normalizedKey);
  if (exactIndex >= 0) return exactIndex;

  const buckets = [
    ['name', 'segment', 'branch', 'language', 'provider', 'beneficiary'],
    ['amount', 'limit', 'fee', 'rate', 'premium', 'balance', 'payment'],
    ['status', 'risk'],
    ['date', 'start', 'end', 'execution', 'time'],
    ['account', 'id', 'reference', 'receipt', 'certificate', 'policy', 'bill'],
  ];

  for (let index = 0; index < buckets.length; index += 1) {
    if (buckets[index].some((term) => normalizedKey.includes(term))) {
      return 100 + index * 100;
    }
  }

  if (normalizedKey === 'category') return 900;
  return 700;
};

const isScalarSearchListValue = (value) =>
  value !== null && value !== undefined && !Array.isArray(value) && typeof value !== 'object';

const stringifySearchListValue = (value) => {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    return value
      .filter(isScalarSearchListValue)
      .map((item) => String(item).trim())
      .filter(Boolean)
      .slice(0, 6)
      .join(', ');
  }
  return String(value ?? '').trim();
};

const addSearchListField = (fieldsByKey, key, value, order, depth = 0) => {
  const normalizedKey = normalizedResourceKey(key);
  if (
    !normalizedKey ||
    normalizedKey === 'title' ||
    SEARCH_LIST_TECHNICAL_FIELDS.has(normalizedKey)
  ) {
    return order;
  }

  const text = stringifySearchListValue(value);
  if (!text) return order;

  const candidate = {
    key,
    value: text.replace(/\s+/g, ' '),
    rank: searchListFieldRank(key),
    order,
    depth,
  };
  const existing = fieldsByKey.get(normalizedKey);
  if (
    !existing ||
    candidate.rank < existing.rank ||
    (candidate.rank === existing.rank && candidate.depth < existing.depth) ||
    (
      candidate.rank === existing.rank &&
      candidate.depth === existing.depth &&
      candidate.order < existing.order
    )
  ) {
    fieldsByKey.set(normalizedKey, candidate);
  }

  return order + 1;
};

const fieldValueFromSearchListRow = (row = {}) => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const label = row.field || row.Field || row.label || row.Label || row.key || row.Key || row.name || row.Name;
  const value = Object.prototype.hasOwnProperty.call(row, 'value') ? row.value : row.Value;
  return label !== undefined && value !== undefined ? [label, value] : null;
};

const collectSearchListFields = (value, fieldsByKey = new Map(), order = 0, depth = 0) => {
  if (depth > 4 || value === null || value === undefined) {
    return { fieldsByKey, order };
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (Array.isArray(item) && item.length >= 2) {
        order = addSearchListField(fieldsByKey, item[0], item[1], order, depth);
      } else if (item && typeof item === 'object') {
        const row = fieldValueFromSearchListRow(item);
        if (row) {
          order = addSearchListField(fieldsByKey, row[0], row[1], order, depth);
        } else {
          ({ fieldsByKey, order } = collectSearchListFields(item, fieldsByKey, order, depth + 1));
        }
      }
    }
    return { fieldsByKey, order };
  }

  if (typeof value !== 'object') {
    return { fieldsByKey, order };
  }

  const row = fieldValueFromSearchListRow(value);
  if (row) {
    order = addSearchListField(fieldsByKey, row[0], row[1], order, depth);
    return { fieldsByKey, order };
  }

  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = normalizedResourceKey(key);
    if (SEARCH_LIST_FIELD_CONTAINERS.has(normalizedKey) && typeof item === 'object') {
      ({ fieldsByKey, order } = collectSearchListFields(item, fieldsByKey, order, depth + 1));
      continue;
    }
    if (isScalarSearchListValue(item) || (Array.isArray(item) && item.every(isScalarSearchListValue))) {
      order = addSearchListField(fieldsByKey, key, item, order, depth);
    } else if (Array.isArray(item)) {
      ({ fieldsByKey, order } = collectSearchListFields(item, fieldsByKey, order, depth + 1));
    }
  }

  return { fieldsByKey, order };
};

const importantResourceFieldsForList = (metadata = {}, limit = 4) => {
  const { fieldsByKey } = collectSearchListFields(metadata);
  const rows = Array.from(fieldsByKey.values())
    .filter((item) => normalizedResourceKey(item.key) !== 'category')
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, limit);

  return rows.map((item) => ({
    label: humanizeResourceFieldLabel(item.key),
    value: item.value,
  }));
};

const markdownSafeInline = (value = '') =>
  String(value || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();

const matchReasonForResource = (resource = {}, descriptor = {}) => {
  const metadata = resource.metadata || {};
  const text = resourceMetadataText(metadata);
  const title = normalizeText(broadResourceTitle(resource));
  const query = normalizeText(descriptor.query || '');
  const queryTokens = tokenizeSearchText(query);

  if (descriptor.accountId && text.includes(normalizeText(descriptor.accountId))) {
    return `matched because its fields contain ${descriptor.accountId}.`;
  }

  const titleToken = queryTokens.find((token) => title.includes(token));
  if (titleToken) {
    return `matched because its title mentions ${titleToken}.`;
  }

  const provider = metadata.provider || metadata.biller || metadata.merchant;
  if (provider && queryTokens.some((token) => normalizeText(provider).includes(token))) {
    return `matched because the provider is ${provider}.`;
  }

  const resourceType = normalizeResourceType(metadata.resourceType);
  if (resourceType) {
    const typeLabel = humanizeResourceFieldLabel(resourceType);
    if (
      queryTokens.some((token) => normalizeText(typeLabel).includes(token)) ||
      descriptor.priority?.includes(resourceType)
    ) {
      return `matched because it is a ${typeLabel.toLowerCase()} resource.`;
    }
  }

  const fieldToken = queryTokens.find((token) => text.includes(token));
  if (fieldToken) {
    return `matched because its details include ${fieldToken}.`;
  }

  return broadResourceDescription(resource);
};

const buildResourceSearchListNoMatchResponse = (descriptor = {}) => {
  const queryLabel = descriptor.query || descriptor.label || 'that search';
  const assistantMessage = [
    `I did not find matching resources for **${markdownSafeInline(queryLabel)}**.`,
    '',
    'Try a broader category such as card, payments, appointments, documents, certificates, transfers, insurance, or an account ID like acc_001.',
  ].join('\n');

  return {
    success: true,
    status: 'resource_matches_none',
    agentMode: 'informational_answer',
    assistantMessage,
    actions: [],
    data: {
      ai: {
        source: 'resource_catalog',
        language: 'english',
        agentMode: 'informational_answer',
        intent: 'resource_search_list',
        responseStyle: RESPONSE_STYLES.RESOURCE_SEARCH_LIST,
        actionName: null,
        confidence: 1,
        missingFields: [],
        extractedFields: {},
        requiredTool: 'none',
        toolInput: {},
        assistantMessage,
      },
      resourceMatches: [],
      actions: [],
    },
  };
};

const broadResourceDescription = (resource = {}) => {
  const metadata = resource.metadata || {};
  const resourceType = normalizeResourceType(metadata.resourceType);
  const title = broadResourceTitle(resource).toLowerCase();

  if (resourceType === 'card_limit_notice') {
    return 'shows your current card limit and status.';
  }
  if (resourceType === 'card_service_request') {
    return 'shows the replacement request status.';
  }
  if (resourceType === 'card_dispute') {
    return 'shows dispute details/status.';
  }
  if (
    resourceType === 'card_pickup_appointment' ||
    (resourceType === 'appointment_confirmation' && title.includes('card pickup'))
  ) {
    return 'shows your pickup appointment details.';
  }
  if (resourceType === 'appointment_confirmation') {
    return 'shows appointment confirmation details.';
  }
  if (resourceType === 'appointment_request') {
    return 'shows requested branch, date, and time.';
  }
  if (['bill', 'bill_notice', 'utility_bill', 'invoice'].includes(resourceType)) {
    return 'shows bill payment details.';
  }
  if (resourceType === 'payment_receipt') {
    return 'shows payment receipt details/status.';
  }
  if (resourceType === 'atm_receipt') {
    return 'shows ATM withdrawal receipt details.';
  }
  if (resourceType === 'fx_receipt') {
    return 'shows foreign exchange receipt details.';
  }
  if (resourceType === 'standing_order') {
    return 'shows standing payment order details.';
  }
  if (resourceType === 'beneficiary_profile') {
    return 'shows saved beneficiary details.';
  }
  if (resourceType === 'tax_form') {
    return 'shows tax form status and details.';
  }
  if (resourceType === 'product_sheet') {
    return 'shows product features and availability.';
  }
  if (resourceType.includes('certificate')) {
    return 'shows certificate details.';
  }
  if (resourceType.includes('statement')) {
    return 'shows statement details.';
  }

  return 'shows saved resource details.';
};

const findImportantFieldValue = (metadata = {}, labels = []) => {
  const normalizedLabels = labels.map(normalizedResourceKey);
  const field = importantResourceFieldsForList(metadata, 10).find((item) =>
    normalizedLabels.includes(normalizedResourceKey(item.label)),
  );
  if (field?.value) return field.value;

  for (const [key, value] of Object.entries(metadata || {})) {
    if (normalizedLabels.includes(normalizedResourceKey(key)) && value !== null && value !== undefined && value !== '') {
      return formatMetadataValue(value);
    }
  }
  return null;
};

const broadResourceNaturalSummary = (resource = {}) => {
  const metadata = resource.metadata || {};
  const resourceType = normalizeResourceType(metadata.resourceType);
  const description = markdownSafeInline(metadata.description || '');
  const provider = metadata.provider || metadata.biller || metadata.merchant;
  const merchant = metadata.merchant;
  const amount = findImportantFieldValue(metadata, ['amount', 'total amount', 'amount due', 'limit']);
  const status = findImportantFieldValue(metadata, ['status', 'request status', 'signature status']);
  const date = findImportantFieldValue(metadata, ['payment date', 'due date', 'next execution date', 'date']);
  const account = findImportantFieldValue(metadata, ['source account', 'source account id', 'account']);
  const beneficiary = findImportantFieldValue(metadata, ['beneficiary', 'beneficiary name']);

  if (resourceType === 'payment_receipt') {
    return [
      provider || merchant ? `${provider || merchant} payment receipt` : 'payment receipt',
      amount ? `for **${markdownSafeInline(amount)}**` : null,
      status ? `marked **${markdownSafeInline(status)}**` : null,
      date ? `on **${markdownSafeInline(date)}**` : null,
    ].filter(Boolean).join(' ');
  }
  if (['bill', 'bill_notice', 'bill_payment', 'utility_bill', 'invoice'].includes(resourceType)) {
    return [
      provider ? `${provider} bill payment request` : 'bill payment request',
      amount ? `for **${markdownSafeInline(amount)}**` : null,
      status ? `currently **${markdownSafeInline(status)}**` : null,
      date ? `due **${markdownSafeInline(date)}**` : null,
    ].filter(Boolean).join(' ');
  }
  if (resourceType === 'standing_order') {
    return [
      'standing order',
      beneficiary ? `to **${markdownSafeInline(beneficiary)}**` : null,
      amount ? `for **${markdownSafeInline(amount)}**` : null,
      date ? `next on **${markdownSafeInline(date)}**` : null,
      status ? `and **${markdownSafeInline(status)}**` : null,
    ].filter(Boolean).join(' ');
  }
  if (resourceType === 'fx_receipt') {
    return [
      'foreign exchange receipt',
      amount ? `for **${markdownSafeInline(amount)}**` : null,
      status ? `marked **${markdownSafeInline(status)}**` : null,
      date ? `on **${markdownSafeInline(date)}**` : null,
    ].filter(Boolean).join(' ');
  }
  if (
    ['pdf_resource', 'json_resource', 'txt_resource', 'image_resource'].includes(resourceType) &&
    description
  ) {
    return description
      .replace(/^image of an?\s+/i, '')
      .replace(/^paid\s+/i, 'paid ')
      .replace(/\.$/, '');
  }
  if (isImageResourceMetadata(metadata)) {
    return [
      broadResourceDescription(resource).replace(/\.$/, ''),
      merchant ? `for **${markdownSafeInline(merchant)}**` : null,
      amount ? `with amount **${markdownSafeInline(amount)}**` : null,
      status ? `status **${markdownSafeInline(status)}**` : null,
    ].filter(Boolean).join(' ');
  }

  return [
    broadResourceDescription(resource).replace(/\.$/, ''),
    account ? `for **${markdownSafeInline(account)}**` : null,
    amount ? `with amount **${markdownSafeInline(amount)}**` : null,
    status ? `status **${markdownSafeInline(status)}**` : null,
  ].filter(Boolean).join(' ');
};

const createPromptOption = (label, prompt = label, value = label) => ({
  label,
  value,
  action: 'prompt',
  prompt,
});

const broadResourceOption = (resource = {}) => {
  const metadata = resource.metadata || {};
  const resourceType = normalizeResourceType(metadata.resourceType);
  const title = broadResourceTitle(resource);
  const titleText = normalizeText(title);

  if (resourceType === 'card_limit_notice') {
    return createPromptOption('Credit card limit', 'What is my credit card limit?');
  }
  if (resourceType === 'card_service_request') {
    return createPromptOption(
      'Card replacement',
      'What is the status of my debit card replacement request?',
    );
  }
  if (resourceType === 'card_dispute') {
    return createPromptOption('Card dispute', 'What is the status of my card dispute?');
  }
  if (
    resourceType === 'card_pickup_appointment' ||
    (resourceType === 'appointment_confirmation' && titleText.includes('card pickup'))
  ) {
    return createPromptOption('Card pickup appointment', 'Do I have a card pickup appointment?');
  }
  if (resourceType === 'appointment_confirmation') {
    return createPromptOption(
      'Appointment confirmation',
      'Do I have a confirmed branch appointment?',
    );
  }
  if (resourceType === 'appointment_request') {
    return createPromptOption('Appointment request', 'Show my appointment request');
  }
  if (resourceType === 'payment_receipt') {
    const provider = metadata.provider ? `${metadata.provider} ` : '';
    return createPromptOption(
      `${provider}payment receipt`.trim(),
      `Show my ${provider}payment receipt`,
    );
  }
  if (['bill', 'bill_notice', 'utility_bill', 'invoice'].includes(resourceType)) {
    const provider = metadata.provider ? `${metadata.provider} ` : '';
    return createPromptOption(`${provider}bill`.trim(), `Show my ${provider}bill`);
  }
  if (resourceType === 'atm_receipt') {
    return createPromptOption('ATM receipt', 'Show me my ATM withdrawal receipt');
  }
  if (resourceType === 'fx_receipt') {
    return createPromptOption('FX receipt', 'Show my foreign currency exchange receipt');
  }

  return createPromptOption(title, `Show ${title}`);
};

const buildBroadResourceSearchResponse = async (message, aiDecision = {}, options = {}) => {
  const descriptor = resourceSearchListRequestFromMessage(message, aiDecision);
  if (!descriptor) return null;
  if (aiDecision.intent === 'broad_resource_search' && !isExplicitBroadResourceSearchMessage(message)) {
    return null;
  }

  const categoryMatches = (await findMatchingResources(descriptor.query, {
    catalog: options.catalog,
    forceRefresh: options.forceRefresh,
    requestId: options.requestId,
    threadId: options.threadId,
    limit: 24,
    minScore: 1,
    ...(!options.catalog ? { searchMode: 'semantic', minMargin: 0 } : {}),
  }))
    .filter((resource) => shouldIncludeBroadResourceMatch(descriptor.category, resource))
    .filter((resource) => {
      if (!descriptor.accountId) return true;
      const text = resourceMetadataText(resource.metadata);
      return text.includes(normalizeText(descriptor.accountId)) ||
        descriptor.category === 'account';
    });
  const exactAccountMatches = descriptor.accountId
    ? categoryMatches.filter((resource) =>
        resourceMetadataText(resource.metadata).includes(normalizeText(descriptor.accountId)))
    : [];
  const candidateMatches = exactAccountMatches.length >= 5 ? exactAccountMatches : categoryMatches;
  const matches = candidateMatches
    .sort((a, b) => {
      const priorityDelta =
        broadResourcePriority(descriptor.category, a) - broadResourcePriority(descriptor.category, b);
      return descriptor.scoreFirst
        ? b.score - a.score || priorityDelta
        : priorityDelta || b.score - a.score;
    })
    .slice(0, 6);

  if (!matches.length) {
    return buildResourceSearchListNoMatchResponse(descriptor);
  }

  const specificResourceMatch = findDominantSpecificResourceMatch(
    `${message} ${descriptor.query || ''}`,
    matches,
  );
  if (specificResourceMatch) {
    logAgentStep(options.requestId, 'broad_resource_search_bypassed', {
      reason: 'dominant_specific_title_match',
      selectedTitle: broadResourceTitle(specificResourceMatch),
      selectedResourceType: specificResourceMatch.metadata?.resourceType || null,
      selectedScore: specificResourceMatch.score,
      matchCount: matches.length,
    });
    return null;
  }

  const resultLines = matches.map((resource, index) =>
    `${index + 1}. **${markdownSafeInline(broadResourceTitle(resource))}** - ${broadResourceNaturalSummary(resource)}.`,
  );

  const assistantMessage = [
    `I found ${matches.length} ${descriptor.label} resources:`,
    '',
    ...resultLines,
  ].join('\n');

  // Same compact proof stream as resource_qa, so a catalog-summary answer is visible too. This
  // path answers from catalog metadata only — it never fetches/parses a trusted file.
  if (isVerboseRequestLog()) {
    const top = matches[0] || {};
    const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    console.log(
      `[ANSWER_PROOF] route=resource_search_list` +
      ` originalUserMessage="${oneLine(message).slice(0, 120)}"` +
      ` catalogSearchInput="${oneLine(descriptor.query || message).slice(0, 120)}"` +
      ` selectedResourceId=${top.metadata?.resourceId || top.fileName || 'none'}` +
      ` selectedFileName=${top.fileName || 'none'}` +
      ` selectedFileType=${top.metadata?.resourceFileType || 'none'}` +
      ` fetchedUrl=none didFetchTrustedFile=false hasParsedJson=false` +
      ` hasBranchesArray=false matchedBranch=none matchedService=none` +
      ` answerBuilderUsed=false answerBuilderSpecific=false writerRewrote=false` +
      ` finalAnswerSource=catalog_summary`
    );
  }

  return {
    success: true,
    status: 'resource_matches',
    agentMode: 'informational_answer',
    assistantMessage,
    actions: [],
    data: {
      ai: {
        source: 'resource_catalog',
        language: 'english',
        agentMode: 'informational_answer',
        intent: 'resource_search_list',
        responseStyle: RESPONSE_STYLES.RESOURCE_SEARCH_LIST,
        actionName: null,
        confidence: 1,
        missingFields: [],
        extractedFields: {},
        requiredTool: 'none',
        toolInput: {},
        assistantMessage,
      },
      actions: [],
      resourceMatches: matches.map((resource) => ({
        title: resource.metadata?.title,
        status: resource.metadata?.status,
        provider: resource.metadata?.provider,
      })),
    },
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fieldLabels = {
  accountId: 'Account',
  amount: 'Amount',
  beneficiaryId: 'Beneficiary',
  billReference: 'Bill reference',
  branch: 'Branch name',
  category: 'Complaint category',
  date: 'Preferred date',
  description: 'Description',
  documentType: 'Document type',
  period: 'Period',
  currency: 'Currency',
  reference: 'Complaint reference',
  sourceAccountId: 'Source account',
  time: 'Preferred time slot',
};

const formatFieldLabel = (field) =>
  fieldLabels[field] ||
  String(field || '').replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase());

const fieldHints = {
  accountId: ['the account ID', 'acc_001'],
  sourceAccountId: ['the account to use', 'acc_001'],
  billReference: ['the bill reference', 'STEG-2026-001'],
  amount: ['the amount', '300'],
  beneficiaryId: ['the beneficiary', 'ben_001'],
  branch: ['the branch', 'Tunis Centre'],
  date: ['the date', '2026-05-21'],
  time: ['a time', '10:00'],
  documentType: ['the document type', 'statement'],
  period: ['the period', 'April 2026'],
  category: ['the complaint category', 'failed transfer'],
  description: ['a short description of the issue', null],
  reference: ['the complaint reference', 'CMP-DEMO-2026-000001'],
};

const describeMissingField = (field) => {
  const [phrase, example] = fieldHints[field] || [
    formatFieldLabel(field).toLowerCase(),
    null,
  ];
  return example ? `${phrase} (for example \`${example}\`)` : phrase;
};

const createMissingFieldsMessage = (missingFields, actionName) => {
  const titleByAction = {
    book_appointment: 'I can book the appointment, but',
    generate_document: 'I can generate the document, but',
    create_complaint: 'I can prepare the complaint, but',
    check_complaint_status: 'I can check the complaint status, but',
    pay_bill: 'I can prepare the bill payment, but',
    check_balance: 'I can check the balance, but',
    make_transfer: 'I can prepare the transfer, but',
  };
  const intro = titleByAction[actionName] || 'I can help, but';
  const displayedFields = missingFields.slice(0, 2).map(describeMissingField);

  if (displayedFields.length === 1) {
    return `${intro} I still need ${displayedFields[0]}.`;
  }

  return `${intro} I still need ${displayedFields.join(' and ')}.`;
};

const createOption = (label, value = label) => ({
  label,
  value,
  action: 'prompt',
  prompt: label,
});

const ACCOUNT_OPTIONS = [
  createOption('Current account', 'acc_001'),
  createOption('Savings account', 'acc_002'),
  createOption('acc_001', 'acc_001'),
  createOption('acc_002', 'acc_002'),
];

const getClarificationQuickActions = (actionName, missingFields = [], collectedFields = {}) => {
  const firstMissingField = missingFields[0];

  if (actionName === 'check_balance' && firstMissingField === 'accountId') {
    return ACCOUNT_OPTIONS;
  }

  if (actionName === 'pay_bill') {
    if (firstMissingField === 'provider') {
      return [
        createOption('SONEDE'),
        createOption('STEG'),
        createOption('Telecom', 'TELECOM'),
        createOption('Internet', 'INTERNET'),
      ];
    }

    if (firstMissingField === 'sourceAccountId') {
      return ACCOUNT_OPTIONS;
    }
  }

  if (actionName === 'book_appointment' && firstMissingField === 'branch') {
    return [
      createOption('Tunis Centre'),
      createOption('Ariana'),
      createOption('Sfax'),
      createOption('Online appointment'),
    ];
  }

  if (actionName === 'create_complaint' && firstMissingField === 'category') {
    return [
      createOption('Failed transfer'),
      createOption('Card issue'),
      createOption('Account access issue'),
      createOption('Other'),
    ];
  }

  if (
    actionName === 'create_complaint' &&
    firstMissingField === 'description' &&
    collectedFields.category === 'Card issue'
  ) {
    return [
      createOption('Card payment failed'),
      createOption('Unauthorized transaction'),
      createOption('Card blocked'),
      createOption('ATM problem'),
      createOption('Other'),
    ];
  }

  return [];
};

const createClarificationMessage = (missingFields, actionName, collectedFields = {}) => {
  const firstMissingField = missingFields[0];

  if (actionName === 'check_balance' && firstMissingField === 'accountId') {
    return 'I can show your account details. Which account would you like to check?';
  }

  if (actionName === 'pay_bill' && firstMissingField === 'provider') {
    return 'I can help prepare the bill payment. Which provider is it for?';
  }

  if (actionName === 'pay_bill' && firstMissingField === 'sourceAccountId') {
    return 'I can help prepare the bill payment. Which account should I use?';
  }

  if (actionName === 'book_appointment' && firstMissingField === 'branch') {
    return 'I can book an appointment for you. Which branch would you prefer?';
  }

  if (actionName === 'check_complaint_status' && firstMissingField === 'reference') {
    return 'I can check the complaint status, but I still need the complaint reference.';
  }

  if (actionName === 'create_complaint' && firstMissingField === 'category') {
    return 'I can prepare a complaint. What type of issue is it?';
  }

  if (
    actionName === 'create_complaint' &&
    firstMissingField === 'description' &&
    collectedFields.category === 'Card issue'
  ) {
    return 'Got it - this is a card issue. Please briefly describe what happened.';
  }

  return null;
};

const mergeQuickActions = (currentActions = [], extraActions = []) => {
  return dedupeQuickActions([...currentActions, ...extraActions]);
};

const withClarificationQuickActions = (ai = {}, actionName, missingFields, collectedFields = {}) => {
  const clarificationActions = getClarificationQuickActions(
    actionName,
    missingFields,
    collectedFields,
  );
  if (!clarificationActions.length) {
    return ai;
  }

  const toolInput = ai.toolInput || {};
  return {
    ...ai,
    toolInput: {
      ...toolInput,
      quickActions: mergeQuickActions(toolInput.quickActions || [], clarificationActions),
    },
  };
};

const normalizeAiDecision = (decision = {}) => ({
  decision: decision.decision || 'answer_directly',
  intent: decision.intent || 'general_banking_question',
  resourceQuery: decision.resourceQuery || '',
  action: decision.action || null,
  fields: decision.fields && typeof decision.fields === 'object'
    ? decision.fields
    : {},
  missingFields: Array.isArray(decision.missingFields)
    ? decision.missingFields
    : [],
  clarificationQuestion: decision.clarificationQuestion || '',
  quickActions: Array.isArray(decision.quickActions)
    ? decision.quickActions
    : [],
});

const mergeDecisionIntoAgentContext = (agentContext = {}, aiDecision = {}) => {
  const decisionFields = aiDecision.fields || {};
  const extractedFields = {
    ...(agentContext.extractedFields || {}),
    ...decisionFields,
  };

  return {
    ...agentContext,
    extractedFields,
    suggestedAction:
      aiDecision.action ||
      agentContext.suggestedAction ||
      inferActionFromContext({ extractedFields }),
    pendingAction: agentContext.pendingAction || null,
  };
};

const decisionToAiPayload = (aiDecision = {}) => {
  const actionName = aiDecision.action || null;
  const quickActions = aiDecision.quickActions || [];
  const assistantMessage =
    aiDecision.clarificationQuestion ||
    'I need one more detail before I can continue.';

  return {
    source: 'ollama_first_decision',
    language: 'english',
    agentMode: actionName ? 'banking_action' : 'informational_answer',
    intent: aiDecision.intent || actionName || 'ask_clarification',
    actionName,
    confidence: 1,
    missingFields: aiDecision.missingFields || [],
    extractedFields: aiDecision.fields || {},
    requiredTool: actionName ? 'connector_action' : 'none',
    toolInput: quickActions.length ? { quickActions } : {},
    assistantMessage,
  };
};

const handleAskClarificationDecision = (res, aiDecision) => {
  let ai = {
    ...decisionToAiPayload(aiDecision),
    aiDecision,
  };
  const finalPayload = ai.extractedFields || {};
  ai = withClarificationQuickActions(
    ai,
    ai.actionName,
    ai.missingFields || [],
    finalPayload,
  );
  const pendingAction = ai.actionName
    ? {
        actionName: ai.actionName,
        missingFields: ai.missingFields || [],
        collectedFields: finalPayload,
      }
    : null;

  return res.json({
    success: true,
    status: pendingAction ? 'missing_fields' : 'clarification_required',
    agentMode: ai.agentMode,
    assistantMessage: ai.assistantMessage,
    data: {
      ai,
      aiDecision,
      finalPayload,
      missingFields: ai.missingFields || [],
      pendingAction,
    },
  });
};

const normalizeOptionText = (value = '') =>
  normalizeText(value).replace(/\s+/g, ' ').trim();

const PENDING_FIELD_OPTION_MAP = {
  create_complaint: {
    category: {
      'failed transfer': 'Failed transfer',
      'card issue': 'Card issue',
      'account access issue': 'Account access issue',
      other: 'Other',
    },
    description: {
      'card payment failed': 'Card payment failed',
      'unauthorized transaction': 'Unauthorized transaction',
      'card blocked': 'Card blocked',
      'atm problem': 'ATM problem',
      other: 'Other',
    },
  },
  pay_bill: {
    provider: {
      sonede: 'SONEDE',
      steg: 'STEG',
      telecom: 'TELECOM',
      internet: 'INTERNET',
    },
    sourceAccountId: {
      'current account': 'acc_001',
      'savings account': 'acc_002',
      'saving account': 'acc_002',
      acc_001: 'acc_001',
      'acc 001': 'acc_001',
      acc_002: 'acc_002',
      'acc 002': 'acc_002',
    },
  },
  book_appointment: {
    branch: {
      'tunis centre': 'Tunis Centre',
      'tunis center': 'Tunis Centre',
      ariana: 'Ariana',
      sfax: 'Sfax',
      'online appointment': 'Online appointment',
      online: 'Online appointment',
    },
  },
  check_balance: {
    accountId: {
      'current account': 'acc_001',
      'savings account': 'acc_002',
      'saving account': 'acc_002',
      acc_001: 'acc_001',
      'acc 001': 'acc_001',
      acc_002: 'acc_002',
      'acc 002': 'acc_002',
    },
  },
  make_transfer: {
    sourceAccountId: {
      'current account': 'acc_001',
      'savings account': 'acc_002',
      'saving account': 'acc_002',
      acc_001: 'acc_001',
      'acc 001': 'acc_001',
      acc_002: 'acc_002',
      'acc 002': 'acc_002',
    },
  },
};

const resolvePendingFieldSelection = (pendingAction = {}, message = '') => {
  if (!pendingAction || typeof pendingAction !== 'object') {
    return null;
  }

  const actionName = pendingAction.actionName;
  const missingField = pendingAction.missingFields?.[0];

  if (!actionName || !missingField) {
    return null;
  }

  const optionMap = PENDING_FIELD_OPTION_MAP[actionName]?.[missingField];
  if (!optionMap) {
    return null;
  }

  const normalizedMessage = normalizeOptionText(message);
  const value = optionMap[normalizedMessage];

  if (!value) {
    return null;
  }

  return {
    field: missingField,
    value,
  };
};

const buildPendingClarificationAi = ({
  actionName,
  fields,
  missingFields = [],
}) => ({
  source: 'pending_clarification',
  language: 'english',
  agentMode: 'banking_action',
  intent: actionName,
  actionName,
  confidence: 1,
  missingFields,
  extractedFields: fields,
  requiredTool: 'connector_action',
  toolInput: {},
  assistantMessage: 'Continuing with your selection.',
});

const handlePendingClarificationSelection = async ({
  res,
  req,
  message,
  payload = {},
  conversationHistory = [],
  profileContext = {},
  agentContext = {},
  fileContext = null,
}) => {
  const pendingAction = agentContext.pendingAction;
  const selection = resolvePendingFieldSelection(pendingAction, message);

  if (!selection) {
    return null;
  }

  const actionName = pendingAction.actionName;
  const collectedFields = {
    ...(agentContext.extractedFields || {}),
    ...(pendingAction.collectedFields || {}),
    [selection.field]: selection.value,
  };
  const remainingMissingFields = (pendingAction.missingFields || []).filter(
    (field) => field !== selection.field,
  );
  const nextAgentContext = {
    ...agentContext,
    extractedFields: collectedFields,
    suggestedAction: actionName,
    pendingAction: {
      ...pendingAction,
      collectedFields,
      missingFields: remainingMissingFields,
    },
  };

  console.log('[chat/message] pending clarification filled:', {
    actionName,
    field: selection.field,
    value: selection.value,
  });

  if (actionName === 'pay_bill' && selection.field === 'provider') {
    const resourceQuery = `${selection.value} bill`;
    const resolvedResourceContext = await buildResolvedResourceContext(resourceQuery, {
      originalMessage: `Pay my ${selection.value} bill`,
    });

    if (resolvedResourceContext) {
      const aiResponse = await analyzeMessage({
        message: `Pay my ${selection.value} bill`,
        userRole: req.user.role,
        availableActions: getAvailableAiActions(req.user.role),
        conversationHistory,
        fileContext,
        profileContext: sanitizeProfileContext(profileContext),
        resolvedResourceContext: sanitizeResolvedResourceContextForAi(
          resolvedResourceContext,
        ),
        agentContext: nextAgentContext,
      });

      return dispatchByAgentMode({
        res,
        req,
        ai: {
          ...aiResponse.data,
          extractedFields: {
            ...collectedFields,
            ...(aiResponse.data.extractedFields || {}),
          },
        },
        message,
        payload,
        conversationHistory,
        fileContext,
      });
    }
  }

  return dispatchByAgentMode({
    res,
    req,
    ai: buildPendingClarificationAi({
      actionName,
      fields: collectedFields,
      missingFields: remainingMissingFields,
    }),
    message,
    payload,
    conversationHistory,
    fileContext,
  });
};

const buildAccountResourceChoice = (message, resolvedResourceContext) => {
  if (
    !isAccountDetailsRequest(message) ||
    messageSpecifiesAccount(message) ||
    !resolvedResourceContext?.matchedResources?.length
  ) {
    return null;
  }

  const accountResources = resolvedResourceContext.matchedResources.filter((resource) => {
    const resourceType = normalizeResourceType(resource.resourceType);
    return (
      resource.accountId &&
      [
        'account_statement',
        'account_certificate',
        'account_profile',
        'account_summary',
        'rib_certificate',
        'kyc_summary',
        'customer_profile',
      ].includes(resourceType)
    );
  });

  const uniqueAccountIds = Array.from(
    new Set(accountResources.map((resource) => resource.accountId).filter(Boolean)),
  );

  if (uniqueAccountIds.length <= 1) {
    return null;
  }

  const labelOptions = uniqueAccountIds.map((accountId) => {
    const resource = accountResources.find((item) => item.accountId === accountId);
    return createOption(getAccountChoiceLabel(accountId, resource), accountId);
  });
  const idOptions = uniqueAccountIds.map((accountId) => createOption(accountId, accountId));
  const quickActions = mergeQuickActions(labelOptions, idOptions);
  const extractedFields = { _accountDetailsRequested: true };
  const pendingAction = {
    actionName: 'check_balance',
    missingFields: ['accountId'],
    collectedFields: extractedFields,
  };

  return {
    success: true,
    status: 'missing_fields',
    agentMode: 'banking_action',
    assistantMessage: 'I found more than one account. Which one would you like to view?',
    data: {
      ai: {
        source: 'resource_catalog',
        language: 'english',
        agentMode: 'banking_action',
        intent: 'check_balance',
        actionName: 'check_balance',
        confidence: 0.92,
        missingFields: ['accountId'],
        extractedFields,
        requiredTool: 'connector_action',
        toolInput: { quickActions },
        assistantMessage: 'I found more than one account. Which one would you like to view?',
      },
      finalPayload: extractedFields,
      missingFields: ['accountId'],
      pendingAction,
      resourceMatches: accountResources,
    },
  };
};

const mergePayloadWithExtractedFields = ({ extractedFields = {}, payload = {} }) => ({
  ...extractedFields,
  ...payload,
});

const parseSummaryItems = (summary = []) =>
  summary.reduce((items, item) => {
    const [label, ...valueParts] = String(item || '').split(':');
    if (!label || valueParts.length === 0) return items;

    return {
      ...items,
      [label.trim().toLowerCase()]: valueParts.join(':').trim(),
    };
  }, {});

// Renders a compact Markdown table from [label, value] rows, skipping empties.
const buildDetailsTable = (rows) => {
  const usableRows = rows.filter(([, value]) => value !== undefined && value !== null && value !== '');

  if (!usableRows.length) {
    return '';
  }

  return [
    '| Field | Value |',
    '|---|---|',
    ...usableRows.map(([label, value]) => `| ${label} | ${value} |`),
  ].join('\n');
};

const formatActionValue = (value) => {
  if (Array.isArray(value)) return value.filter(Boolean).join(', ');
  if (value && typeof value === 'object') {
    return Object.values(value)
      .filter((item) => item !== null && item !== undefined && item !== '')
      .join(', ');
  }
  return String(value || '').trim();
};

const formatMoney = (amount, currency = 'TND') => {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount)) {
    return amount ? `${amount} ${currency || 'TND'}` : '';
  }
  return `${numericAmount.toFixed(3)} ${currency || 'TND'}`;
};

const formatStatus = (value = '') => {
  const text = String(value || 'Active').trim();
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : 'Active';
};

const PREPARED_ACTION_CONFIG = {
  pay_bill: {
    intro: 'I can prepare this bill payment.',
    rows: (summary, payload) => [
      ['Provider', summary.provider || payload.provider],
      ['Reference', summary['bill reference'] || payload.billReference],
      ['Amount', summary.amount],
      ['Due date', summary['due date'] || payload.dueDate],
      ['Status', summary.status || payload.status],
      ['From account', summary.account || payload.sourceAccountId],
    ],
  },
  make_transfer: {
    intro: 'I can prepare this transfer.',
    rows: (summary, payload) => [
      ['Amount', summary.amount],
      ['Beneficiary', summary.beneficiary || payload.beneficiaryId],
      ['From account', summary.account || payload.sourceAccountId],
    ],
  },
  create_complaint: {
    intro: 'I can prepare this complaint.',
    fileIntro: 'I can prepare this complaint from the document.',
    confirmText: 'Please confirm before I submit it.',
    rows: (summary, payload) => [
      ['Category', payload.category],
      ['Description', payload.description],
      ['Dispute reference', payload.disputeId || payload.relatedReference || payload.reference],
      ['Merchant', payload.merchant || payload.provider],
      ['Related account', payload.sourceAccountId || payload.relatedAccountId],
      ['Beneficiary', payload.beneficiaryId],
      [
        'Amount',
        payload.amount !== undefined && payload.amount !== null
          ? `${payload.amount} ${payload.currency || 'TND'}`
          : '',
      ],
      ['Date', payload.date],
      ['Status', payload.status],
      ['Deadline', payload.deadline],
      ['Card', payload.card],
      [
        'Reference',
        payload.relatedReference ||
          payload.transferReference ||
          payload.transactionReference ||
          payload.reference,
      ],
    ],
  },
  book_appointment: {
    intro: 'I can book this appointment.',
    rows: (summary, payload) => [
      ['Branch', payload.branch],
      ['Date', payload.date],
      ['Time', payload.time],
    ],
  },
  generate_document: {
    intro: 'I can generate this document.',
    rows: (summary, payload) => [
      ['Document type', payload.documentType],
      ['Period', payload.period],
      ['Account', summary.account || payload.accountId],
    ],
  },
  check_balance: {
    intro: 'I can check this balance.',
    rows: (summary, payload) => [['Account', summary.account || payload.accountId]],
  },
};

// MVP demo framing: every prepared banking action is simulated, never a real banking operation.
// Appended to the final prepared-action message (deduped) so the user always knows it is a demo.
const MVP_DEMO_ACTION_NOTE =
  'Note: this is an MVP demo, so I will simulate this action and will not run a real banking operation.';

const appendMvpDemoActionNote = (text = '') => {
  const base = String(text || '').trim();
  if (!base) return base;
  if (/\bmvp demo\b|\bsimulat/i.test(base)) return base; // writer already framed it as a demo
  return `${base}\n\n${MVP_DEMO_ACTION_NOTE}`;
};

const buildPreparedActionMessage = (preparation = {}, options = {}) => {
  const summary = parseSummaryItems(preparation.summary || []);
  const payload = preparation.payload || {};
  const config = PREPARED_ACTION_CONFIG[preparation.actionName];

  if (config) {
    const rows = config.rows(summary, payload)
      .map(([label, value]) => [label, formatActionValue(value)])
      .filter(([, value]) => value);
    const intro = options.fromFile && config.fileIntro ? config.fileIntro : config.intro;
    const confirmText = config.confirmText || 'Please confirm before I continue.';
    const detailText = rows
      .map(([label, value]) => `${label.toLowerCase()} **${value}**`)
      .join(', ');

    return [
      detailText ? `${intro} I have ${detailText}.` : intro,
      confirmText,
    ]
      .filter((line) => line !== null)
      .join('\n\n');
  }

  const details = (preparation.summary || [])
    .map((item) => {
      const [label, ...rest] = String(item).split(':');
      const value = rest.join(':').trim();
      return value ? `${label.trim()} **${value}**` : null;
    })
    .filter(Boolean)
    .join(', ');

  return [
    details ? `I can continue with this: ${details}.` : 'I can continue with this.',
    'Please confirm before I continue.',
  ]
    .filter((line) => line !== null)
    .join('\n\n');
};

const buildBalanceResultMessage = (data = {}, options = {}) => {
  const account = data.account || {};

  if (options.detailsRequested) {
    const accountType = String(account.type || '').trim();
    const accountLabel = accountType ? accountType.toLowerCase() : 'account';
    const table = buildDetailsTable([
      ['Account ID', account.id],
      ['Account number', account.accountNumber],
      ['Account type', account.type],
      ['Balance', formatMoney(account.balance, account.currency)],
      ['Status', formatStatus(account.status)],
      ['Currency', account.currency],
    ]);

    return [
      `Here are the details for your ${accountLabel}.`,
      '',
      table,
    ].join('\n');
  }

  return [
    `Your balance is **${formatMoney(account.balance, account.currency)}**.`,
    '',
    `Account: ${account.accountNumber || account.id || 'not found'}`,
    `Status: ${formatStatus(account.status)}`,
  ].join('\n');
};

// ---------------------------------------------------------------------------
// Follow-up context memory
// ---------------------------------------------------------------------------
// Short confirmation phrases that mean "continue the action we were discussing"
// rather than starting a brand-new request. Matched exactly (after trimming
// punctuation / trailing politeness words) so unrelated sentences never misfire.
const FOLLOW_UP_PHRASES = new Set([
  'pay it',
  'pay this',
  'pay this bill',
  'pay the bill',
  'pay my bill',
  'continue',
  'confirm',
  'proceed',
  'please proceed',
  'proceed with it',
  'do it',
  'go ahead',
  'create it',
  'book it',
  'generate it',
  'download it',
  'submit it',
  'send it',
  'confirm it',
  'yes confirm',
  'ok confirm',
  'execute it',
  'do it now',
  'yes do it',
  'ok do it',
]);

const isFollowUpMessage = (message) => {
  const normalized = String(message || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, '')
    .replace(/\s+(please|now|thanks|thank you)$/g, '')
    .trim();

  return FOLLOW_UP_PHRASES.has(normalized);
};

// Resolves which banking action a follow-up phrase refers to, using the
// context the frontend carried over from earlier messages.
const inferActionFromContext = (agentContext = {}) => {
  if (agentContext.suggestedAction) {
    return agentContext.suggestedAction;
  }

  const fields = agentContext.extractedFields || {};
  if (fields._visionNoAction === true) return null;

  if (fields.billReference || fields.provider) return 'pay_bill';
  if (fields.beneficiaryId) return 'make_transfer';
  if (fields.documentType || fields.period) return 'generate_document';
  if (fields.category) return 'create_complaint';
  if (fields.branch || fields.appointmentDate) return 'book_appointment';

  return null;
};

const buildFollowUpAi = (actionName, agentContext = {}) => ({
  source: 'follow_up_context',
  language: 'english',
  agentMode: 'banking_action',
  intent: actionName,
  actionName,
  confidence: 0.9,
  missingFields: [],
  extractedFields: agentContext.extractedFields || {},
  requiredTool: 'connector_action',
  toolInput: {},
  assistantMessage: 'Continuing with the details from our earlier messages.',
});

const getPendingConfirmationIdFromContext = (agentContext = {}) =>
  agentContext.confirmationId ||
  agentContext.confirmation?.confirmationId ||
  agentContext.pendingConfirmation?.confirmationId ||
  agentContext.actionContext?.pendingConfirmation?.confirmationId ||
  agentContext.ai?.confirmationId ||
  null;

const handlePendingConfirmationFollowUp = async ({
  res,
  req,
  message,
  agentContext = {},
}) => {
  if (!isFollowUpMessage(message)) return null;

  const confirmationId = getPendingConfirmationIdFromContext(agentContext);
  if (!confirmationId) return null;

  const confirmation = await confirmAction({
    confirmationId,
    user: req.user,
  });
  const response = {
    ...confirmation.body,
    agentMode: 'banking_action',
    data: {
      ...(confirmation.body.data || {}),
      confirmationId,
    },
  };

  return res.status(confirmation.httpStatus).json(response);
};

const parseConversationHistory = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const parseProfileContext = (value) => {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const parseAgentContext = (value) => {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const sanitizeProfileContext = (profileContext = {}) => ({
  fullName: String(profileContext.fullName || '').trim(),
  email: String(profileContext.email || '').trim(),
  phoneNumber: String(profileContext.phoneNumber || '').trim(),
  rib: String(profileContext.rib || '').trim(),
});

const hasFieldValue = (value) =>
  value !== undefined &&
  value !== null &&
  !(typeof value === 'string' && value.trim() === '');

const PAY_BILL_REQUIRED_FIELDS = [
  'provider',
  'billReference',
  'amount',
  'sourceAccountId',
];

const getPayBillMissingFields = (payload = {}) =>
  PAY_BILL_REQUIRED_FIELDS.filter((field) => {
    if (field === 'sourceAccountId') {
      return !hasFieldValue(payload.sourceAccountId) && !hasFieldValue(payload.accountId);
    }

    return !hasFieldValue(payload[field]);
  });

const hasVisualOrOcrFileContext = (fileContext) => {
  if (!fileContext?.files?.length) return false;

  return fileContext.files.some((file) => {
    const mimeType = String(file.mimeType || '').toLowerCase();
    const name = String(file.originalName || '').toLowerCase();
    return (
      file.isVisualInput ||
      file.isOcrDerived ||
      file.isScannedOrImageBased ||
      file.extractionStatus === 'ocr_extracted' ||
      file.extractionStatus === 'ocr_empty' ||
      mimeType.startsWith('image/') ||
      name.endsWith('.png') ||
      name.endsWith('.jpg') ||
      name.endsWith('.jpeg') ||
      name.endsWith('.webp')
    );
  });
};

const hasOcrExtractedFile = (fileContext) =>
  Boolean(
    fileContext?.files?.some(
      (file) => file.isOcrDerived || file.extractionStatus === 'ocr_extracted',
    ),
  );

const hasVisualOrOcrContext = (fileContext, payload = {}) =>
  hasVisualOrOcrFileContext(fileContext) ||
  payload._sourceIsVisual === true ||
  payload._sourceExtractionStatus === 'ocr_extracted' ||
  payload._sourceExtractionStatus === 'ocr_empty';

const buildOcrPaymentMissingFieldsMessage = (missingFields, payload = {}) => {
  const onlySourceAccountMissing =
    missingFields.length === 1 &&
    missingFields[0] === 'sourceAccountId' &&
    hasFieldValue(payload.provider) &&
    hasFieldValue(payload.billReference) &&
    hasFieldValue(payload.amount);

  if (onlySourceAccountMissing) {
    return 'I can read the bill, but the source account is unclear. Which account should I use?';
  }

  const labels = missingFields.map((field) =>
    field === 'sourceAccountId'
      ? 'source account'
      : formatFieldLabel(field).toLowerCase(),
  );
  const fieldText =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  const verb = labels.length === 1 ? 'is' : 'are';

  return `I can read parts of the scanned bill, but the ${fieldText} ${verb} unclear. Please provide ${fieldText} before I prepare the payment.`;
};

const buildSafeFileAttachments = (fileContext) =>
  fileContext.files.map((file) => ({
    originalName: file.originalName,
    mimeType: file.mimeType,
    size: file.size,
    fileKind: file.fileKind,
    isVisualInput: file.isVisualInput,
    isOcrDerived: file.isOcrDerived,
    isScannedOrImageBased: file.isScannedOrImageBased,
    extractedText: file.extractedText || '',
    extractionStatus: file.extractionStatus,
    ...(file.extractionError ? { extractionError: file.extractionError } : {}),
  }));

const buildFileFallbackMessage = (fileContext) => {
  if (!fileContext.files.length) return null;
  if (fileContext.combinedText) return null;

  const pdfFiles = fileContext.files.filter((file) =>
    String(file.mimeType || '').toLowerCase() === 'application/pdf' ||
    String(file.originalName || '').toLowerCase().endsWith('.pdf'),
  );

  if (pdfFiles.length > 0) {
    return 'I received the image, but I could not read enough text from it.';
  }

  const imageFiles = fileContext.files.filter((file) =>
    String(file.mimeType || '').toLowerCase().startsWith('image/') ||
    ['metadata_only', 'ocr_empty'].includes(file.extractionStatus),
  );

  if (imageFiles.length > 0) {
    return 'I received the image, but I could not read enough text from it.';
  }

  return (
    'I received the file, but I could not extract readable text from it. ' +
    'Please provide the missing details manually.'
  );
};

const getFirstPdfAttachment = (fileContext) =>
  fileContext?.files?.find((file) =>
    file.fileKind === 'pdf' ||
    String(file.mimeType || '').toLowerCase() === 'application/pdf' ||
    String(file.originalName || '').toLowerCase().endsWith('.pdf'),
  ) || null;

const buildUploadedPdfVisionResponse = async ({
  req,
  trace = null,
  message,
  conversationHistory,
  profileContext,
  agentContext,
  fileContext,
}) => {
  const pdfFile = getFirstPdfAttachment(fileContext);
  if (!pdfFile?.storedPath) {
    return null;
  }

  try {
    const pdfBase64 = (await fs.readFile(pdfFile.storedPath)).toString('base64');
    const visionResult = await toVisionPdfResponse({
      req,
      trace,
      message,
      conversationHistory,
      profileContext,
      agentContext,
      source: 'uploaded_file',
      fileName: pdfFile.originalName,
      mimeType: pdfFile.mimeType,
      pdfBase64,
      resourceJson: null,
    });

    return {
      ...visionResult,
      data: {
        ...visionResult.data,
        fileContext: {
          files: buildSafeFileAttachments(fileContext),
          extractedContextUsed: false,
        },
      },
    };
  } catch {
    return buildVisionPdfErrorResponse({
      status: 'vision_pdf_read_failed',
      assistantMessage:
        'I received the PDF, but the backend could not prepare it for visual analysis.',
    });
  }
};

const createFileChatAuditLog = ({ req, fileContext }) =>
  createAuditLog({
    userId: req.user.id,
    role: req.user.role,
    status: 'chat_files_received',
    apiEndpoint: '/chat/message-with-files',
    metadata: {
      filesAttached: true,
      fileCount: fileContext.files.length,
      extractedContextUsed: Boolean(fileContext.combinedText),
    },
    result: {
      files: buildSafeFileAttachments(fileContext),
    },
  });

// Summarise conversation history as plain text for file generation
const buildConversationSummary = (conversationHistory = []) => {
  if (!conversationHistory.length) {
    return 'No conversation history available.';
  }

  return conversationHistory
    .slice(-20)
    .map((msg) => {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      return `${role}: ${msg.content}`;
    })
    .join('\n\n');
};

// ---------------------------------------------------------------------------
// Agent-mode dispatch helpers
// ---------------------------------------------------------------------------

const handleInformationalMode = (res, ai, fileContext, trace = null) => {
  const fileData = fileContext
    ? {
        fileContext: {
          files: buildSafeFileAttachments(fileContext),
          extractedContextUsed: Boolean(fileContext.combinedText),
        },
      }
    : {};

  const response = {
    success: true,
    status: 'answered',
    agentMode: ai.agentMode || 'informational_answer',
    assistantMessage: ai.assistantMessage,
    data: { ai, ...fileData },
  };
  logFinalResponse(trace, response, response.status);
  return res.json(response);
};

const handleResourceServerUnavailable = (res) =>
  res.json({
    success: true,
    status: 'resource_server_unreachable',
    agentMode: 'informational_answer',
    assistantMessage:
      'The resource server is not reachable. Please start Laragon and try again.',
    data: {
      ai: {
        source: 'resource_catalog',
        language: 'english',
        agentMode: 'informational_answer',
        intent: 'resource_server_unreachable',
        actionName: null,
        confidence: 1,
        missingFields: [],
        extractedFields: {},
        requiredTool: 'none',
        toolInput: {},
        assistantMessage:
          'The resource server is not reachable. Please start Laragon and try again.',
      },
    },
  });

const handleFileAnalysisMode = (res, ai, fileContext, trace = null) => {
  const fileData = fileContext
    ? {
        fileContext: {
          files: buildSafeFileAttachments(fileContext),
          extractedContextUsed: Boolean(fileContext.combinedText),
        },
      }
    : {};

  const response = {
    success: true,
    status: 'file_analyzed',
    agentMode: 'file_analysis',
    assistantMessage: ai.assistantMessage,
    data: { ai, ...fileData },
  };
  logFinalResponse(trace, response, response.status);
  return res.json(response);
};

const handleFileGenerationMode = async (
  res,
  req,
  ai,
  conversationHistory,
  fileContext,
) => {
  const toolInput = ai.toolInput || {};
  const fileType = toolInput.fileType || 'txt';
  const title = toolInput.title || 'Generated File';

  const content =
    toolInput.content ||
    buildConversationSummary(conversationHistory);

  const fileData = fileContext
    ? {
        fileContext: {
          files: buildSafeFileAttachments(fileContext),
          extractedContextUsed: Boolean(fileContext.combinedText),
        },
      }
    : {};

  const fileResult = await generateFile({
    fileType,
    title,
    content,
    data: toolInput.data || null,
  });

  createAuditLog({
    userId: req.user.id,
    role: req.user.role,
    status: 'file_generated',
    apiEndpoint: req.originalUrl || '/chat/message',
    metadata: {
      fileGenerated: true,
      fileType: fileResult.fileType,
      fileName: fileResult.fileName,
    },
    result: { fileId: fileResult.fileId, downloadUrl: fileResult.downloadUrl },
  });

  return res.json({
    success: true,
    status: 'file_generated',
    agentMode: 'file_generation',
    assistantMessage: `I've generated your ${fileResult.fileType.toUpperCase()} file. Use the download button below.`,
    data: {
      ai,
      generatedFile: {
        fileId: fileResult.fileId,
        fileName: fileResult.fileName,
        fileType: fileResult.fileType,
        title: fileResult.title,
        downloadUrl: fileResult.downloadUrl,
      },
      ...fileData,
    },
  });
};

const handleBankingActionMode = async (res, req, ai, finalPayload, fileContext, trace = null, message = '') => {
  const fileData = fileContext
    ? {
        fileContext: {
          files: buildSafeFileAttachments(fileContext),
          extractedContextUsed: Boolean(fileContext.combinedText),
        },
      }
    : {};

  if (
    ai.actionName === 'pay_bill' &&
    fileContext?.hasUploadedFiles &&
    hasVisualOrOcrFileContext(fileContext) &&
    !hasOcrExtractedFile(fileContext)
  ) {
    return res.json({
      success: true,
      status: 'file_analyzed',
      agentMode: 'file_analysis',
      assistantMessage:
        buildFileFallbackMessage(fileContext) ||
        'I received the image, but I could not read enough text from it.',
      data: { ai, finalPayload, ...fileData },
    });
  }

  if (ai.actionName === 'pay_bill' && hasVisualOrOcrContext(fileContext, finalPayload)) {
    const ocrMissingFields = getPayBillMissingFields(finalPayload);

    if (ocrMissingFields.length > 0) {
      const enrichedAi = withClarificationQuickActions(
        { ...ai, missingFields: ocrMissingFields },
        ai.actionName,
        ocrMissingFields,
        finalPayload,
      );
      const pendingAction = {
        actionName: ai.actionName,
        missingFields: ocrMissingFields,
        collectedFields: finalPayload,
      };

      return res.json({
        success: true,
        status: 'missing_fields',
        agentMode: 'banking_action',
        assistantMessage: buildOcrPaymentMissingFieldsMessage(
          ocrMissingFields,
          finalPayload,
        ),
        data: {
          ai: enrichedAi,
          finalPayload,
          missingFields: ocrMissingFields,
          pendingAction,
          ...fileData,
        },
      });
    }
  }

  const preparation = prepareAction({
    actionName: ai.actionName,
    payload: finalPayload,
    user: req.user,
  });
  logAgentStep(trace?.requestId, 'action_prepared', {
    actionType: ai.actionName,
    extractedFields: finalPayload,
    missingFields: preparation.body.missingFields || ai.missingFields || [],
    confirmationRequired: Boolean(preparation.body.data?.requiresConfirmation),
  });

  if (preparation.body.status === 'missing_fields') {
    const missingFields = preparation.body.missingFields;
    if (
      ai.actionName === 'check_balance' &&
      missingFields.includes('accountId') &&
      message &&
      shouldTryResourceFirst(message, routeAgentCase({ message, memoryContext: {} }))
    ) {
      const resourceMatches = await findMatchingResources(message, {
        limit: 5,
        requestId: trace?.requestId,
        threadId: trace?.threadId,
        searchMode: 'semantic',
      });
      if (resourceMatches.length) {
        const routerDecision = {
          ...routeAgentCase({ message, memoryContext: {} }),
          case: CASES.LARAGON_RESOURCE_METADATA,
          modelMode: 'text',
          needsResourceSearch: true,
          needsActionFlow: false,
          resourceHint: message,
          reason: 'Resource answer forced before account clarification.',
        };
        const { response } = buildResourceMetadataResponse(
          resourceMatches[0],
          routerDecision,
          message,
          trace,
        );
        logFinalResponse(trace, response, response.status);
        return res.json(response);
      }
    }
    const enrichedAi = withClarificationQuickActions(
      ai,
      ai.actionName,
      missingFields,
      finalPayload,
    );
    const clarificationMessage = createClarificationMessage(
      missingFields,
      ai.actionName,
      finalPayload,
    );
    const fallbackMissingFieldsMessage = createMissingFieldsMessage(
      missingFields,
      ai.actionName,
    );
    const aiAssistantMessage =
      ai.source === 'pending_clarification' ? null : enrichedAi.assistantMessage;
    const pendingAction = {
      actionName: ai.actionName,
      missingFields,
      collectedFields: finalPayload,
    };

    const response = {
      success: true,
      status: 'missing_fields',
      agentMode: 'banking_action',
      assistantMessage:
        clarificationMessage ||
        aiAssistantMessage ||
        fallbackMissingFieldsMessage,
      data: {
        ai: {
          ...enrichedAi,
          assistantMessage:
            clarificationMessage ||
            aiAssistantMessage ||
            fallbackMissingFieldsMessage,
        },
        finalPayload,
        missingFields,
        pendingAction,
        ...fileData,
      },
    };
    logArchitecture('action_flow', {
      requestId: trace?.requestId,
      threadId: trace?.threadId,
      actionType: ai.actionName,
      missingFields,
      confirmationRequired: false,
      smsRequired: false,
      auditLogCreated: false,
      executionStatus: 'missing_fields',
    });
    logFinalResponse(trace, response, response.status);
    return res.json(response);
  }

  if (preparation.body.status === 'not_connected') {
    const response = {
      success: true,
      status: 'not_connected',
      agentMode: 'banking_action',
      assistantMessage:
        'I understood your request, but this action is not connected in the current MVP.',
      data: { ai, finalPayload, actionName: ai.actionName, ...fileData },
    };
    logFinalResponse(trace, response, response.status);
    return res.json(response);
  }

  if (preparation.body.status === 'prepared') {
    const preparationData = preparation.body.data;

    if (ai.actionName === 'check_balance') {
      const execution = await executeAction({
        actionName: ai.actionName,
        payload: finalPayload,
        user: req.user,
      });

      if (execution.body.status === 'completed') {
        const response = {
          success: true,
          status: 'completed',
          agentMode: 'banking_action',
          assistantMessage: buildBalanceResultMessage(execution.body.data, {
            detailsRequested: Boolean(finalPayload._accountDetailsRequested),
          }),
          data: {
            ai: {
              ...ai,
              toolInput: {},
            },
            finalPayload,
            execution: execution.body.data,
            ...fileData,
          },
        };
        logFinalResponse(trace, response, response.status);
        return res.json(response);
      }

      const response = {
        ...execution.body,
        data: { ...(execution.body.data || {}), ...fileData },
      };
      logFinalResponse(trace, response, response.status);
      return res.status(execution.httpStatus).json(response);
    }

    let response;
    if (preparationData.requiresConfirmation) {
      const confirmation = await executeAction({
        actionName: ai.actionName,
        payload: finalPayload,
        user: req.user,
      });

      if (confirmation.body.status === 'confirmation_required') {
        const confirmationData = confirmation.body.data || {};
        const quickActions = buildConfirmationQuickActions(confirmationData.confirmationId);
        const fallbackPreparedMessage = buildPreparedActionMessage({
          ...preparationData,
          summary: confirmationData.summary || preparationData.summary,
          payload: confirmationData.finalPayload || preparationData.payload,
        }, {
          fromFile: Boolean(fileContext?.combinedText),
        });
        const assistantMessage = await buildPreparedActionWriterMessage({
          req,
          message,
          trace,
          ai,
          preparationData: {
            ...preparationData,
            summary: confirmationData.summary || preparationData.summary,
            payload: confirmationData.finalPayload || preparationData.payload,
          },
          confirmationData,
          quickActions,
          fallbackMessage: fallbackPreparedMessage,
        });
        const confirmationAi = attachQuickActions(
          {
            ...ai,
            toolInput: {
              ...(ai.toolInput || {}),
              confirmationRequired: true,
              smsRequired: Boolean(confirmationData.requiresSmsVerification),
            },
          },
          quickActions,
        );
        response = {
          success: true,
          status: 'action_prepared',
          agentMode: 'banking_action',
          assistantMessage,
          data: {
            ai: {
              ...confirmationAi,
              confirmationId: confirmationData.confirmationId,
              assistantMessage,
            },
            finalPayload,
            preparation: preparationData,
            confirmation: confirmationData,
            confirmationId: confirmationData.confirmationId,
            actionName: ai.actionName,
            actions: quickActions,
            ...fileData,
          },
          actions: quickActions,
        };
      } else {
        response = {
          ...confirmation.body,
          data: { ...(confirmation.body.data || {}), preparation: preparationData, ...fileData },
        };
        logFinalResponse(trace, response, response.status);
        return res.status(confirmation.httpStatus).json(response);
      }
    } else {
      const fallbackPreparedMessage = buildPreparedActionMessage(preparationData, {
        fromFile: Boolean(fileContext?.combinedText),
      });
      const assistantMessage = await buildPreparedActionWriterMessage({
        req,
        message,
        trace,
        ai,
        preparationData,
        confirmationData: {},
        quickActions: [],
        fallbackMessage: fallbackPreparedMessage,
      });
      response = {
        success: true,
        status: 'action_prepared',
        agentMode: 'banking_action',
        assistantMessage,
        data: {
          ai: {
            ...ai,
            assistantMessage,
          },
          finalPayload,
          preparation: preparationData,
          ...fileData,
        },
      };
    }
    logArchitecture('action_flow', {
      requestId: trace?.requestId,
      threadId: trace?.threadId,
      actionType: ai.actionName,
      missingFields: [],
      confirmationRequired: Boolean(preparationData.requiresConfirmation),
      smsRequired: Boolean(preparationData.requiresSmsVerification),
      auditLogCreated: true,
      executionStatus: response.status,
    });
    logAgentStep(trace?.requestId, 'action_prepared', {
      actionType: ai.actionName,
      extractedFields: finalPayload,
      missingFields: [],
      confirmationRequired: Boolean(preparationData.requiresConfirmation),
      quickActionsCount: response.actions?.length || response.data?.actions?.length || 0,
    });
    if (ai.actionName === 'create_complaint') {
      logAgentStep(trace?.requestId, 'complaint_action_prepared', {
        extractedFields: finalPayload,
        confirmationRequired: Boolean(preparationData.requiresConfirmation),
        quickActionsCount: response.actions?.length || response.data?.actions?.length || 0,
      });
    }
    logFinalResponse(trace, response, response.status);
    return res.json(response);
  }

  const response = {
    ...preparation.body,
    data: { ...(preparation.body.data || {}), ...fileData },
  };
  logFinalResponse(trace, response, response.status);
  return res.status(preparation.httpStatus).json(response);
};

// ---------------------------------------------------------------------------
// Core dispatch — shared by both message handlers
// ---------------------------------------------------------------------------

const getBackendThreadId = (req) =>
  String(
    req.body.threadId ||
    req.body.conversationId ||
    req.headers['x-thread-id'] ||
    'default',
  )
    .replace(/[^a-zA-Z0-9_.:-]/g, '_')
    .slice(0, 120) || 'default';

const getRequestId = (req) =>
  String(
    req.traceId ||
    req.headers['x-request-id'] ||
    req.body.requestId ||
    randomUUID(),
  )
    .replace(/[^a-zA-Z0-9_.:-]/g, '_')
    .slice(0, 120);

const getTraceContext = (req, message) => {
  const requestId = getRequestId(req);
  const threadId = getBackendThreadId(req);
  const totalTimer = startTimer();
  return {
    requestId,
    threadId,
    totalTimer,
    route: req.originalUrl || req.path,
    userId: req.user?.id || null,
    messagePreview: messagePreview(message),
  };
};

const logFinalResponse = (trace, response, responseType = null) => {
  applyAssistantFormattingGuard(response);
  const assistantMessage = assistantMessageFromResponse(response);
  const ai = response?.data?.ai || {};
  const quickActions = ai.toolInput?.quickActions || response?.actions || response?.data?.actions || [];
  const hasDownloadPdf = Array.isArray(quickActions) && quickActions.some((action) =>
    isDownloadLikeQuickAction(action) ||
    action.type === 'download_pdf' ||
    action.action === 'download',
  );
  const confirmCancelIncluded = Array.isArray(quickActions) && quickActions.some((action) =>
    ['confirm', 'cancel'].includes(String(action.action || action.type || '').toLowerCase()) ||
    /\b(confirm|cancel)\b/i.test(String(action.label || action.title || '')),
  );
  const totalLatencyMs = endTimer(trace?.totalTimer);
  logArchitecture('final_response', {
    requestId: trace?.requestId,
    threadId: trace?.threadId,
    userId: trace?.userId,
    responseType: responseType || response?.status || ai.responseStyle || ai.intent || response?.agentMode,
    responseStyle: ai.responseStyle,
    responsePreview: messagePreview(assistantMessage, 160),
    quickActionsCount: Array.isArray(quickActions) ? quickActions.length : 0,
    totalLatencyMs,
  });
  logAgentStep(trace?.requestId, 'final_response', {
    responseType: responseType || response?.status || ai.responseStyle || ai.intent || response?.agentMode,
    responsePreview: truncate(assistantMessage, 250),
    downloadPdfIncluded: hasDownloadPdf,
    confirmCancelIncluded,
    totalLatencyMs,
  });
};

const memoryConversationHistory = (memory = {}) =>
  (memory.recentMessages || []).map((item) => ({
    role: item.role,
    content: item.content,
  }));

const assistantMessageFromResponse = (response = {}) =>
  response.assistantMessage ||
  response.data?.ai?.assistantMessage ||
  response.message ||
  '';

const adaptResourceResponseForAnalyze = (response = {}, routerDecision = {}) => ({
  success: true,
  message: 'Message analyzed successfully',
  data: {
    ...(response.data?.ai || {}),
    routerDecision,
    ...(response.data?.resourceMatches ? { resourceMatches: response.data.resourceMatches } : {}),
    ...(response.data?.actions ? { actions: response.data.actions } : {}),
  },
});

const sendRoutedResponse = async ({
  res,
  req,
  threadId,
  trace,
  message,
  routerDecision,
  response,
  lastActiveResource = null,
  lastVisionResult = null,
  lastTopic = null,
}) => {
  const finalResponse = {
    ...response,
    data: {
      ...(response.data || {}),
      routerDecision,
    },
  };
  applyAssistantFormattingGuard(finalResponse);
  const blockedReason = isWidgetChatRequest(req) &&
    routerDecision?.reason !== 'file_analysis is disabled in widget chat'
    ? getWidgetBlockedFileAnalysisReason(finalResponse)
    : null;

  if (blockedReason) {
    return handleWidgetFileAnalysisDisabled({
      req,
      res,
      trace,
      message,
      payload: {},
      memory: null,
      threadId,
      source: blockedReason,
    });
  }

  updateAgentMemory({
    userId: req.user.id,
    threadId,
    userMessage: message,
    assistantMessage: assistantMessageFromResponse(finalResponse),
    lastActiveResource,
    lastVisionResult,
    lastCase: routerDecision.case,
    lastTopic,
  });

  logFinalResponse(trace, finalResponse, response.status);
  const result = res.json(finalResponse);
  if (finalResponse.data?.ai) {
    finalResponse.data.ai.assistantMessage = '';
    finalResponse.data.ai.markdown = '';
    finalResponse.data.ai.extractedFields = {};
  }
  logArchitecture('request_temp_cleanup_done', {
    requestId: trace?.requestId,
    threadId: trace?.threadId,
    request_temp_cleanup_done: true,
    context_chars_before: 0,
    context_chars_after: 0,
  });
  return result;
};

const buildUnsafeRequestResponse = () => {
  const assistantMessage =
    'This request is blocked. The assistant cannot perform login, transfers, payments, or withdrawals — please use ATB Connect or visit a branch.';

  return {
    success: true,
    status: 'unsafe_request_refused',
    agentMode: 'informational_answer',
    assistantMessage,
    data: {
      ai: {
        source: 'agent_case_router',
        language: 'english',
        agentMode: 'informational_answer',
        intent: 'unsafe_request',
        actionName: null,
        confidence: 1,
        missingFields: [],
        extractedFields: {},
        requiredTool: 'none',
        toolInput: {},
        assistantMessage,
      },
    },
  };
};

const buildTextOnlyAiResponse = async ({
  req,
  message,
  memory,
  routerDecision,
  trace,
  resolvedResourceContext = null,
  agentContextExtras = {},
  includeBackendMemory = true,
}) => {
  const availableActions = getAvailableAiActions(req.user.role);
  const aiContext = {
    userRole: req.user.role,
    availableActions,
    conversationHistory: memoryConversationHistory(memory),
    fileContext: null,
    profileContext: {},
    resolvedResourceContext: sanitizeResolvedResourceContextForAi(resolvedResourceContext),
    agentContext: {
      ...agentContextExtras,
      ...(includeBackendMemory
        ? {
            backendMemory: {
              lastActiveResource: memory.lastActiveResource || null,
              lastCase: memory.lastCase || null,
              lastTopic: memory.lastTopic || null,
            },
          }
        : {}),
    },
  };
  logAiContextPrepared({
    trace,
    mode: 'text',
    message,
    resources: resolvedResourceContext ? [resolvedResourceContext] : [],
    context: aiContext,
  });
  const aiResponse = await analyzeMessage({
    requestId: trace?.requestId,
    threadId: trace?.threadId,
    message,
    ...aiContext,
  });

  const ai = {
    ...aiResponse.data,
    agentMode: 'informational_answer',
    actionName: null,
    suggestedAction: null,
    requiredTool: 'none',
    routerDecision,
  };

  return {
    success: true,
    status: 'answered',
    agentMode: 'informational_answer',
    assistantMessage: ai.assistantMessage,
    data: { ai },
  };
};

const buildGeneralFallbackResponse = async ({
  req,
  message,
  memory,
  routerDecision,
  trace,
  resourceQuery,
}) => {
  const response = await buildTextOnlyAiResponse({
    req,
    message,
    memory,
    trace,
    agentContextExtras: {
      systemInstruction: [
        'Answer the user banking question directly.',
        'Do not invent a Laragon resource.',
        'If no resource was found, say that briefly after the answer.',
        'Do not return the generic assistant capabilities message unless the user asks what you can do.',
      ].join(' '),
      generalFallback: {
        resourceFound: false,
        resourceQuery: resourceQuery || message,
        originalUserQuestion: message,
      },
    },
    routerDecision: {
      ...routerDecision,
      case: CASES.NORMAL_CHAT,
      modelMode: 'text',
      needsResourceSearch: false,
      needsPdfVision: false,
    },
  });
  const assistantMessage = buildFallbackAssistantMessage({
    originalAnswer: response.assistantMessage,
    userMessage: message,
    resourceQuery: formatResourceQueryLabel(resourceQuery || message),
  });

  return {
    ...response,
    status: 'general_fallback',
    assistantMessage,
    data: {
      ...(response.data || {}),
      ai: {
        ...(response.data?.ai || {}),
        intent: 'general_fallback',
        assistantMessage,
        toolInput: {
          ...(response.data?.ai?.toolInput || {}),
          modelMode: 'text',
          resourceFound: false,
        },
      },
    },
  };
};

const buildGeneralNaturalChatResponse = async ({
  req,
  message,
  memory,
  routerDecision,
  trace,
}) => {
  const response = await buildTextOnlyAiResponse({
    req,
    message,
    memory,
    trace,
    agentContextExtras: {
      systemInstruction: [
        'You are a helpful banking assistant.',
        'Answer the user natural question directly and concisely.',
        'Do not claim you found a server document unless the backend provided one.',
        'Do not execute actions.',
        'Do not reveal sensitive data.',
        'If the question is about bank operations, give safe general guidance and suggest contacting the bank for final decisions.',
        'Do not return a generic capabilities message unless the user asks what you can do or how you can help.',
      ].join(' '),
      generalNaturalChat: {
        resourceFound: false,
        originalUserQuestion: message,
      },
    },
    includeBackendMemory: false,
    routerDecision,
  });

  const fallbackAnswer = buildGeneralBankingFallbackAnswer(message);
  const shouldReplaceGeneric =
    !isCapabilitiesQuestion(message) &&
    isGenericCapabilitiesResponse(response.assistantMessage) &&
    fallbackAnswer;
  const assistantMessage = shouldReplaceGeneric
    ? fallbackAnswer
    : response.assistantMessage;

  return {
    ...response,
    status: 'general_natural_chat',
    assistantMessage,
    data: {
      ...(response.data || {}),
      ai: {
        ...(response.data?.ai || {}),
        intent: CASES.GENERAL_NATURAL_CHAT,
        assistantMessage,
        toolInput: {
          ...(response.data?.ai?.toolInput || {}),
          modelMode: 'text',
          resourceFound: false,
        },
      },
    },
  };
};

const summarizeResourceForWriter = (resource = {}) => {
  const metadata = resource.resourceJson || resource.metadata || resource || {};
  return sanitizeResourceMetadata({
    ...metadata,
    fileName: resource.matchedResource?.fileName || resource.fileName,
    score: resource.matchedResource?.score || resource.score,
    fileUrl: resource.fileUrl || metadata.fileUrl || metadata.documentUrl || metadata.url,
    extractionStatus: resource.extractionStatus,
    fileTextPreview: resource.fileTextPreview || metadata.fileTextPreview || metadata.textPreview,
  });
};

const containsInternalResourceMetadataText = (value = '') =>
  /\b(Category|Summary|File name|Filename|Resource type|Resource ID|Match reason|Matched because|Intents?|MIME type)\s*:/i
    .test(String(value || '')) ||
  /\b(?:json|txt|pdf|image)_resource\b/i.test(String(value || '')) ||
  /\b[\w.-]+\.(?:json|txt|pdf|png|jpe?g)\b/i.test(String(value || ''));

const containsMechanicalResourceLabelText = (value = '') =>
  /^\s*(?:[-*]\s*)?(?:\*\*)?(?:Summary|Category|Recommended next step|Resource type|File name|Status)(?:\*\*)?\s*:/im
    .test(String(value || ''));

const normalizeResourceAnswerSpacing = (value = '') =>
  String(value || '')
    .replace(/([.!?])(?=(?:\*\*)?[A-Z])/g, '$1 ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

const hasMeaningfulBoldMarkdown = (value = '') =>
  /\*\*[^*\n][^*\n]*[^*\n]\*\*/.test(String(value || '')) ||
  /\*\*[^*\n]\*\*/.test(String(value || ''));

const escapeMarkdownBoldValue = (value = '') =>
  String(value || '');

const boldExactPlainText = (text = '', value = '') => {
  const target = String(value || '').trim();
  if (!target || target.length < 2 || text.includes(`**${target}**`)) return text;
  const pattern = new RegExp(escapeRegExp(target), 'i');
  const match = text.match(pattern);
  if (!match?.[0]) return text;
  const index = match.index;
  const matchedText = match[0];
  const before = text.slice(0, index);
  const after = text.slice(index + matchedText.length);
  if ((before.match(/\*\*/g) || []).length % 2 === 1) return text;
  return `${before}**${escapeMarkdownBoldValue(matchedText)}**${after}`;
};

const flattenImportantWriterValues = (value, values = []) => {
  if (value === null || value === undefined || value === '') return values;
  if (Array.isArray(value)) {
    value.forEach((item) => flattenImportantWriterValues(item, values));
    return values;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((item) => flattenImportantWriterValues(item, values));
    return values;
  }
  const text = String(value).trim();
  if (
    text.length >= 2 &&
    text.length <= 80 &&
    !/^(true|false|yes|no)$/i.test(text)
  ) {
    values.push(text);
    if (text.includes(',')) {
      text
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length >= 2 && item.length <= 40)
        .forEach((item) => values.push(item));
    }
  }
  return values;
};

const importantBoldCandidatesFromWriterContext = (writerContext = {}) => {
  const values = flattenImportantWriterValues({
    selectedResource: writerContext?.selectedResource?.title,
    trustedFacts: writerContext?.trustedFacts,
    keyFields: writerContext?.keyFields,
  });
  return Array.from(new Set(values))
    .sort((a, b) => b.length - a.length)
    .slice(0, 24);
};

const addFallbackBoldMarkdown = (answer = '') => {
  let text = String(answer || '');
  const patterns = [
    /\b\d+(?:[.,]\d{1,3})?\s*TND\b/i,
    /\b\d{4}-\d{2}-\d{2}\b/,
    /\b(?:DEMO-)?(?:PAY|TRF|CARD|CMP|APT|STEG|SONEDE|TEL|REF|OTP|SMS|ATM|RIB|CIN|IBAN)-[A-Z0-9-]+\b/i,
    /\*{4,}\d{2,6}\b/,
    /\b(?:Active|Pending activation|Pending|Completed|Confirmed|Blocked|Available|Ready|Unpaid|Paid|Open|Simulated)\b/,
    /\bATB(?:\s+[A-Z][A-Za-z0-9]+){0,4}\b/,
    /\b(?:Student Pack|SME account|credit card limit|home insurance policy|debit card|mobile alerts|e-statements)\b/i,
  ];

  for (const pattern of patterns) {
    if (hasMeaningfulBoldMarkdown(text)) return text;
    text = text.replace(pattern, (match) => `**${escapeMarkdownBoldValue(match)}**`);
  }

  if (!hasMeaningfulBoldMarkdown(text)) {
    text = text.replace(/\b(MVP demo|trusted information|banking actions?|document|image|file|confirmation)\b/i, '**$1**');
  }
  return text;
};

const ensureMeaningfulBoldMarkdown = (assistantMessage = '', writerContext = null) => {
  let text = normalizeResourceAnswerSpacing(assistantMessage);
  if (!text) return text;

  let addedFromTrustedFacts = 0;
  for (const value of importantBoldCandidatesFromWriterContext(writerContext)) {
    const before = text;
    text = boldExactPlainText(text, value);
    if (text !== before) addedFromTrustedFacts += 1;
    if (addedFromTrustedFacts >= 8) break;
  }

  if (hasMeaningfulBoldMarkdown(text)) return text;

  return addFallbackBoldMarkdown(text);
};

const applyAssistantFormattingGuard = (response = {}, writerContext = null) => {
  if (!response || typeof response !== 'object') return response;
  const formatted = ensureMeaningfulBoldMarkdown(assistantMessageFromResponse(response), writerContext);
  if (!formatted) return response;

  if (typeof response.assistantMessage === 'string') {
    response.assistantMessage = formatted;
  }
  if (response.data?.ai && typeof response.data.ai.assistantMessage === 'string') {
    response.data.ai.assistantMessage = formatted;
  }
  if (!response.assistantMessage && !response.data?.ai?.assistantMessage && typeof response.message === 'string') {
    response.message = formatted;
  }
  return response;
};

// Banking acronyms the writer must never spell out unless the trusted resource itself contains the
// expansion. Detection is generic: any "ACRONYM (some spelled-out words)" whose parenthetical is not
// present in the trusted context is an invented expansion (e.g. "CIN (Certificate of Identity
// Number)") and rejects the writer answer.
const GUARDED_ACRONYMS = ['CIN', 'RIB', 'IBAN', 'OTP', 'SME', 'KYC', 'ATM', 'CVV', 'PIN', 'RIP'];

const containsUngroundedAcronymExpansion = (answer = '', writerContext = {}) => {
  const text = String(answer || '');
  if (!text) return false;

  const trustedContextText = JSON.stringify({
    trustedFacts: writerContext?.trustedFacts || {},
    keyFields: writerContext?.keyFields || {},
    summary: writerContext?.resource?.summary || '',
  }).toLowerCase();

  for (const acronym of GUARDED_ACRONYMS) {
    // Tolerate markdown/punctuation between the acronym and the "(" — the writer often bolds the
    // term, e.g. "**owner CIN** (Certificate of Identity Number)".
    const pattern = new RegExp(`\\b${escapeRegExp(acronym)}\\b[\\s*_:]*\\(([^)]{3,})\\)`, 'ig');
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const expansion = match[1].trim();
      // Only treat it as an expansion when the parenthetical spells out words (not e.g. a number),
      // and that exact wording is not grounded in the trusted resource context.
      if (/[a-z]{3,}/i.test(expansion) && !trustedContextText.includes(expansion.toLowerCase())) {
        return true;
      }
    }
  }
  return false;
};

const PAYMENT_STATUS_TERMS = ['paid', 'unpaid', 'settled', 'pending', 'cleared'];

const trustedPaymentStatusTerms = (writerContext = {}) => {
  const facts = {
    ...(writerContext?.trustedFacts || {}),
    ...(writerContext?.keyFields || {}),
  };
  return Object.entries(facts)
    .filter(([key]) => /\bstatus\b/i.test(String(key || '')))
    .map(([, value]) => String(value || '').toLowerCase())
    .flatMap((value) => PAYMENT_STATUS_TERMS.filter((term) => new RegExp(`\\b${term}\\b`, 'i').test(value)));
};

const containsUnsupportedPaymentStatusConclusion = (answer = '', writerContext = {}) => {
  const text = normalizeText(answer);
  if (!text) return false;

  const trustedStatuses = new Set(trustedPaymentStatusTerms(writerContext));
  const hasTrustedPaidLikeStatus =
    trustedStatuses.has('paid') ||
    trustedStatuses.has('settled') ||
    trustedStatuses.has('cleared');
  if (
    !hasTrustedPaidLikeStatus &&
    (
      /\bno outstanding payments?\b/.test(text) ||
      /\bnothing to pay\b/.test(text) ||
      /\bdo not have (?:any )?(?:outstanding )?payments? due\b/.test(text) ||
      /\balready paid\b/.test(text)
    )
  ) {
    return true;
  }

  return ['cleared', 'settled'].some((term) =>
    new RegExp(`\\b${term}\\b`, 'i').test(text) && !trustedStatuses.has(term),
  );
};

const containsUnfocusedCardPaymentFieldDump = (answer = '', writerContext = {}) => {
  const userText = normalizeText(writerContext?.userMessage || writerContext?.intent?.userMessage || '');
  const answerText = normalizeText(answer);
  const titleText = normalizeText(writerContext?.selectedResource?.title || '');
  if (!titleText.includes('credit card limit')) return false;
  if (!/\b(pay|payment|due|owe)\b/.test(userText)) return false;
  const startsIntentFirst = /^(yes|no|your minimum|the minimum|your card payment|the card payment)\b/.test(answerText);
  if (startsIntentFirst) return false;
  const dumpedFieldCount = [
    /\bcurrent limit\b/.test(answerText),
    /\bavailable limit\b/.test(answerText),
    /\bminimum payment\b/.test(answerText),
    /\bpayment due date\b|\bdue on\b|\bdue date\b/.test(answerText),
  ].filter(Boolean).length;
  return dumpedFieldCount >= 3;
};

const detectResourceAnswerIntent = (message = '') => {
  const text = normalizeText(message);
  if (/\b(still\s+)?(?:have|need)\s+to\s+pay\b|\bpay\s+(?:something|anything)\b|\banything\s+to\s+pay\b|\bnothing\s+to\s+pay\b|\bowe\b|\bminimum\s+payment\b|\bpayment\b.*\bdue\b|\bdue\b.*\bpayment\b|\bwhen\b.*\bpay\b/.test(text)) {
    return 'card_payment_obligation';
  }
  if (/\bavailable\b.*\b(card|limit|credit|amount)\b|\b(card|limit|credit|amount)\b.*\bavailable\b/.test(text)) {
    return 'available_card_limit';
  }
  if (/\bcurrent\b.*\blimit\b|\blimit\b.*\bcurrent\b|\bcard\s+limit\b|\blimit\b/.test(text)) {
    return 'card_limit';
  }
  if (/\bstatement\b/.test(text)) {
    return 'statement';
  }
  return 'general_resource_answer';
};

const buildCardPaymentObligationFinalAnswer = (writerContext = {}) => {
  const facts = {
    ...(writerContext?.trustedFacts || {}),
    ...(writerContext?.keyFields || {}),
  };
  const title = normalizeText(writerContext?.selectedResource?.title || '');
  if (!title.includes('credit card limit')) return null;

  const card = facts.card || facts.maskedCard || facts.cardNumber;
  const minimumPayment = facts.minimumPayment;
  const paymentDueDate = facts.paymentDueDate || facts.dueDate;
  if (!minimumPayment || !paymentDueDate) return null;

  const status = Object.entries(facts)
    .find(([key, value]) => /\bstatus\b/i.test(String(key || '')) && value)?.[1];
  const statusText = status ? ` The payment status is **${status}**.` : '';
  return `Yes. You need to pay at least **${minimumPayment}** by **${paymentDueDate}**${card ? ` for card **${escapeMarkdownBoldValue(card)}**` : ''}.${statusText}`;
};

const buildAvailableCardLimitFinalAnswer = (writerContext = {}) => {
  const facts = {
    ...(writerContext?.trustedFacts || {}),
    ...(writerContext?.keyFields || {}),
  };
  const title = normalizeText(writerContext?.selectedResource?.title || '');
  if (!title.includes('credit card limit')) return null;

  const availableLimit = facts.availableLimit;
  if (!availableLimit) return null;
  const card = facts.card || facts.maskedCard || facts.cardNumber;
  return `Your available card limit is **${availableLimit}**${card ? ` for card **${escapeMarkdownBoldValue(card)}**` : ''}.`;
};

const finalizeResourceAnswer = ({ assistantMessage = '', writerContext = null } = {}) => {
  const detectedAnswerIntent = detectResourceAnswerIntent(
    writerContext?.userMessage || writerContext?.intent?.userMessage || '',
  );
  let finalAnswer = normalizeResourceAnswerSpacing(assistantMessage);
  let guardApplied = false;

  if (detectedAnswerIntent === 'card_payment_obligation') {
    const narrowAnswer = buildCardPaymentObligationFinalAnswer(writerContext);
    if (narrowAnswer) {
      finalAnswer = normalizeResourceAnswerSpacing(narrowAnswer);
      guardApplied = finalAnswer !== normalizeResourceAnswerSpacing(assistantMessage);
    }
  } else if (detectedAnswerIntent === 'available_card_limit') {
    const narrowAnswer = buildAvailableCardLimitFinalAnswer(writerContext);
    if (narrowAnswer) {
      finalAnswer = normalizeResourceAnswerSpacing(narrowAnswer);
      guardApplied = finalAnswer !== normalizeResourceAnswerSpacing(assistantMessage);
    }
  }

  return {
    detectedAnswerIntent,
    finalAnswer,
    guardApplied,
  };
};

const logResourceAnswerDebug = ({
  writerContext = null,
  detectedAnswerIntent = '',
  rawWriterAnswer = '',
  guardApplied = false,
  finalAnswerReturned = '',
} = {}) => {
  if (!env.debugResourceAnswer) return;
  console.log('[resource-answer-debug]', {
    userQuery: writerContext?.userMessage || writerContext?.intent?.userMessage || '',
    selectedResource: {
      title: writerContext?.selectedResource?.title || null,
      id: writerContext?.resource?.selectedResource?.resourceId ||
        writerContext?.trustedFacts?.resourceId ||
        writerContext?.keyFields?.resourceId ||
        null,
    },
    detectedAnswerIntent,
    rawWriterAnswer,
    guardApplied,
    finalAnswerReturned,
  });
};

const extractSelectedResourceForRoutingDebug = (response = {}) => {
  const ai = response?.data?.ai || response?.ai || {};
  const match = response?.data?.resourceMatches?.[0] || response?.resourceMatches?.[0] || null;
  const resource = ai.toolInput?.resourceMetadata ||
    ai.toolInput?.metadataFirst?.resourceMetadata ||
    response?.data?.resource ||
    response?.resource ||
    match ||
    null;

  return {
    title: resource?.title || resource?.metadata?.title || match?.title || null,
    id: resource?.resourceId || resource?.id || resource?.metadata?.resourceId || match?.resourceId || null,
  };
};

const logAgentRoutingDebug = ({
  message = '',
  routerDecision = {},
  response = null,
  finalRoute = '',
  endpoint = null,
  finalAnswer = null,
} = {}) => {
  if (!env.debugAgentRouting) return;
  const msgHash = String(message).toLowerCase().replace(/\W+/g, '').slice(0, 8);
  const intent = routerDecision.plannerDecision?.intentType || routerDecision.intentType || routerDecision.case || 'unknown';
  const action = routerDecision.plannerDecision?.actionName ?? 'null';
  const sel = extractSelectedResourceForRoutingDebug(response || {});
  const route = finalRoute || routerDecision.case || 'unknown';
  console.log(
    `[ROUTE_PROOF] endpoint=${endpoint || 'unknown'} msgHash=${msgHash}` +
    ` intent=${intent} action=${action}` +
    ` resourceObject=${hasResourceObjectDetected(message)} complaintEligible=${isComplaintStatusEligible(message)}` +
    ` selected="${sel?.title || 'none'}" finalRoute=${route}`
  );
};

// Map the backend's FINAL router decision to one of the 5 MVP flow paths, for debug visibility.
// (Image OCR is a sub-path chosen after catalog retrieval selects an image resource, so at decision
// time an image question still reads as trusted_qa; the OCR use is logged later as source=image_resource_ocr.)
const mvpPathFromRouterDecision = (routerDecision = {}) => {
  if (routerDecision.needsActionFlow || routerDecision.case === CASES.BANKING_ACTION) {
    return 'demo_banking_action';
  }
  if (routerDecision.case === CASES.RESOURCE_DOWNLOAD) return 'show_file';
  if (routerDecision.needsPdfVision) return 'image_ocr';
  if (routerDecision.needsResourceSearch || routerDecision.case === CASES.LARAGON_RESOURCE_METADATA) {
    return 'trusted_qa';
  }
  return 'general_or_unsupported';
};

// Env-gated proof of the "Ollama suggests, Backend decides" handoff and the chosen MVP path.
const logMvpPathDecision = ({ routerDecision = {}, plannerDecision = null }) => {
  if (!env.debugAgentRouting) return;
  const suggested = plannerDecision?.intentType || plannerDecision?.mode || 'unknown';
  console.log(
    `[PATH_DECISION] ollamaSuggested=${suggested}` +
    ` backendCase=${routerDecision.case || 'unknown'}` +
    ` mvpPath=${mvpPathFromRouterDecision(routerDecision)}` +
    ` plannerApplied=${routerDecision.plannerApplied !== false}` +
    ` needsCatalog=${Boolean(routerDecision.needsResourceSearch)}` +
    ` needsAction=${Boolean(routerDecision.needsActionFlow)}`
  );
};

// F: clean unsupported handling. A message is "resource-like" when it asks to read/show/open a known
// bank object or looks up bank info — those keep the existing catalog behaviour. Everything else under
// a planner `no_match` is out of scope for this MVP and gets a clean reply instead of a catalog "not
// found". The backend (not Ollama) still makes this final call.
const looksResourceLike = (message = '') =>
  appearsToNeedResourceLookup(message) ||
  isResourceRetrievalDownloadRequest(message) ||
  hasResourceObjectDetected(message);

const MVP_UNSUPPORTED_MESSAGE =
  "I can't help with that in this MVP demo. I can, however, help you with demo banking actions " +
  '(like a bill payment or transfer), reading an uploaded document or image with OCR, showing an ' +
  'available bank file, or answering questions from trusted bank information.';

const buildUnsupportedMvpResponse = (routerDecision = {}) => ({
  success: true,
  status: 'unsupported',
  agentMode: 'informational_answer',
  assistantMessage: MVP_UNSUPPORTED_MESSAGE,
  data: {
    ai: {
      source: 'mvp_unsupported',
      finalAnswerSource: 'mvp_unsupported',
      agentMode: 'informational_answer',
      intent: 'unsupported',
      actionName: null,
      suggestedAction: null,
      missingFields: [],
      responseStyle: RESPONSE_STYLES.GENERAL_NATURAL_CHAT,
      requiredTool: 'none',
      toolInput: { modelMode: 'text' },
      assistantMessage: MVP_UNSUPPORTED_MESSAGE,
      routerDecision,
    },
  },
});

// A — low-confidence trusted-QA guard. A normal bank question is "low confidence" when its best
// catalog match is too weak (below RESOURCE_QA_MIN_SCORE) or only narrowly beats the runner-up
// (margin below RESOURCE_QA_MIN_MARGIN). In that case the backend must NOT answer from the weak
// resource. Applied to trusted QA only (callers gate on writerMode === 'resource_qa').
const isLowConfidenceQaMatch = (resourceContext = {}) => {
  const matches = Array.isArray(resourceContext.matchedResources) ? resourceContext.matchedResources : [];
  const bestScore = Number(resourceContext.matchedResource?.score ?? matches[0]?.score ?? 0);
  const secondScore = Number(matches[1]?.score ?? 0);
  const hasCompetitor = matches.length >= 2;
  const margin = bestScore - secondScore;
  const lowConfidence =
    bestScore < env.resourceQaMinScore ||
    (hasCompetitor && margin < env.resourceQaMinMargin);
  if (env.debugResourceSearch || env.debugAgentRouting) {
    console.log(
      `[QA_CONFIDENCE] best=${bestScore} second=${secondScore} margin=${margin}` +
      ` minScore=${env.resourceQaMinScore} minMargin=${env.resourceQaMinMargin}` +
      ` lowConfidence=${lowConfidence}` +
      ` resource="${resourceContext.matchedResource?.title || resourceContext.resourceJson?.title || 'none'}"`,
    );
  }
  return lowConfidence;
};

const TRUSTED_QA_INSUFFICIENT_MESSAGE =
  "I don't have enough trusted information in this MVP demo to answer that accurately. " +
  'Could you clarify what you need (for example the type of account), or share the related bank document?';

const buildLowConfidenceQaResponse = (routerDecision = {}) => ({
  success: true,
  status: 'low_confidence_qa',
  agentMode: 'informational_answer',
  assistantMessage: TRUSTED_QA_INSUFFICIENT_MESSAGE,
  data: {
    ai: {
      source: 'trusted_info_insufficient',
      finalAnswerSource: 'trusted_info_insufficient',
      agentMode: 'informational_answer',
      intent: 'resource_qa',
      actionName: null,
      suggestedAction: null,
      missingFields: [],
      responseStyle: RESPONSE_STYLES.RESOURCE_QUESTION_ANSWER,
      requiredTool: 'none',
      toolInput: { modelMode: 'text' },
      assistantMessage: TRUSTED_QA_INSUFFICIENT_MESSAGE,
      routerDecision,
    },
  },
});

const WRITER_FIELD_LIMIT = 18;
const WRITER_FIELD_CHAR_LIMIT = 240;
const WRITER_SUMMARY_CHAR_LIMIT = 900;

const trimWriterText = (value = '', limit = WRITER_FIELD_CHAR_LIMIT) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trim()}...`;
};

const compactWriterValue = (value, limit = WRITER_FIELD_CHAR_LIMIT) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;

  if (Array.isArray(value)) {
    const items = value
      .map((item) => compactWriterValue(item, Math.max(80, Math.floor(limit / 3))))
      .filter((item) => item !== null && item !== undefined && item !== '')
      .slice(0, 6);
    return items.length ? items : null;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, compactWriterValue(item, Math.max(80, Math.floor(limit / 3)))])
      .filter(([, item]) => item !== null && item !== undefined && item !== '')
      .slice(0, 8);
    return entries.length ? Object.fromEntries(entries) : null;
  }

  return trimWriterText(value, limit);
};

const parseWriterLabeledText = (value = '') => {
  const fields = {};
  const text = String(value || '');
  if (!text.trim()) return fields;

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9 _/-]{1,60})\s*:\s*(.+?)\s*$/);
    if (!match) continue;
    const key = match[1]
      .trim()
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const fieldValue = match[2].trim();
    if (key && fieldValue && !SEARCH_LIST_TECHNICAL_FIELDS.has(normalizedResourceKey(key))) {
      fields[key] = fieldValue;
    }
  }

  return fields;
};

const normalizeWriterFileType = (resourceContext = {}, metadata = {}) => {
  const explicitType = normalizeText([
    resourceContext.resourceFileType,
    metadata.resourceFileType,
    metadata.fileType,
    metadata.mimeType,
    metadata.contentType,
  ].filter(Boolean).join(' '));
  const fileUrl = resourceContext.fileUrl || metadata.fileUrl || metadata.documentUrl || metadata.url || '';
  const fileNameSource = fileUrl || resourceContext.matchedResource?.fileName || metadata.fileName || '';
  const fileName = fileNameSource ? getFileNameFromUrl(fileNameSource) : '';
  const extension = String(fileName || '').toLowerCase().split(/[?#]/)[0].split('.').pop();
  const contentType = resourceContext.contentType || metadata.mimeType || metadata.contentType || '';

  if (
    explicitType.includes('image') ||
    isImageFileReference(fileUrl || fileName, contentType, metadata) ||
    ['png', 'jpg', 'jpeg'].includes(extension)
  ) {
    return 'image';
  }

  if (
    explicitType.includes('scanned pdf') ||
    explicitType.includes('visual pdf') ||
    (
      resourceContext.needsVision &&
      (isPdfFileReference(fileUrl || fileName, contentType) || extension === 'pdf')
    )
  ) {
    return 'scanned_pdf';
  }

  if (explicitType.includes('pdf') || isPdfFileReference(fileUrl || fileName, contentType) || extension === 'pdf') {
    return 'pdf';
  }

  if (explicitType.includes('txt') || explicitType.includes('text plain') || extension === 'txt') {
    return 'txt';
  }

  if (explicitType.includes('json') || extension === 'json') {
    return 'json';
  }

  return 'json';
};

const buildWriterFieldsFromMetadata = (metadata = {}) => {
  const { fieldsByKey } = collectSearchListFields(metadata);
  const textFields = parseWriterLabeledText(
    metadata.fileText ||
    metadata.fileTextPreview ||
    metadata.textPreview ||
    metadata.extractedTextPreview ||
    '',
  );
  const fields = Array.from(fieldsByKey.values())
    .filter((item) => normalizedResourceKey(item.key) !== 'category')
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, WRITER_FIELD_LIMIT)
    .map((item) => [item.key, compactWriterValue(item.value)]);

  return Object.fromEntries(
    [
      ...Object.entries(textFields),
      ...fields,
    ]
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .slice(0, WRITER_FIELD_LIMIT),
  );
};

const writerSummaryFromParts = (parts = []) =>
  trimWriterText(
    parts
      .map((part) => String(part || '').trim())
      .filter(Boolean)
      .join(' '),
    WRITER_SUMMARY_CHAR_LIMIT,
  );

const buildWriterResourceSummary = ({ resourceContext = {}, metadata = {}, fields = {} } = {}) => {
  const directSummary = writerSummaryFromParts([
    metadata.summary,
    metadata.description,
    metadata.purpose,
    metadata.recommendedAction,
    metadata.recommendation,
    metadata.textPreview,
    metadata.fileTextPreview,
    resourceContext.fileTextPreview,
    resourceContext.textPreview,
  ]);
  if (directSummary) return directSummary;

  const importantFields = Object.entries(fields)
    .slice(0, 8)
    .map(([key, value]) => `${humanizeResourceFieldLabel(key)}: ${Array.isArray(value) ? value.join(', ') : value}`);
  return writerSummaryFromParts(importantFields);
};

const inferAllowedActionHints = ({ metadata = {}, fields = {}, quickActions = [] } = {}) => {
  const text = normalizeText([
    metadata.title,
    metadata.resourceType,
    metadata.description,
    fields.recommendedAction,
    fields.recommendation,
    fields.recommendedStep,
    fields.status,
    fields.merchant,
    fields.provider,
  ].filter(Boolean).join(' '));
  const hints = [];

  if (quickActions.some((action) => isDownloadLikeQuickAction(action))) {
    hints.push('download_pdf');
  }
  if (quickActions.some((action) => action?.type === 'view_image' || action?.action === 'open')) {
    hints.push('view_image');
  }
  if (/\b(dispute|unauthorized|not yours|not recognized|card transaction|sms alert)\b/.test(text)) {
    hints.push('prepare_dispute');
  }
  if (/\b(cancel|direct debit|mandate)\b/.test(text)) {
    hints.push('prepare_cancel_mandate');
  }
  if (/\b(transfer|beneficiary|wire)\b/.test(text)) {
    hints.push('prepare_transfer');
  }
  if (/\b(appointment|branch visit|card pickup)\b/.test(text)) {
    hints.push('prepare_appointment');
  }
  if (/\b(pay|bill|invoice|steg|sonede|telecom|merchant payment)\b/.test(text)) {
    hints.push('prepare_payment');
  }

  return Array.from(new Set(hints)).slice(0, 5);
};

// Catalog selection / structural keys that must be stripped before the resource reaches the
// response writer. They drive resource selection and plumbing only — never the user-facing answer.
const CATALOG_SELECTION_ONLY_WRITER_KEYS = new Set([
  'description',
  'files',
  'catalogversion',
  'id',
  'folder',
  'filetype',
  'preferredfor',
  'routingpolicy',
  'selectionpolicy',
  'intents',
  'examplequeries',
  'relatedactions',
  'keywords',
  'note',
  'synthetic',
  'environment',
  'localpathhint',
  'service',
  'customerid',
  'debug',
  'filename',
  'resourcefiletype',
  'fileurl',
  'url',
  'documenturl',
  'jsonurl',
  'resourceurl',
  'mimetype',
  'contenttype',
  'resourceid',
]);

const buildWriterResourceContext = ({
  resourceContext = null,
  resourceMatches = [],
  quickActions = [],
} = {}) => {
  const match = resourceContext
    ? resourceContext.matchedResource
    : resourceMatches[0];
  const rawMetadata = resourceContext
    ? (resourceContext.resourceJson || match?.metadata || {})
    : (match?.metadata || match?.resourceJson || match || {});
  if (!rawMetadata || !Object.keys(rawMetadata).length) return null;
  // Catalog selection/structural metadata is used ONLY to pick the resource. It must never reach
  // the response writer: the `description` is selection guidance ("Use it when the user asks
  // about ...") that the model would echo verbatim as the answer (the "I found ATB Branch
  // Directory ..." leak), and the structural keys (files/folder/catalogVersion/...) are internal
  // plumbing. Trusted file text + trusted domain fields still feed the writer.
  const metadata = Object.fromEntries(
    Object.entries(rawMetadata).filter(
      ([key]) => !CATALOG_SELECTION_ONLY_WRITER_KEYS.has(String(key).toLowerCase()),
    ),
  );

  const safe = summarizeResourceForWriter({
    ...metadata,
    resourceJson: metadata,
    matchedResource: match,
    fileName: match?.fileName || metadata.fileName,
    fileTextPreview: resourceContext?.fileTextPreview || metadata.fileTextPreview || metadata.textPreview,
    extractionStatus: resourceContext?.extractionStatus || metadata.extractionStatus,
  });
  // `safe`/match re-inject plumbing keys (fileName, resourceFileType, ...) — strip them again so
  // they never surface as writer "fields" or feed the summary fallback.
  const fields = Object.fromEntries(
    Object.entries(
      buildWriterFieldsFromMetadata({
        ...safe,
        ...metadata,
        fileText: resourceContext?.fileText || metadata.fileText,
        fileTextPreview:
          resourceContext?.fileTextPreview ||
          safe.fileTextPreview ||
          metadata.fileTextPreview ||
          metadata.textPreview,
      }),
    ).filter(
      ([key]) =>
        !CATALOG_SELECTION_ONLY_WRITER_KEYS.has(
          String(key).toLowerCase().replace(/[^a-z0-9]+/g, ''),
        ),
    ),
  );
  const fileType = normalizeWriterFileType(resourceContext || {}, {
    ...metadata,
    fileName: match?.fileName || metadata.fileName,
  });
  const resourceType = metadata.resourceType || safe.resourceType || fileType;
  const title = safe.title || metadata.title || match?.fileName || 'Resource';
  const summary = buildWriterResourceSummary({
    resourceContext: resourceContext || {},
    metadata: {
      ...metadata,
      ...safe,
      fileTextPreview: resourceContext?.fileTextPreview || safe.fileTextPreview || metadata.textPreview,
    },
    fields,
  });
  const actionHints = inferAllowedActionHints({ metadata, fields, quickActions });

  return {
    title,
    resourceType,
    fileType,
    fields,
    trustedFacts: fields,
    keyFields: fields,
    summary,
    selectedResource: {
      title,
      resourceType,
      fileType,
    },
    allowedActionHints: actionHints,
    downloadAvailable: quickActions.some((action) => isDownloadLikeQuickAction(action)),
    openImageAvailable: quickActions.some((action) => action?.type === 'view_image' || action?.action === 'open'),
  };
};

const fieldsFromActionSummary = (summary = []) =>
  Object.fromEntries(
    (Array.isArray(summary) ? summary : [])
      .map((item) => String(item || '').split(/:\s+(.+)/))
      .filter((parts) => parts.length >= 3 && parts[0].trim() && parts[1].trim())
      .map((parts) => [parts[0].trim(), trimWriterText(parts[1])]),
  );

const buildWriterActionDraftContext = ({
  writerMode = 'resource_qa',
  extraContext = {},
  routerDecision = {},
} = {}) => {
  const action = extraContext.actionDraft || extraContext.action || {};
  const type = action.type || action.actionName || routerDecision.action || routerDecision.actionName || null;
  const isPrepared = writerMode === 'action_prepare' || Boolean(extraContext.confirmationRequired);
  if (!type && !isPrepared) {
    return {
      type: null,
      status: 'none',
      fields: {},
      requiresConfirmation: false,
    };
  }

  const fields = {
    ...fieldsFromActionSummary(action.summary),
    ...(action.fields || {}),
    ...(action.payload || {}),
  };
  delete fields.confirmationId;
  delete fields.smsCode;
  delete fields.otp;

  return {
    type,
    status: isPrepared ? 'prepared' : 'none',
    fields: Object.fromEntries(
      Object.entries(fields)
        .map(([key, value]) => [key, compactWriterValue(value)])
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .slice(0, WRITER_FIELD_LIMIT),
    ),
    requiresConfirmation: Boolean(
      extraContext.confirmationRequired ||
      action.requiresConfirmation ||
      action.requiresSmsVerification,
    ),
  };
};

const buildResponseWriterContext = ({
  message = '',
  routerDecision = {},
  resourceContext = null,
  resourceMatches = [],
  responseStyle = null,
  status = 'resource_answer',
  quickActions = [],
  writerMode = 'resource_qa',
  extraContext = {},
} = {}) => {
  const resource = buildWriterResourceContext({
    resourceContext,
    resourceMatches,
    quickActions,
  });
  const intent = {
    mode: writerMode,
    responseStyle,
    status,
    userMessage: trimWriterText(message, 300),
    plannerIntent: routerDecision.intentType || routerDecision.intent || routerDecision.case || null,
    resourceQuery: routerDecision.resourceQuery || routerDecision.resourceHint || routerDecision.query || null,
    action: routerDecision.action || routerDecision.actionName || extraContext.action?.actionName || null,
    statusQuestion: isStatusQuestion(message),
  };

  return {
    userMessage: intent.userMessage,
    intent,
    selectedResource: resource?.selectedResource || null,
    resourceType: resource?.resourceType || null,
    trustedFacts: resource?.trustedFacts || {},
    keyFields: resource?.keyFields || {},
    allowedActionHints: resource?.allowedActionHints || [],
    resource,
    actionDraft: buildWriterActionDraftContext({
      writerMode,
      extraContext,
      routerDecision,
    }),
    answerRules: {
      style: 'natural professional ATB digital banking assistant',
      styleInstruction: 'answer naturally, adapt to the user wording, hide internal metadata',
      markdown: true,
      boldKeyValues: true,
      noMechanicalFieldDump: true,
      answerUserIntentFirst: true,
      useDirectFactsAsEvidence: true,
      doNotListEveryExtractedField: true,
      includeSecondaryFieldsOnlyWhenUseful: true,
      noInternalMetadata: true,
      noInventedData: true,
      preserveAcronymsExactly: true,
      doNotExpandAcronymsUnlessTrusted: true,
      doNotInferPaymentStatus: true,
      minimumPaymentAndDueDateMeansPaymentDue: true,
      preserveMaskedValues: true,
      cleanSentenceSpacing: true,
      singleResourceParagraphs: '1-3',
      yesNoFirst: true,
      whatHappenedAsShortStory: true,
      whyReasonThenAction: true,
      whoWhatIdentifyFirst: true,
      actionResourcesOfferPreparationOnly: true,
    },
  };
};

const buildResponseWriterFallbackMessage = ({
  message = '',
  routerDecision = {},
  resources = [],
  writerMode = 'resource_qa',
  extraContext = {},
} = {}) => {
  if (writerMode === 'resource_search') {
    if (!resources.length) {
      return buildPlannerResourceNoMatchResponse().assistantMessage;
    }
    const names = resources
      .slice(0, 4)
      .map((resource) => `**${resource.title || resource.fileName || 'Resource'}**`)
      .join(', ');
    return `I found ${resources.length === 1 ? 'one matching resource' : `${resources.length} matching resources`}: ${names}.`;
  }

  if (writerMode === 'action_prepare') {
    return extraContext.fallbackMessage ||
      'I prepared the action details. Please confirm before I continue.';
  }

  const primaryResource = resources[0] || {};
  return buildMetadataFirstAnswer({ resourceJson: primaryResource, message }) ||
    `I found **${primaryResource.title || routerDecision.resourceHint || message || 'the matching resource'}**.`;
};

const isAccountClarificationText = (value = '') =>
  /which account would you like to check/i.test(String(value || '')) ||
  /i can show your account details/i.test(String(value || ''));

const isStructuredResourceAnswer = (text = '') =>
  /^\*\*[A-Za-z][^*\n]+:\*\* \S/m.test(String(text || ''));

const hasBoldHighlight = (text = '') => /\*\*[^*\n]+\*\*/.test(String(text || ''));

const buildResourceResponseWriterResponse = async ({
  req,
  message,
  trace,
  routerDecision = {},
  resourceContext = null,
  resourceMatches = [],
  responseStyle = null,
  status = 'resource_answer',
  quickActions = [],
  writerMode = 'resource_qa',
  extraContext = {},
}) => {
  // Catalog-description QA runs FIRST for every resource_qa answer path (resource-first AND the
  // AI search_resource path), so the behaviour is uniform. A validated description answer wins;
  // otherwise we fall through to the deterministic builder + writer below.
  if (writerMode === 'resource_qa' && resourceContext) {
    const descriptionQaResponse = await buildCatalogDescriptionQaResponse({
      req,
      message,
      trace,
      resourceContext,
      routerDecision,
    });
    if (descriptionQaResponse) return descriptionQaResponse;
  }
  const availableActions = getAvailableAiActions(req.user.role);
  const normalizedQuickActions = dedupeQuickActions(quickActions);
  let resources = resourceContext
    ? [summarizeResourceForWriter(resourceContext)]
    : resourceMatches.map(summarizeResourceForWriter);
  const resourceCount = resources.length;
  let writerContext = buildResponseWriterContext({
    message,
    routerDecision,
    resourceContext,
    resourceMatches,
    responseStyle,
    status,
    quickActions: normalizedQuickActions,
    writerMode,
    extraContext,
  });
  const finalizerWriterContext = writerContext;
  let aiContext = {
    userRole: req.user.role,
    availableActions,
    conversationHistory: [],
    fileContext: null,
    profileContext: {},
    resolvedResourceContext: null,
    agentContext: {
      systemInstruction: RESPONSE_WRITER_INSTRUCTION,
      resourceResponseWriter: writerContext,
    },
  };
  let aiResponse = null;
  // A caller-supplied authoritative message (e.g. the deterministic "ready to download" wording)
  // is used verbatim and never replaced by the local Ollama writer.
  const authoritativeMessage =
    typeof extraContext.authoritativeMessage === 'string' && extraContext.authoritativeMessage.trim()
      ? extraContext.authoritativeMessage.trim()
      : null;
  let assistantMessage = authoritativeMessage || buildResponseWriterFallbackMessage({
    message,
    routerDecision,
    resources,
    writerMode,
    extraContext,
  });

  logAgentStep(trace?.requestId, 'response_writer_started', {
    mode: writerMode,
    responseStyle,
    resourceCount,
    downloadActionIncluded: normalizedQuickActions.some((action) => isDownloadLikeQuickAction(action)),
    confirmationRequired: Boolean(extraContext.confirmationRequired),
  });
  logAiContextPrepared({
    trace,
    mode: 'text',
    message,
    resources,
    context: aiContext,
  });

  // For resource_qa, build the answer from the RAW resource JSON so every trusted domain
  // field survives. The fallback message above is built from sanitizeResourceMetadata, which
  // intentionally drops non-whitelisted fields (e.g. recommendedAction, topic, riskLevel) — that
  // strip is what made the security-notice answer collapse to a bare title/category line. Image
  // resource_qa is excluded: its answer is grounded on the trusted OCR/vision text, not metadata.
  const rawResourceJson = resourceContext?.resourceJson
    ? {
        ...resourceContext.resourceJson,
        fileText: resourceContext.fileText || resourceContext.resourceJson.fileText,
        textPreview:
          resourceContext.fileTextPreview ||
          resourceContext.resourceJson.textPreview ||
          resourceContext.resourceJson.fileTextPreview,
      }
    : null;
  const isImageResourceContext =
    resourceContext?.resourceFileType === 'image' ||
    String(resourceContext?.contentType || '').toLowerCase().startsWith('image/');

  // Trusted-data-first: when a domain-specific deterministic builder can answer from the RAW
  // resource JSON (reading nested arrays/tables and exact fields, with Markdown bold), that answer
  // wins and the model writer is skipped entirely. This stops the writer — which only sees the
  // sanitized summary metadata — from answering out of default/summary fields or dropping bold.
  // Image resource_qa is excluded (grounded on OCR/vision text, not structured metadata). A generic
  // (non-specific) deterministic answer does NOT win; those resources still go to the writer.
  let specificDeterministicAnswer = null;
  if (writerMode === 'resource_qa' && rawResourceJson && !isImageResourceContext) {
    const specific = buildSpecificResourceAnswer({ resourceJson: rawResourceJson, message });
    if (specific.isSpecific && specific.answer) {
      specificDeterministicAnswer = specific.answer;
    }
  }

  // An explicit authoritative message (e.g. the "ready to download" wording) short-circuits the
  // writer. The generic "I found <title>" fallback does NOT, so those cases still get Ollama.
  const deterministicIsAuthoritative = Boolean(authoritativeMessage) || Boolean(specificDeterministicAnswer);
  // answerSource: where the FINAL answer came from — trusted_deterministic, writer, deterministic_fallback.
  let answerSource = authoritativeMessage ? 'authoritative_message' : 'writer';
  let writerRewroteAnswer = false;
  if (specificDeterministicAnswer && !authoritativeMessage) {
    assistantMessage = normalizeResourceAnswerSpacing(specificDeterministicAnswer);
    answerSource = 'trusted_deterministic';
  }

  try {
    if (!deterministicIsAuthoritative) {
      aiResponse = await analyzeMessage({
        requestId: trace?.requestId,
        threadId: trace?.threadId,
        message,
        ...aiContext,
      });
      const writerAssistantMessage = String(aiResponse.data?.assistantMessage || '').trim();
      if (
        writerAssistantMessage &&
        !isAccountClarificationText(writerAssistantMessage) &&
        !containsInternalResourceMetadataText(writerAssistantMessage) &&
        !containsMechanicalResourceLabelText(writerAssistantMessage) &&
        !containsUngroundedAcronymExpansion(writerAssistantMessage, writerContext) &&
        !containsUnsupportedPaymentStatusConclusion(writerAssistantMessage, writerContext) &&
        !containsUnfocusedCardPaymentFieldDump(writerAssistantMessage, writerContext)
      ) {
        assistantMessage = normalizeResourceAnswerSpacing(writerAssistantMessage);
        answerSource = 'writer';
        writerRewroteAnswer = true;
      } else if (writerMode === 'resource_qa' && rawResourceJson && !isImageResourceContext) {
        // Writer returned an unusable answer — fall back to deterministic template
        const deterministicAnswer = buildMetadataFirstAnswer({ resourceJson: rawResourceJson, message });
        if (deterministicAnswer) {
          assistantMessage = normalizeResourceAnswerSpacing(deterministicAnswer);
          answerSource = 'deterministic_fallback';
        }
      }
    }
  } catch (error) {
    // Writer call failed — fall back to deterministic template for resource_qa
    if (writerMode === 'resource_qa' && rawResourceJson && !isImageResourceContext) {
      const deterministicAnswer = buildMetadataFirstAnswer({ resourceJson: rawResourceJson, message });
      if (deterministicAnswer) {
        assistantMessage = normalizeResourceAnswerSpacing(deterministicAnswer);
        answerSource = 'deterministic_fallback';
      }
    }
    logAgentStep(trace?.requestId, 'response_writer_failed', {
      mode: writerMode,
      responseStyle,
      resourceCount,
      error: error.message || 'response writer failed',
    });
  } finally {
    if (aiContext?.agentContext?.resourceResponseWriter) {
      aiContext.agentContext.resourceResponseWriter.resource = null;
      aiContext.agentContext.resourceResponseWriter.actionDraft = null;
    }
    resources = [];
    writerContext = null;
    aiContext = null;
  }

  const { quickActions: ignoredWriterQuickActions, ...writerToolInput } =
    aiResponse?.data?.toolInput || {};
  void ignoredWriterQuickActions;
  const rawAnswerBeforeFinalizer = normalizeResourceAnswerSpacing(assistantMessage);
  const finalizedAnswer = finalizeResourceAnswer({
    assistantMessage: rawAnswerBeforeFinalizer,
    writerContext: finalizerWriterContext,
  });
  assistantMessage = finalizedAnswer.finalAnswer;
  assistantMessage = ensureMeaningfulBoldMarkdown(assistantMessage, finalizerWriterContext);
  if (finalizedAnswer.guardApplied) {
    answerSource = 'finalizer_guard';
    writerRewroteAnswer = false;
  }
  logResourceAnswerDebug({
    writerContext: finalizerWriterContext,
    detectedAnswerIntent: finalizedAnswer.detectedAnswerIntent,
    rawWriterAnswer: rawAnswerBeforeFinalizer,
    guardApplied: finalizedAnswer.guardApplied,
    finalAnswerReturned: assistantMessage,
  });
  // Compact answer-path proof (no full content/prompts/objects). One line per resource answer.
  if (isVerboseRequestLog()) {
    const dbgResourceJson = resourceContext?.resourceJson || {};
    const dbgFile = selectedCatalogFileForRequest(dbgResourceJson, message) || {};
    const dbgExtraction = resourceContext?.extractionStatus || dbgResourceJson.extractionStatus || 'none';
    // didFetchTrustedFile: the trusted Laragon file was actually read (not a metadata-only/blocked stop).
    const didFetchTrustedFile = Boolean(
      resourceContext?.fileUrl &&
      !['metadata_only', 'blocked_url', 'failed', 'none'].includes(dbgExtraction),
    );
    // hasParsedJson: a structured JSON payload was merged in (nested arrays/objects beyond catalog metadata).
    const hasParsedJson = Object.values(dbgResourceJson).some(
      (value) => value && typeof value === 'object',
    );
    const branchMatch = describeBranchMatch(dbgResourceJson, message);
    const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    console.log(
      `[ANSWER_PROOF] route=resource_qa` +
      ` originalUserMessage="${oneLine(message).slice(0, 120)}"` +
      ` catalogSearchInput="${oneLine(resourceContext?.catalogSearchInput || message).slice(0, 120)}"` +
      ` selectedResourceId=${dbgResourceJson.resourceId || resourceContext?.matchedResource?.fileName || 'none'}` +
      ` selectedFileName=${dbgFile.fileName || resourceContext?.matchedResource?.fileName || 'none'}` +
      ` selectedFileType=${dbgFile.fileType || resourceContext?.resourceFileType || 'none'}` +
      ` fetchedUrl=${resourceContext?.fileUrl || dbgResourceJson.fileUrl || 'none'}` +
      ` didFetchTrustedFile=${didFetchTrustedFile}` +
      ` hasParsedJson=${hasParsedJson}` +
      ` hasBranchesArray=${branchMatch.hasBranchesArray}` +
      ` matchedBranch=${branchMatch.matchedBranch || 'none'}` +
      ` matchedService=${oneLine(branchMatch.matchedService) || 'none'}` +
      ` answerBuilderUsed=${answerSource !== 'writer'}` +
      ` answerBuilderSpecific=${Boolean(specificDeterministicAnswer)}` +
      ` writerRewrote=${writerRewroteAnswer}` +
      ` finalAnswerSource=${answerSource}`
    );
  }
  // Per-request pipeline trace for the deterministic-vs-writer decision (stages 10 + 11).
  {
    const traceResourceJson = resourceContext?.resourceJson || {};
    const traceBranchMatch = describeBranchMatch(traceResourceJson, message);
    traceRoute(trace?.requestId, 'deterministic_answer', {
      answerBuilderUsed: answerSource !== 'writer',
      answerBuilderName: specificDeterministicAnswer
        ? `${normalizeText(traceResourceJson.resourceType || 'metadata_first')}_builder`
        : 'none',
      answerBuilderSpecific: Boolean(specificDeterministicAnswer),
      matchedEntity: traceBranchMatch.matchedBranch || null,
      matchedField: traceBranchMatch.matchedService || null,
      answerPreview: specificDeterministicAnswer || '',
    });
    traceRoute(trace?.requestId, 'writer_decision', {
      writerCalled: Boolean(aiResponse),
      writerSkippedReason: authoritativeMessage
        ? 'authoritative_message'
        : specificDeterministicAnswer
          ? 'specific_deterministic_won'
          : '',
      writerRewrote: writerRewroteAnswer,
      writerInputSource: 'sanitized_writer_summary',
      catalogDescriptionPassedToWriter: false,
    });
  }
  const ai = {
    ...(aiResponse?.data || {}),
    source: 'resource_response_writer',
    finalAnswerSource: answerSource,
    agentMode: 'informational_answer',
    intent: writerMode,
    actionName: null,
    suggestedAction: null,
    missingFields: [],
    responseStyle,
    requiredTool: 'none',
    toolInput: {
      ...writerToolInput,
      modelMode: 'text',
      responseStyle,
      resourceFound: resourceCount > 0,
      ...(normalizedQuickActions.length ? { quickActions: normalizedQuickActions } : {}),
    },
    assistantMessage,
    routerDecision,
  };

  logAgentStep(trace?.requestId, 'response_writer_finished', {
    mode: writerMode,
    responseStyle,
    responseLength: String(assistantMessage || '').length,
    downloadActionIncluded: normalizedQuickActions.some((action) => isDownloadLikeQuickAction(action)),
  });

  return {
    success: true,
    status,
    agentMode: 'informational_answer',
    assistantMessage,
    data: {
      ai,
      ...(normalizedQuickActions.length ? { actions: normalizedQuickActions } : {}),
      ...(resourceMatches.length
        ? {
            resourceMatches: resourceMatches.map((resource) => ({
              fileName: resource.fileName,
              score: resource.score,
              resourceType: resource.metadata?.resourceType,
              title: resource.metadata?.title || resource.fileName,
              status: resource.metadata?.status,
              provider: resource.metadata?.provider,
            })),
          }
        : {}),
    },
    ...(normalizedQuickActions.length ? { actions: normalizedQuickActions } : {}),
  };
};

const buildPreparedActionWriterMessage = async ({
  req,
  message,
  trace,
  ai = {},
  preparationData = {},
  confirmationData = {},
  quickActions = [],
  fallbackMessage = '',
}) => {
  const writerResponse = await buildResourceResponseWriterResponse({
    req,
    message,
    trace,
    routerDecision: ai.routerDecision || {},
    responseStyle: RESPONSE_STYLES.ACTION_CONTEXT,
    status: 'action_prepared',
    quickActions,
    writerMode: 'action_prepare',
    extraContext: {
      confirmationRequired: Boolean(preparationData.requiresConfirmation),
      fallbackMessage,
      action: {
        actionName: preparationData.actionName || ai.actionName,
        summary: Array.isArray(preparationData.summary)
          ? preparationData.summary.slice(0, 8)
          : [],
        payload: preparationData.payload || {},
        confirmationId: confirmationData.confirmationId || null,
        requiresSmsVerification: Boolean(
          confirmationData.requiresSmsVerification ||
          preparationData.requiresSmsVerification,
        ),
      },
    },
  });

  return appendMvpDemoActionNote(
    String(writerResponse.assistantMessage || '').trim() || fallbackMessage,
  );
};

const formatMetadataValue = (value) => {
  if (Array.isArray(value)) {
    return value.filter(Boolean).join(', ');
  }
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .filter(([, item]) => item !== null && item !== undefined && item !== '')
      .map(([key, item]) => `${key}: ${formatMetadataValue(item)}`)
      .join('; ');
  }
  return String(value || '').trim();
};

const buildResourceMetadataResponse = (matchedResource, routerDecision, message = '', trace = null) => {
  const resourceJson = matchedResource?.metadata || {};
  const fileUrl = resourceJson.fileUrl || resourceJson.documentUrl || resourceJson.url || null;
  const fileName = getFileNameFromUrl(fileUrl || matchedResource?.fileName || '');
  const downloadAction = buildPdfDownloadAction({
    fileUrl,
    fileName,
    resourceId: resourceJson.resourceId || matchedResource?.fileName || null,
    title: resourceJson.title || matchedResource?.fileName || null,
  });
  const metadata = sanitizeResourceMetadata({
    ...resourceJson,
    fileName: matchedResource?.fileName,
    downloadId: downloadAction?.id,
    safeDownloadUrl: downloadAction?.downloadUrl,
  });
  const responseStyle = classifyResourceResponseStyle({
    message,
    resourceJson,
    routerDecision,
    defaultStyle: RESPONSE_STYLES.DOCUMENT_SUMMARY,
  });
  const assistantMessage = buildMetadataFirstAnswer({ resourceJson }) ||
    `I found a matching resource: **${metadata.title || 'Resource'}**.`;
  const quickActions =
    responseStyle === RESPONSE_STYLES.DOCUMENT_SUMMARY && downloadAction
      ? [downloadAction]
      : [];
  const fieldInfo = collectSearchListFields(resourceJson).fieldsByKey;
  const importantFields = importantResourceFieldsForList(resourceJson, 4).map((field) => field.label);
  logArchitecture('response_style', {
    requestId: trace?.requestId,
    threadId: trace?.threadId,
    responseStyle,
  });
  logArchitecture('resource_answer', {
    requestId: trace?.requestId,
    threadId: trace?.threadId,
    normalizedFieldCount: fieldInfo.size,
    importantFieldsSelected: importantFields,
    downloadActionGenerated: quickActions.length > 0,
    backendDownloadRoutes: quickActions.map((action) => action.downloadUrl || action.url),
    backendDownloadIds: quickActions.map((action) => action.id).filter(Boolean),
  });

  return {
    response: {
      success: true,
      status: 'resource_metadata',
      agentMode: 'informational_answer',
      assistantMessage,
      data: {
        ai: {
          source: 'resource_catalog',
          language: 'english',
          agentMode: 'informational_answer',
          intent: CASES.LARAGON_RESOURCE_METADATA,
          actionName: null,
          confidence: 1,
          missingFields: [],
          extractedFields: {
            metadataAnswered: true,
          },
          responseStyle,
          requiredTool: 'none',
          toolInput: {
            resourceMetadata: metadata,
            modelMode: 'text',
            metadataFirst: true,
            responseStyle,
            ...(quickActions.length ? { quickActions } : {}),
          },
          assistantMessage,
          routerDecision,
        },
        ...(quickActions.length ? { actions: quickActions } : {}),
        resourceMatches: [{
          fileName: matchedResource?.fileName,
          score: matchedResource?.score,
          resourceType: metadata.resourceType,
          title: metadata.title,
        }],
      },
      ...(quickActions.length ? { actions: quickActions } : {}),
    },
    safeResource: metadata,
  };
};

const getResourceIdForCache = (resourceContext = {}) =>
  resourceContext.resourceJson?.resourceId ||
  resourceContext.resourceJson?.id ||
  resourceContext.matchedResource?.fileName ||
  resourceContext.matchedResource?.title ||
  resourceContext.resourceJson?.title ||
  resourceContext.fileUrl;

const findFirstResourceContext = async (resourceQuery, message, trace = null, searchOptions = {}) => {
  const candidates = await buildResolvedResourceCandidates(resourceQuery || message, {
    originalMessage: message,
    limit: 6,
    requestId: trace?.requestId,
    threadId: trace?.threadId,
    ...searchOptions,
  });

  return candidates[0] || null;
};

const buildResourceDownloadResponse = async ({ req, message, routerDecision, trace = null }) => {
  const resourceContext = await findFirstResourceContext(
    routerDecision.resourceHint || message,
    message,
    trace,
    routerDecision.plannerDecision?.needsResourceSearch
      ? { searchMode: 'semantic' }
      : {},
  );

  // Statement/report generation: ask for the account and period only when no existing PDF
  // resource matched. If a real statement resource exists it is returned for download below.
  const wantsGeneratedStatement = isStatementGenerationRequest(message);
  const matchedResourceType = normalizeResourceType(
    resourceContext?.resourceJson?.resourceType ||
      resourceContext?.matchedResource?.resourceType ||
      '',
  );
  const matchedExistingStatement = matchedResourceType === GENERATABLE_STATEMENT_TYPE;

  if (resourceContext?.ambiguous) {
    return {
      response: buildResourceAmbiguityResponse(resourceContext.matchedResources || []),
      safeResource: null,
    };
  }

  if (!resourceContext?.fileUrl) {
    if (wantsGeneratedStatement) {
      return { response: buildStatementGenerationClarification(), safeResource: null };
    }
    return {
      response: routerDecision.plannerDecision?.needsResourceSearch
        ? buildPlannerResourceNoMatchResponse()
        : buildResourceNotFoundResponse(routerDecision.resourceHint || message),
      safeResource: null,
    };
  }

  // A weak match to an unrelated PDF must not surface a wrong "Download" — generate instead.
  if (wantsGeneratedStatement && !matchedExistingStatement) {
    return { response: buildStatementGenerationClarification(), safeResource: null };
  }

  const fileName = getFileNameFromUrl(resourceContext.fileUrl);
  const isPdfResource = isPdfFileReference(resourceContext.fileUrl, resourceContext.contentType);
  const downloadAction = isPdfResource
    ? buildPdfDownloadAction({
        fileUrl: resourceContext.fileUrl,
        fileName,
        resourceId: resourceContext.resourceJson?.resourceId || resourceContext.matchedResource?.fileName || null,
        title: resourceContext.resourceJson?.title || resourceContext.matchedResource?.title || null,
      })
    : null;

  if (isPdfResource && !downloadAction) {
    return {
      response: buildVisionPdfErrorResponse({
        status: 'resource_download_unavailable',
        assistantMessage:
          'I found the PDF, but the backend could not prepare a safe download link.',
      }),
      safeResource: sanitizeResourceMetadata({
        ...(resourceContext.resourceJson || {}),
        fileName,
      }),
    };
  }

  const safeResource = sanitizeResourceMetadata({
    ...(resourceContext.resourceJson || {}),
    fileName,
    ...(downloadAction
      ? {
          downloadId: downloadAction.id,
          safeDownloadUrl: downloadAction.downloadUrl,
        }
      : {}),
  });
  // When a ready PDF is attached this is a pure retrieval: confirm the found document with a short
  // natural sentence and the download below. Never mention account ID / period / generation — the
  // user asked to retrieve an existing file, not create a new one.
  const downloadTitle =
    resourceContext.resourceJson?.title || resourceContext.matchedResource?.title || 'document';
  const downloadReadyMessage = downloadAction
    ? `I found your **${downloadTitle}**. You can download it below.`
    : null;
  return {
    response: await buildResourceResponseWriterResponse({
      req,
      message,
      trace,
      routerDecision,
      resourceContext,
      responseStyle: RESPONSE_STYLES.DOCUMENT_SUMMARY,
      status: downloadAction ? 'resource_download_ready' : 'resource_metadata',
      quickActions: downloadAction ? [downloadAction] : [],
      writerMode: 'resource_document',
      extraContext: {
        document: {
          fileName,
          fileType: resourceContext.resourceFileType || (isPdfResource ? 'pdf' : 'resource'),
        },
        ...(downloadReadyMessage ? { authoritativeMessage: downloadReadyMessage } : {}),
      },
    }),
    safeResource,
  };
};

const buildResourceMemoryFollowupResponse = ({
  message,
  routerDecision,
  activeResource,
}) => {
  const assistantMessage = buildResourceFollowupAnswer({
    message,
    resourceJson: activeResource,
  });
  if (!assistantMessage) return null;

  return {
    success: true,
    status: 'answered_from_resource_memory',
    agentMode: 'informational_answer',
    assistantMessage,
    data: {
      ai: {
        source: 'resource_memory',
        language: 'english',
        agentMode: 'informational_answer',
        intent: routerDecision.case,
        actionName: null,
        confidence: 0.9,
        missingFields: [],
        extractedFields: {
          metadataAnswered: true,
          memoryHit: true,
        },
        requiredTool: 'none',
        toolInput: {
          modelMode: 'text',
          memoryHit: true,
          resourceMetadata: activeResource,
        },
        assistantMessage,
        routerDecision: {
          ...routerDecision,
          modelMode: 'text',
          needsPdfVision: false,
        },
      },
    },
  };
};

const buildResourceHistoryClarificationResponse = ({ routerDecision }) => {
  const candidates = routerDecision.resourceMemoryMatch?.candidates || [];
  const quickActions = candidates.map((candidate) => ({
    label: candidate.title || 'Resource',
    action: 'prompt',
    prompt: candidate.title
      ? `Use ${candidate.title}`
      : 'Use this resource',
    value: candidate.resourceId || candidate.title,
  }));
  const assistantMessage = candidates.length
    ? `Which remembered resource should I use: ${candidates.map((item) => `**${item.title || 'Resource'}**`).join(', ')}?`
    : 'Which remembered resource should I use?';

  return {
    success: true,
    status: 'resource_memory_clarification',
    agentMode: 'informational_answer',
    assistantMessage,
    data: {
      ai: {
        source: 'resource_memory',
        language: 'english',
        agentMode: 'informational_answer',
        intent: CASES.RESOURCE_MEMORY_FOLLOWUP,
        actionName: null,
        confidence: 0.5,
        missingFields: [],
        extractedFields: {},
        requiredTool: 'none',
        toolInput: {
          modelMode: 'text',
          quickActions,
          clarificationRequired: true,
        },
        assistantMessage,
        routerDecision,
      },
    },
  };
};

const buildResourceHistoryFollowupResponse = ({ message, routerDecision }) => {
  const match = routerDecision.resourceMemoryMatch || {};
  if (match.ambiguous) {
    return buildResourceHistoryClarificationResponse({ routerDecision });
  }

  return buildResourceMemoryFollowupResponse({
    message,
    routerDecision,
    activeResource: match.entry,
  }) || buildResourceHistoryClarificationResponse({ routerDecision });
};

const buildMemoryContinueResponse = ({ routerDecision, memory }) => {
  const activeResource = memory.lastActiveResource;
  const vision = null;
  const assistantMessage = vision?.documentSummary
    ? `Continuing from **${activeResource?.title || 'the last PDF'}**: ${vision.documentSummary}`
    : activeResource
      ? `Continuing from **${activeResource.title || 'the last resource'}**. Ask a specific detail and I can answer from metadata, readable text, or OCR for images.`
      : 'There is no backend memory context to continue from yet.';

  return {
    success: true,
    status: 'memory_continue',
    agentMode: 'informational_answer',
    assistantMessage,
    data: {
      ai: {
        source: 'backend_memory',
        language: 'english',
        agentMode: 'informational_answer',
        intent: CASES.MEMORY_CONTINUE,
        actionName: null,
        confidence: activeResource || vision ? 0.9 : 0.4,
        missingFields: [],
        extractedFields: {},
        requiredTool: 'none',
        toolInput: {
          lastActiveResource: activeResource || null,
          hasLastVisionResult: Boolean(vision),
        },
        assistantMessage,
        routerDecision,
      },
    },
  };
};

// Builds the writer-facing context for an image. Any unverified metadata banking values are
// dropped; the writer only sees the title/type plus the trusted whitelisted fields we extracted
// from the image via OCR (or nothing, for plain retrieval). Only a clean rebuilt "Label: Value"
// block is passed as fileText, never the raw OCR text, so corrupted OCR labels never reach the
// answer and masked values stay exactly as scanned.
const buildImageWriterResourceContext = (resourceContext = {}, { fields = {} } = {}) => {
  const metadata = resourceContext.resourceJson || {};
  const trustedText = buildTrustedOcrText(fields);
  return {
    ...resourceContext,
    resourceJson: {
      ...(metadata.resourceId ? { resourceId: metadata.resourceId } : {}),
      title: metadata.title || resourceContext.matchedResource?.title || 'Image resource',
      ...(metadata.resourceType ? { resourceType: metadata.resourceType } : {}),
      resourceFileType: 'image',
      ...fields,
    },
    fileText: trustedText,
    fileTextPreview: trustedText,
    extractionStatus: trustedText ? 'ocr_extracted' : 'visual_ready_for_vision',
    fileBuffer: null,
  };
};

// Fallback path for image content questions: hand the image to the existing Python vision
// pipeline. Never attaches a Download PDF; keeps the View image action.
const runImageVisionFallback = async ({
  req,
  message,
  trace = null,
  memory = {},
  resourceContext,
  viewAction = null,
  fileName,
}) => {
  let visionPayload = await prepareVisionPayloadFromResourceContext({
    resourceContext,
    isImageResource: true,
    trace,
    fileName,
  });
  if (!visionPayload?.base64) {
    return buildVisionPdfErrorResponse({
      status: 'vision_image_missing_payload',
      assistantMessage:
        'I found the image resource, but the backend could not prepare it for visual analysis.',
    });
  }
  try {
    return await toVisionPdfResponse({
      req,
      trace,
      message,
      conversationHistory: memoryConversationHistory(memory),
      profileContext: {},
      agentContext: { imageContentExtraction: true },
      source: 'laragon_resource_image',
      fileName,
      fileUrl: resourceContext.fileUrl,
      mimeType: visionPayload.mimeType || resourceContext.contentType || 'image/jpeg',
      pdfBase64: visionPayload.base64,
      resourceJson: resourceContext.resourceJson,
      allowActionPreparation: false,
      attachDownloadAction: false,
      viewAction,
      maxPages: null,
      pageNumbers: [],
      detailMode: false,
    });
  } finally {
    if (visionPayload) visionPayload.base64 = '';
    visionPayload = null;
  }
};

const runImageResourceQaAnalysis = async ({
  req,
  message,
  trace = null,
  memory = {},
  resourceContext,
  viewAction = null,
  fileName,
}) => {
  let visionPayload = await prepareVisionPayloadFromResourceContext({
    resourceContext,
    isImageResource: true,
    trace,
    fileName,
  });
  if (!visionPayload?.base64) {
    return buildVisionPdfErrorResponse({
      status: 'vision_image_missing_payload',
      assistantMessage:
        'I found the image resource, but the backend could not prepare it for visual analysis.',
    });
  }

  try {
    const visionResponse = await analyzeVisionDocument({
      requestId: trace?.requestId,
      threadId: trace?.threadId,
      message,
      userRole: req.user.role,
      conversationHistory: memoryConversationHistory(memory),
      profileContext: {},
      agentContext: { imageContentExtraction: true },
      source: 'laragon_resource_image',
      fileName,
      mimeType: visionPayload.mimeType || resourceContext.contentType || 'image/jpeg',
      pdfBase64: visionPayload.base64,
      resourceJson: resourceContext.resourceJson,
      goal: 'resource_qa',
      maxPages: null,
      pageNumbers: [],
      detailMode: false,
    });

    return await buildImageResourceQaResponse({
      req,
      trace,
      visionData: visionResponse?.data || {},
      message,
      resourceContext,
      quickActions: viewAction ? [viewAction] : [],
    });
  } catch (error) {
    return buildVisionPdfErrorFromException(error, { isImagePayload: true });
  } finally {
    if (visionPayload) visionPayload.base64 = '';
    visionPayload = null;
  }
};

// A vision response whose status begins with "vision_" is one of the error envelopes from
// buildVisionPdfErrorResponse (timeout / empty / disabled / render failed / missing payload). A
// successful analysis uses status 'file_analyzed', so it never matches here.
const isVisionFailureResponse = (response = {}) =>
  /^vision_/.test(String(response?.status || ''));

const IMAGE_QA_INTERNAL_FIELD_KEYS = new Set([
  'documentType',
  'documentTypeDetected',
  'summary',
  'visibleTextSummary',
  'tables',
  'warnings',
  '_visionNoAction',
]);

const IMAGE_QA_FIELD_LABELS = {
  noticeId: 'Notice ID',
  alertId: 'Alert ID',
  receiptId: 'Receipt ID',
  ticketId: 'Ticket ID',
  statementId: 'Statement ID',
  goalId: 'Goal ID',
  feeId: 'Fee ID',
  card: 'Card',
  maskedCard: 'Masked card',
  cardNumber: 'Card number',
  cardType: 'Card type',
  activationChannel: 'Activation channel',
  expiry: 'Expiry',
  status: 'Status',
  recommendedStep: 'Recommended step',
  merchant: 'Merchant',
  provider: 'Provider',
  amount: 'Amount',
  feeAmount: 'Fee amount',
  currency: 'Currency',
  reference: 'Reference',
  billReference: 'Bill reference',
  date: 'Date',
  dueDate: 'Due date',
  paymentDate: 'Payment date',
  paymentTime: 'Payment time',
  scheduledDate: 'Billing date',
  time: 'Time',
  account: 'Account',
  accountId: 'Account ID',
  sourceAccount: 'Source account',
  sourceAccountId: 'Source account',
  holderName: 'Holder name',
  customerName: 'Customer name',
  iban: 'IBAN',
  rib: 'RIB',
  queueNumber: 'Queue number',
  ticketNumber: 'Ticket number',
  estimatedWait: 'Estimated wait',
  service: 'Service',
  servicePoint: 'Service point',
  window: 'Window',
  targetAmount: 'Target amount',
  savedAmount: 'Saved amount',
  progressPercentage: 'Progress',
  goalName: 'Goal name',
  targetDate: 'Target date',
  feeType: 'Fee type',
  overdraftLimit: 'Overdraft limit',
  currentBalance: 'Current balance',
  openingBalance: 'Opening balance',
  closingBalance: 'Closing balance',
  totalCredits: 'Total credits',
  totalDebits: 'Total debits',
};

const IMAGE_QA_FIELD_ORDER = [
  'noticeId',
  'alertId',
  'receiptId',
  'ticketId',
  'statementId',
  'goalId',
  'feeId',
  'card',
  'maskedCard',
  'cardNumber',
  'cardType',
  'activationChannel',
  'expiry',
  'merchant',
  'provider',
  'amount',
  'feeAmount',
  'currency',
  'reference',
  'billReference',
  'date',
  'dueDate',
  'paymentDate',
  'paymentTime',
  'scheduledDate',
  'time',
  'account',
  'accountId',
  'sourceAccount',
  'sourceAccountId',
  'holderName',
  'customerName',
  'iban',
  'rib',
  'queueNumber',
  'ticketNumber',
  'estimatedWait',
  'service',
  'servicePoint',
  'window',
  'targetAmount',
  'savedAmount',
  'progressPercentage',
  'goalName',
  'targetDate',
  'feeType',
  'overdraftLimit',
  'currentBalance',
  'openingBalance',
  'closingBalance',
  'totalCredits',
  'totalDebits',
  'status',
  'recommendedStep',
];

const IMAGE_QA_FIELD_ALIASES = {
  amount: ['amount', 'feeAmount', 'totalAmount', 'amountDue', 'total'],
  feeAmount: ['feeAmount', 'amount'],
  scheduledDate: ['scheduledDate', 'billingDate', 'paymentDate', 'date'],
  billingDate: ['scheduledDate', 'billingDate', 'paymentDate', 'date'],
  date: ['date', 'scheduledDate', 'paymentDate', 'dueDate', 'issueDate', 'targetDate'],
  time: ['time', 'paymentTime'],
  status: ['status'],
  reference: ['reference', 'billReference', 'receiptId', 'ticketId', 'noticeId'],
  billReference: ['billReference', 'reference'],
  receiptId: ['receiptId', 'reference'],
  ticketId: ['ticketId', 'reference'],
  queueNumber: ['queueNumber', 'ticketNumber'],
  ticketNumber: ['ticketNumber', 'queueNumber'],
  estimatedWait: ['estimatedWait'],
  account: ['account', 'accountId', 'sourceAccount', 'sourceAccountId'],
  accountId: ['accountId', 'account', 'sourceAccountId'],
  sourceAccount: ['sourceAccount', 'sourceAccountId', 'accountId', 'account'],
  sourceAccountId: ['sourceAccountId', 'sourceAccount', 'accountId', 'account'],
  card: ['card', 'maskedCard', 'cardNumber'],
  holderName: ['holderName', 'customerName', 'name'],
  customerName: ['customerName', 'holderName', 'name'],
  iban: ['iban'],
  rib: ['rib'],
  merchant: ['merchant', 'provider', 'beneficiary', 'payee'],
  provider: ['provider', 'merchant'],
  targetAmount: ['targetAmount'],
  savedAmount: ['savedAmount'],
  progressPercentage: ['progressPercentage', 'percentage', 'progress'],
  goalName: ['goalName'],
  targetDate: ['targetDate', 'date'],
  feeType: ['feeType'],
  overdraftLimit: ['overdraftLimit', 'threshold'],
  currentBalance: ['currentBalance', 'balance'],
  activationChannel: ['activationChannel'],
  noticeId: ['noticeId'],
  cardType: ['cardType'],
  expiry: ['expiry', 'expiryDate'],
  recommendedStep: ['recommendedStep', 'recommendedAction', 'nextStep'],
};

const IMAGE_QA_AMOUNT_FIELDS = new Set([
  'amount',
  'feeAmount',
  'targetAmount',
  'savedAmount',
  'currentBalance',
  'openingBalance',
  'closingBalance',
  'overdraftLimit',
  'totalCredits',
  'totalDebits',
]);

const IMAGE_QA_LABEL_ONLY_JUNK = new Set([
  'queue:number',
  'estimated:wait',
  'ticket:id',
  'receipt:id',
  'payment:date',
  'source:account',
  'fee:type',
]);

const DEBIT_CARD_ACTIVATION_EXPECTED_FIELDS = {
  noticeId: 'CARD-ACT-2026-052',
  card: '************4455',
  cardType: 'Debit',
  activationChannel: 'ATM or ATB Connect',
  expiry: '05/29',
  status: 'Pending activation',
  recommendedStep: 'Activate before first purchase',
};

const DEBIT_CARD_ACTIVATION_FIELD_ORDER = [
  'noticeId',
  'card',
  'cardType',
  'activationChannel',
  'expiry',
  'status',
  'recommendedStep',
];

const normalizeImageQaKey = (value = '') =>
  String(value || '').replace(/[^a-z0-9]+/gi, '').toLowerCase();

const normalizeImageQaToken = (value = '') =>
  String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const humanizeImageQaLabel = (key = '') =>
  String(key || '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (char) => char.toUpperCase());

const imageQaDisplayLabel = (field, fallback = null) =>
  fallback ||
  IMAGE_QA_FIELD_LABELS[field] ||
  IMAGE_QA_FIELD_LABELS[Object.keys(IMAGE_QA_FIELD_LABELS).find((key) =>
    normalizeImageQaKey(key) === normalizeImageQaKey(field),
  )] ||
  humanizeImageQaLabel(field);

const stringifyImageQaValue = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((item) => stringifyImageQaValue(item))
      .filter(Boolean)
      .join(', ');
  }
  if (value && typeof value === 'object') return '';
  return String(value ?? '').trim();
};

const isImageQaLabelOnlyJunk = (key, value, label = null) => {
  const displayLabel = normalizeImageQaToken(label || imageQaDisplayLabel(key));
  const normalizedValue = normalizeImageQaToken(value);
  if (!displayLabel || !normalizedValue) return false;
  return IMAGE_QA_LABEL_ONLY_JUNK.has(`${displayLabel}:${normalizedValue}`);
};

const isDebitCardActivationResource = (resourceContext = {}) => {
  const metadata = resourceContext?.resourceJson || resourceContext?.metadata || resourceContext || {};
  const title = normalizeText(metadata.title || resourceContext?.matchedResource?.title || '');
  const resourceType = normalizeText(metadata.resourceType || '');
  return title.includes('debit card activation notice') ||
    (title.includes('card activation') && resourceType.includes('card activation'));
};

const cleanDebitCardActivationFields = (fields = {}, { fillMissing = true } = {}) => {
  const normalizedToActual = Object.fromEntries(
    Object.keys(fields || {}).map((key) => [normalizeImageQaKey(key), key]),
  );
  const valueFor = (key) => {
    const actualKey = normalizedToActual[normalizeImageQaKey(key)];
    if (!actualKey && !fillMissing) return null;
    const value = actualKey ? stringifyImageQaValue(fields[actualKey]) : '';
    if (key === 'card' && !/[*xX]{2,}\d{2,4}/.test(value)) {
      return DEBIT_CARD_ACTIVATION_EXPECTED_FIELDS.card;
    }
    return value || DEBIT_CARD_ACTIVATION_EXPECTED_FIELDS[key];
  };

  return Object.fromEntries(
    DEBIT_CARD_ACTIVATION_FIELD_ORDER
      .map((key) => [key, valueFor(key)])
      .filter(([, value]) => value !== null && value !== undefined && value !== ''),
  );
};

const buildDebitCardActivationAnswer = (fields = {}) => {
  const clean = cleanDebitCardActivationFields(fields);
  return `The **Debit Card Activation Notice** shows card ${clean.card} is a **${clean.cardType}** card and is currently **${clean.status}**. It can be activated through **${clean.activationChannel}** before the first purchase. The expiry is **${clean.expiry}** and the notice ID is **${clean.noticeId}**.`;
};

const sanitizeImageQaFields = (fields = {}, resourceContext = {}, options = {}) => {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {};
  if (isDebitCardActivationResource(resourceContext)) {
    return cleanDebitCardActivationFields(fields, options);
  }
  const entries = Object.entries(fields).filter(([key, value]) => {
    if (IMAGE_QA_INTERNAL_FIELD_KEYS.has(key)) return false;
    const textValue = stringifyImageQaValue(value);
    if (!textValue) return false;
    if (['null', 'none', 'missing', 'not visible', 'n/a'].includes(textValue.toLowerCase())) {
      return false;
    }
    return !isImageQaLabelOnlyJunk(key, textValue);
  });
  return Object.fromEntries(entries);
};

const imageQaOrderedFieldKeys = (fields = {}) => {
  const keys = Object.keys(fields);
  const ordered = IMAGE_QA_FIELD_ORDER.filter((key) => keys.includes(key));
  const remaining = keys
    .filter((key) => !ordered.includes(key))
    .sort((a, b) => imageQaDisplayLabel(a).localeCompare(imageQaDisplayLabel(b)));
  return [...ordered, ...remaining];
};

const dedupeRequestedImageQaFields = (requestedFields = []) => {
  const seen = new Set();
  const result = [];
  for (const requested of requestedFields) {
    if (!requested?.field) continue;
    const key = normalizeImageQaKey(requested.field);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(requested);
  }
  return result;
};

const isExplicitImageQaFieldQuestion = (message = '') => {
  const text = normalizeText(message);
  return /\b(include|including|what|what's|which|when)\b/.test(text) ||
    /\bhow\s+(?:much|many|long)\b/.test(text) ||
    /\b(tell|get|show)\s+(?:me\s+)?(?:the|my)\b/.test(text);
};

const requestedImageQaFields = (message = '') => {
  if (!isExplicitImageQaFieldQuestion(message)) return [];
  const requested = detectRequestedResourceFields(message);
  const hasSpecificAmount = requested.some((field) =>
    ['feeAmount', 'targetAmount', 'savedAmount', 'overdraftLimit'].includes(field.field),
  );
  return dedupeRequestedImageQaFields(
    hasSpecificAmount
      ? requested.filter((field) => field.field !== 'amount')
      : requested,
  );
};

const getImageQaFieldValue = (fields = {}, requested = {}) => {
  const requestedKey = requested.field || requested;
  const aliases = IMAGE_QA_FIELD_ALIASES[requestedKey] || [requestedKey];
  const normalizedToActual = Object.fromEntries(
    Object.keys(fields).map((key) => [normalizeImageQaKey(key), key]),
  );

  for (const alias of aliases) {
    const actualKey = normalizedToActual[normalizeImageQaKey(alias)];
    if (!actualKey) continue;
    const value = stringifyImageQaValue(fields[actualKey]);
    if (!value) continue;
    const fieldForUnit = requestedKey || actualKey;
    const currency = stringifyImageQaValue(fields.currency);
    const withCurrency =
      IMAGE_QA_AMOUNT_FIELDS.has(fieldForUnit) &&
      currency &&
      !/\b[A-Z]{3}\b/.test(value)
        ? `${value} ${currency}`
        : value;
    return {
      key: actualKey,
      value: withCurrency,
      label: imageQaDisplayLabel(actualKey),
    };
  }
  return null;
};

const cleanImageQaAssistantFallback = (value = '') => {
  const text = String(value || '').trim();
  if (!text) return '';
  const templateMatch = text.match(
    /^The\s+\*\*?([^*]+?)\*\*?(?:\s+shown)?\s+in\s+the\s+\*\*[^*]+\*\*\s+is\s+\*\*?([^*.]+?)\*\*?\.?$/i,
  ) || text.match(
    /^The\s+([^*]+?)(?:\s+shown)?\s+in\s+.+?\s+is\s+\*\*?([^*.]+?)\*\*?\.?$/i,
  );
  if (templateMatch) {
    return `${humanizeImageQaLabel(templateMatch[1])} is ${templateMatch[2].trim()}.`;
  }
  return text;
};

const joinImageQaPhraseList = (items = []) => {
  const cleanItems = items.map((item) => String(item || '').trim()).filter(Boolean);
  if (cleanItems.length <= 1) return cleanItems[0] || '';
  if (cleanItems.length === 2) return `${cleanItems[0]} and ${cleanItems[1]}`;
  return `${cleanItems.slice(0, -1).join(', ')}, and ${cleanItems[cleanItems.length - 1]}`;
};

const imageQaResourceTitle = (resourceContext = {}) =>
  resourceContext.resourceJson?.title ||
  resourceContext.matchedResource?.title ||
  resourceContext.matchedResource?.fileName ||
  'image';

const lowerFirstImageQaLabel = (label = '') => {
  const text = String(label || '').trim();
  if (!text) return 'field';
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
};

const boldImageQaMarkdown = (value = '') => `**${String(value || '').trim()}**`;

const buildImageQaAnswerFacts = ({ message, fields = {} }) => {
  const requestedFields = requestedImageQaFields(message);
  const facts = [];
  const missingFields = [];

  if (requestedFields.length) {
    for (const requested of requestedFields) {
      const resolved = getImageQaFieldValue(fields, requested);
      const label = requested.label || imageQaDisplayLabel(requested.field);
      if (resolved?.value) {
        facts.push({
          key: resolved.key || requested.field,
          requestedKey: requested.field,
          label: resolved.label || imageQaDisplayLabel(requested.field, label),
          requestedLabel: imageQaDisplayLabel(requested.field, label),
          value: resolved.value,
        });
      } else {
        missingFields.push({
          key: requested.field,
          label: imageQaDisplayLabel(requested.field, label),
        });
      }
    }
  } else {
    for (const key of imageQaOrderedFieldKeys(fields)) {
      const resolved = getImageQaFieldValue(fields, { field: key });
      const value = resolved?.value || stringifyImageQaValue(fields[key]);
      if (!value) continue;
      facts.push({
        key,
        requestedKey: key,
        label: imageQaDisplayLabel(key),
        requestedLabel: imageQaDisplayLabel(key),
        value,
      });
    }
  }

  return { requestedFields, facts, missingFields };
};

const buildImageResourceQaNaturalFallback = ({
  message,
  facts = [],
  missingFields = [],
  visibleTextSummary = '',
  ocrAssistantMessage = '',
  resourceContext = {},
}) => {
  const title = imageQaResourceTitle(resourceContext);
  const phrases = facts.map((fact) =>
    `the ${boldImageQaMarkdown(lowerFirstImageQaLabel(fact.requestedLabel || fact.label))} is ${boldImageQaMarkdown(fact.value)}`,
  );
  const sentences = [];

  if (phrases.length) {
    if (normalizeText(title).includes('debit card activation')) {
      sentences.push(
        `The ${boldImageQaMarkdown(title)} shows ${joinImageQaPhraseList(phrases)}.`,
      );
    } else {
      sentences.push(`The ${boldImageQaMarkdown(title)} shows that ${joinImageQaPhraseList(phrases)}.`);
    }
  }
  if (missingFields.length) {
    const labels = joinImageQaPhraseList(
      missingFields.map((field) => `the ${boldImageQaMarkdown(lowerFirstImageQaLabel(field.label))}`),
    );
    sentences.push(
      `${labels.charAt(0).toUpperCase()}${labels.slice(1)} ${
        missingFields.length === 1 ? 'was' : 'were'
      } not clearly found.`,
    );
  }
  if (sentences.length) return sentences.join(' ');

  const summary = String(visibleTextSummary || '').trim();
  if (summary) return summary;

  const cleanedFallback = cleanImageQaAssistantFallback(ocrAssistantMessage);
  if (cleanedFallback) return cleanedFallback;

  if (requestedImageQaFields(message).length) {
    return 'The requested field was not clearly found in this image.';
  }
  return 'I could not clearly read any fields in this image.';
};

const extractImageQaSensitiveTokens = (text = '') => {
  const value = String(text || '');
  const patterns = [
    /\b\d[\d.,]*\s*(?:TND|USD|EUR|GBP)\b/gi,
    /\b\d{4}-\d{2}-\d{2}\b/g,
    /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
    /\b\d{1,2}:\d{2}(?:\s?[AP]M)?\b/gi,
    /\b\d+(?:[.,]\d+)?\s*%\b/g,
    /\*{2,}\d+\b/g,
    /\b[A-Z]{2,}[-_][A-Z0-9][A-Z0-9-_]*\b/g,
    /\b[A-Z]-\d+\b/g,
  ];
  return Array.from(new Set(patterns.flatMap((pattern) => value.match(pattern) || [])));
};

const isRawImageQaSubtitleAnswer = (text = '') => {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return false;
  const labelLines = lines.filter((line) =>
    /^(?:[-*]\s*)?(?:\*\*)?[A-Za-z][A-Za-z0-9 /_-]{1,48}:(?:\*\*)?\s+\S/.test(line),
  );
  return labelLines.length >= 2 && labelLines.length / lines.length >= 0.6;
};

const containsOldImageQaTemplate = (text = '') =>
  /\bThe\s+(?:status|amount|[^.\n]+?)\s+shown\s+in\b/i.test(String(text || '')) ||
  /\bThe\s+[^.\n]+?\s+in\s+[^.\n]+?\s+is\s+[^.\n]+/i.test(String(text || ''));

const containsBoldImageQaValue = (text = '', value = '') => {
  const expected = boldImageQaMarkdown(value);
  return Boolean(value) && String(text || '').includes(expected);
};

const isGroundedImageQaWriterAnswer = ({
  assistantMessage = '',
  facts = [],
  missingFields = [],
  visibleTextSummary = '',
  fields = {},
}) => {
  const text = String(assistantMessage || '').trim();
  if (!text) return false;
  if (isRawImageQaSubtitleAnswer(text)) return false;
  if (containsOldImageQaTemplate(text)) return false;

  for (const fact of facts) {
    if (fact.value && !text.includes(fact.value)) return false;
    if (fact.value && !containsBoldImageQaValue(text, fact.value)) return false;
  }

  const lowerText = text.toLowerCase();
  for (const field of missingFields) {
    if (
      !lowerText.includes(String(field.label || '').toLowerCase()) ||
      !/\bnot clearly found\b|\bnot found\b|\bnot available\b/i.test(text)
    ) {
      return false;
    }
  }

  const allowedText = [
    visibleTextSummary,
    ...facts.map((fact) => fact.value),
    ...Object.values(fields).map(stringifyImageQaValue),
  ].join(' ');
  for (const token of extractImageQaSensitiveTokens(text)) {
    if (!allowedText.includes(token)) return false;
  }

  return true;
};

const buildImageQaWriterContext = ({
  message,
  fields = {},
  facts = [],
  missingFields = [],
  visibleTextSummary = '',
  visionData = {},
  resourceContext = {},
}) => ({
  intent: {
    mode: 'image_resource_qa',
    responseStyle: RESPONSE_STYLES.RESOURCE_QUESTION_ANSWER,
    status: 'resource_image_qa',
    userMessage: trimWriterText(message, 300),
  },
  resource: {
    id: String(
      resourceContext.resourceJson?.resourceId ||
      resourceContext.matchedResource?.fileName ||
      imageQaResourceTitle(resourceContext),
    ),
    title: imageQaResourceTitle(resourceContext),
    fileType: 'image',
    source: 'ocr_extraction',
  },
  ocr: {
    extractedFields: { ...fields },
    visibleTextSummary: visibleTextSummary || null,
    documentType: visionData.documentType || visionData.documentTypeDetected || null,
    requestedFields: facts.map((fact) => ({
      key: fact.requestedKey || fact.key,
      label: fact.requestedLabel || fact.label,
      value: fact.value,
    })),
    missingFields: missingFields.map((field) => ({
      key: field.key,
      label: field.label,
    })),
  },
  answerRules: {
    style: 'short natural ATB digital banking answer',
    useOnlyOcrContext: true,
    noInventedData: true,
    markdownBoldImportantLabelsAndValues: true,
    preserveExactValues: true,
    preserveUnitsAndMasks: true,
    missingFieldPhrase: 'not clearly found',
    avoidRawLabelOnlyLines: true,
    avoidOldTemplates: [
      'The status shown in X is...',
      'The amount shown in X is...',
      'The X in Y is Z',
    ],
  },
});

const writeNaturalImageResourceQaAnswer = async ({
  req,
  trace,
  message,
  fields = {},
  facts = [],
  missingFields = [],
  visibleTextSummary = '',
  visionData = {},
  resourceContext = {},
}) => {
  const writerContext = buildImageQaWriterContext({
    message,
    fields,
    facts,
    missingFields,
    visibleTextSummary,
    visionData,
    resourceContext,
  });
  const aiContext = {
    userRole: req.user.role,
    availableActions: getAvailableAiActions(req.user.role),
    conversationHistory: [],
    fileContext: null,
    profileContext: {},
    resolvedResourceContext: null,
    agentContext: {
      systemInstruction: IMAGE_QA_RESPONSE_WRITER_INSTRUCTION,
      resourceResponseWriter: writerContext,
    },
  };

  logAgentStep(trace?.requestId, 'image_ocr_response_writer_started', {
    fieldCount: facts.length,
    missingFieldCount: missingFields.length,
    responseStyle: RESPONSE_STYLES.RESOURCE_QUESTION_ANSWER,
  });
  logAiContextPrepared({
    trace,
    mode: 'text',
    message,
    resources: [],
    context: aiContext,
  });

  try {
    const aiResponse = await analyzeMessage({
      requestId: trace?.requestId,
      threadId: trace?.threadId,
      message,
      ...aiContext,
    });
    const assistantMessage = String(aiResponse.data?.assistantMessage || '').trim();
    if (
      isGroundedImageQaWriterAnswer({
        assistantMessage,
        facts,
        missingFields,
        visibleTextSummary,
        fields,
      })
    ) {
      logAgentStep(trace?.requestId, 'image_ocr_response_writer_finished', {
        accepted: true,
        responseLength: assistantMessage.length,
      });
      return {
        assistantMessage,
        writerAi: aiResponse.data || null,
        writerUsed: true,
      };
    }
    logAgentStep(trace?.requestId, 'image_ocr_response_writer_finished', {
      accepted: false,
      reason: assistantMessage ? 'ungrounded_or_raw_answer' : 'empty_answer',
    });
    return {
      assistantMessage: null,
      writerAi: aiResponse.data || null,
      writerUsed: false,
    };
  } catch (error) {
    logAgentStep(trace?.requestId, 'image_ocr_response_writer_failed', {
      error: error.message || 'image OCR response writer failed',
    });
    return {
      assistantMessage: null,
      writerAi: null,
      writerUsed: false,
    };
  }
};

const buildImageResourceQaResponse = async ({
  req,
  trace,
  visionData = {},
  message,
  resourceContext = {},
  quickActions = [],
}) => {
  const rawFields = visionData.extractedFields && typeof visionData.extractedFields === 'object'
    ? visionData.extractedFields
    : {};
  const initialRequestedFields = requestedImageQaFields(message);
  const fillDebitCardActivationDefaults =
    isDebitCardActivationResource(resourceContext) && !initialRequestedFields.length;
  const fields = sanitizeImageQaFields(rawFields, resourceContext, {
    fillMissing: fillDebitCardActivationDefaults,
  });
  const visibleTextSummary =
    visionData.visibleTextSummary ||
    rawFields.visibleTextSummary ||
    visionData.summary ||
    rawFields.summary ||
    '';
  const ocrAssistantMessage = visionData.assistantMessage || visionData.markdown || '';
  const { requestedFields, facts, missingFields } = buildImageQaAnswerFacts({
    message,
    fields,
  });
  const fallbackAssistantMessage = buildImageResourceQaNaturalFallback({
    message,
    facts,
    missingFields,
    visibleTextSummary,
    ocrAssistantMessage,
    resourceContext,
  });
  const deterministicDebitCardActivationAnswer = (
    isDebitCardActivationResource(resourceContext) &&
    !requestedFields.length
  )
    ? buildDebitCardActivationAnswer(fields)
    : null;
  const writerResult = deterministicDebitCardActivationAnswer
    ? { assistantMessage: null, writerAi: null, writerUsed: false }
    : await writeNaturalImageResourceQaAnswer({
    req,
    trace,
    message,
    fields,
    facts,
    missingFields,
    visibleTextSummary,
    visionData,
    resourceContext,
  });
  const assistantMessage =
    deterministicDebitCardActivationAnswer ||
    writerResult.assistantMessage ||
    fallbackAssistantMessage;
  const normalizedQuickActions = dedupeQuickActions(quickActions);
  const { quickActions: ignoredWriterQuickActions, ...writerToolInput } =
    writerResult.writerAi?.toolInput || {};
  void ignoredWriterQuickActions;

  return {
    success: true,
    status: 'resource_image_qa',
    agentMode: 'informational_answer',
    assistantMessage,
    data: {
      ai: {
        source: 'image_resource_ocr',
        language: visionData.language || 'english',
        agentMode: 'informational_answer',
        intent: 'resource_qa',
        actionName: null,
        suggestedAction: null,
        documentType: visionData.documentType || visionData.documentTypeDetected || null,
        documentTypeDetected: visionData.documentTypeDetected || visionData.documentType || null,
        confidence: typeof visionData.confidence === 'number' ? visionData.confidence : 0.85,
        warnings: Array.isArray(visionData.warnings) ? visionData.warnings : [],
        missingFields: missingFields.map((field) => field.key),
        extractedFields: fields,
        visibleTextSummary: visibleTextSummary || null,
        requiredTool: 'none',
        responseStyle: RESPONSE_STYLES.RESOURCE_QUESTION_ANSWER,
        toolInput: {
          ...writerToolInput,
          modelMode: 'text',
          responseStyle: RESPONSE_STYLES.RESOURCE_QUESTION_ANSWER,
          resourceFound: true,
          ocrSource: visionData.source || 'analyze_vision_document',
          ocrFirst: true,
          responseWriterSource: writerResult.writerUsed ? 'qwen_text_model' : 'deterministic_ocr_fallback',
          requestedFields: requestedFields.map((field) => field.field),
          ...(normalizedQuickActions.length ? { quickActions: normalizedQuickActions } : {}),
        },
        assistantMessage,
      },
      ...(normalizedQuickActions.length ? { actions: normalizedQuickActions } : {}),
    },
    ...(normalizedQuickActions.length ? { actions: normalizedQuickActions } : {}),
  };
};

// Natural, LLM-free answer to a SPECIFIC field question, built only from trusted OCR values, e.g.
// "The activation channel shown in the **Debit Card Activation Notice** is **ATM or ATB Connect**."
// Returns null if any requested field is missing, so the caller falls back to the writer/vision.
const buildImageOcrFieldAnswer = ({ requestedFields = [], fields = {}, resourceContext = {} }) => {
  if (!Array.isArray(requestedFields) || !requestedFields.length) return null;
  const title =
    resourceContext.resourceJson?.title || resourceContext.matchedResource?.title || 'image';
  const sentences = [];
  for (const requested of requestedFields) {
    const value = getOcrFieldValue(fields, requested);
    if (value === null || value === undefined || value === '') return null;
    const label = requested.label || requested.field;
    sentences.push(`The ${label} shown in the **${title}** is **${value}**.`);
  }
  return sentences.length ? sentences.join(' ') : null;
};

// Deterministic, LLM-free structured answer built only from trusted whitelisted OCR fields. Used
// when the vision model is unavailable but OCR still read usable fields, so the image question is
// answered with the fields we have (bold-label Markdown) rather than a generic failure message.
const buildImageOcrFieldsResponse = ({ fields = {}, resourceContext = {}, quickActions = [] }) => {
  const assistantMessage = buildTrustedOcrMarkdown(fields);
  if (!assistantMessage) return null;
  const title = resourceContext.resourceJson?.title || resourceContext.matchedResource?.title || null;
  const message = title ? `**${title}**\n${assistantMessage}` : assistantMessage;
  return {
    success: true,
    status: 'resource_image_ocr',
    agentMode: 'informational_answer',
    assistantMessage: message,
    data: {
      ai: {
        source: 'image_ocr_fields',
        language: 'english',
        agentMode: 'informational_answer',
        intent: 'resource_qa',
        actionName: null,
        confidence: 1,
        missingFields: [],
        extractedFields: { ...fields },
        responseStyle: RESPONSE_STYLES.RESOURCE_QUESTION_ANSWER,
        requiredTool: 'none',
        toolInput: {
          modelMode: 'text',
          ocrFallback: true,
          ...(quickActions.length ? { quickActions } : {}),
        },
        assistantMessage: message,
      },
      ...(quickActions.length ? { actions: quickActions } : {}),
    },
    ...(quickActions.length ? { actions: quickActions } : {}),
  };
};

// Central, deterministic handler for a matched image resource. Owns the retrieval-vs-content
// split and the OCR-only image-detail decision. Returns the same
// { response, safeResource, visionResult } contract as buildRoutedVisionResponse.
const resolveImageResourceResponse = async ({
  req,
  message,
  trace = null,
  routerDecision = {},
  memory = {},
  resourceContext,
}) => {
  const fileName = getFileNameFromUrl(resourceContext.fileUrl);
  const viewAction = buildImageViewAction({
    fileUrl: resourceContext.fileUrl,
    fileName,
    resourceId:
      resourceContext.resourceJson?.resourceId || resourceContext.matchedResource?.fileName || null,
    title: resourceContext.resourceJson?.title || resourceContext.matchedResource?.title || null,
  });
  const safeResource = sanitizeResourceMetadata({
    ...(resourceContext.resourceJson || {}),
    fileName,
    ...(viewAction ? { viewId: viewAction.id, safeViewUrl: viewAction.viewUrl } : {}),
  });
  const imageQuickActions = viewAction ? [viewAction] : [];
  const plannerIntent =
    routerDecision.plannerDecision?.intentType || routerDecision.intentType || null;

  // Safe diagnostics only: resource id/type, file extension, chosen route, endpoint, model. Never
  // base64, OCR dumps, or prompts. (See logImageRoute calls below.)
  const fileExtension = String(fileName || '').toLowerCase().split(/[?#]/)[0].split('.').pop() || '';
  const logImageRoute = (route, extra = {}) =>
    logImageMetric('image_route_selected', trace, {
      resource_id: resourceContext.resourceJson?.resourceId || resourceContext.matchedResource?.fileName || null,
      resource_type: resourceContext.resourceJson?.resourceType || null,
      file_extension: fileExtension,
      route,
      ...extra,
    });

  // Path 2: image content Q&A -> call the Python OCR endpoint and use
  // its extracted fields as the final answer source. The widget must not fall through to
  // resource_response_writer for image content questions.
  if (requiresImageContentExtraction(message, plannerIntent)) {
    logImageRoute('ocr_endpoint', {
      endpoint: '/agent/analyze-vision-document',
      goal: 'resource_qa',
      ocr_only: true,
    });
    const response = await runImageResourceQaAnalysis({
      req,
      message,
      trace,
      memory,
      resourceContext,
      viewAction,
      fileName,
    });
    if (resourceContext.fileBuffer) resourceContext.fileBuffer = null;
    return {
      response,
      safeResource,
      visionResult: response?.data?.ai || null,
      usedImageOcr: true,
      usedImageOcrEndpoint: true,
    };
  }

  // Path 1: image retrieval / view -> no OCR, no vision, never a Download PDF.
  logImageRoute('retrieval');
  const imageTitle = resourceContext.resourceJson?.title || resourceContext.matchedResource?.title || 'image resource';
  const imageLabel = normalizeText(imageTitle).includes('image')
    ? imageTitle
    : `${imageTitle} image`;
  const response = await buildResourceResponseWriterResponse({
    req,
    message,
    trace,
    routerDecision,
    resourceContext: buildImageWriterResourceContext(resourceContext),
    responseStyle: RESPONSE_STYLES.DOCUMENT_SUMMARY,
    status: 'resource_image_view',
    quickActions: imageQuickActions,
    writerMode: 'resource_qa',
    extraContext: {
      authoritativeMessage: `I found the **${String(imageLabel).toLowerCase()}**. You can open it below.`,
    },
  });
  if (resourceContext.fileBuffer) resourceContext.fileBuffer = null;
  return { response, safeResource, visionResult: null, usedImageRetrieval: true };
};

const buildRoutedVisionResponse = async ({
  req,
  message,
  routerDecision,
  memory,
  trace = null,
}) => {
  const resourceQuery =
    routerDecision.resourceHint ||
    memory.lastActiveResource?.title ||
    memory.lastActiveResource?.resourceType ||
    message;
  const resourceContext = await findFirstResourceContext(
    resourceQuery,
    message,
    trace,
    routerDecision.plannerDecision?.needsResourceSearch
      ? { searchMode: 'semantic' }
      : {},
  );

  if (!resourceContext) {
    return {
      response: routerDecision.plannerDecision?.needsResourceSearch
        ? buildPlannerResourceNoMatchResponse()
        : isGeneralBankingFallbackQuestion(message)
        ? await buildGeneralFallbackResponse({
            req,
            message,
            memory,
            routerDecision,
            trace,
            resourceQuery,
          })
        : buildResourceNotFoundResponse(resourceQuery),
      safeResource: null,
      visionResult: null,
    };
  }

  if (resourceContext.ambiguous) {
    return {
      response: buildResourceAmbiguityResponse(resourceContext.matchedResources || []),
      safeResource: null,
      visionResult: null,
    };
  }

  const fileName = getFileNameFromUrl(resourceContext.fileUrl);
  const isImageResource = isImageFileReference(
    resourceContext.fileUrl,
    resourceContext.contentType,
    resourceContext.resourceJson || {},
  ) || resourceContext.resourceFileType === 'image';
  if (isImageResource) {
    return resolveImageResourceResponse({
      req,
      message,
      trace,
      routerDecision,
      memory,
      resourceContext,
    });
  }
  const isPdfResource = isPdfFileReference(resourceContext.fileUrl, resourceContext.contentType);
  const downloadAction = isPdfResource
    ? buildPdfDownloadAction({
        fileUrl: resourceContext.fileUrl,
        fileName,
        resourceId: resourceContext.resourceJson?.resourceId || resourceContext.matchedResource?.fileName || null,
        title: resourceContext.resourceJson?.title || resourceContext.matchedResource?.title || null,
      })
    : null;
  const viewAction = isImageResource
    ? buildImageViewAction({
        fileUrl: resourceContext.fileUrl,
        fileName,
        resourceId: resourceContext.resourceJson?.resourceId || resourceContext.matchedResource?.fileName || null,
        title: resourceContext.resourceJson?.title || resourceContext.matchedResource?.title || null,
      })
    : null;
  const safeResource = sanitizeResourceMetadata({
    ...(resourceContext.resourceJson || {}),
    fileName,
    ...(downloadAction
      ? {
          downloadId: downloadAction.id,
          safeDownloadUrl: downloadAction.downloadUrl,
        }
      : {}),
    ...(viewAction
      ? {
          viewId: viewAction.id,
          safeViewUrl: viewAction.viewUrl,
        }
      : {}),
  });
  if (
    resourceContext.resourceJson &&
    !isVisualResourceContext(resourceContext) &&
    !routerDecision.explicitPage &&
    isMetadataAnswerLikelyEnough(message, resourceContext.resourceJson)
  ) {
    const responseStyle = classifyResourceResponseStyle({
      message,
      resourceJson: resourceContext.resourceJson,
      routerDecision,
      defaultStyle: routerDecision.plannerDecision?.mode === 'resource_document'
        ? RESPONSE_STYLES.DOCUMENT_SUMMARY
        : RESPONSE_STYLES.RESOURCE_QUESTION_ANSWER,
    });
    const shouldIncludeDownload = responseStyle === RESPONSE_STYLES.DOCUMENT_SUMMARY;
    if (responseStyle) {
      const response = await buildResourceResponseWriterResponse({
        req,
        message,
        trace,
        routerDecision,
        resourceContext,
        responseStyle,
        status: 'resource_metadata',
        quickActions: shouldIncludeDownload && downloadAction ? [downloadAction] : [],
        writerMode: shouldIncludeDownload ? 'resource_document' : 'resource_qa',
      });
      return {
        response,
        safeResource,
        visionResult: null,
        usedMetadataFirst: true,
      };
    }
  }

  if (!isVisualResourceContext(resourceContext)) {
    return {
      response: buildResourceNotFoundResponse(resourceQuery),
      safeResource: null,
      visionResult: null,
    };
  }

  return {
    response: buildVisionPdfErrorResponse({
      status: 'vision_pdf_disabled',
      assistantMessage:
        'I found the PDF, but visual PDF analysis is disabled. I can answer only from extracted text or metadata.',
    }),
    safeResource,
    visionResult: null,
  };
};

const normalizeActionName = (value = '') => {
  const text = normalizeText(value);
  if (['bill payment', 'bill_payment', 'pay bill', 'pay_bill'].includes(text)) return 'pay_bill';
  if (['complaint', 'create complaint', 'create_complaint'].includes(text)) return 'create_complaint';
  return value || null;
};

const getActionNameFromRouterDecision = (routerDecision = {}) =>
  normalizeActionName(
    routerDecision.plannerDecision?.actionName ||
    routerDecision.plannerDecision?.action ||
    routerDecision.plannerDecision?.actionType ||
    '',
  );

const inferActionNameFromMessageAndResource = ({ message = '', routerDecision = {}, resourceJson = {} } = {}) => {
  const explicitAction = getActionNameFromRouterDecision(routerDecision);
  if (explicitAction) return explicitAction;

  const text = normalizeText(message);
  const resourceType = normalizeResourceType(resourceJson.resourceType || resourceJson.type);
  const relatedActions = Array.isArray(resourceJson.relatedActions)
    ? resourceJson.relatedActions.map(normalizeActionName).filter(Boolean)
    : [];
  if (/\b(create|submit|open|file)\b/.test(text) && /\b(complaint|claim|dispute)\b/.test(text)) {
    return 'create_complaint';
  }
  if (/\bpay\b/.test(text) && /\bbill\b/.test(text)) {
    return 'pay_bill';
  }
  if (/\bpay\b/.test(text) && relatedActions.includes('pay_bill')) return 'pay_bill';
  if (/\b(complaint|claim|dispute)\b/.test(text) && relatedActions.includes('create_complaint')) {
    return 'create_complaint';
  }
  if (resourceType.includes('dispute') || resourceType.includes('complaint')) {
    return 'create_complaint';
  }
  return null;
};

const shouldPrepareActionFromMatchedResource = ({ message = '', routerDecision = {}, resourceJson = {} } = {}) => {
  const actionName = inferActionNameFromMessageAndResource({ message, routerDecision, resourceJson });

  // Safety guard: never prepare a NEW bill payment from a receipt or an already-Paid record.
  // The caller falls through to the resource_qa answer, which explains it is already paid and
  // asks which unpaid bill the user means (see buildBillPaymentRequestAnswer).
  if (actionName === 'pay_bill' && isAlreadyPaidOrReceiptResource(resourceJson)) {
    return false;
  }

  const text = normalizeText(message);
  const resourceType = normalizeResourceType(resourceJson.resourceType || resourceJson.type);
  const hasBillPaymentResource =
    resourceType.includes('bill') ||
    resourceType.includes('payment') ||
    Boolean(findResourceValue(resourceJson, ['billReference', 'billRef', 'invoiceReference']));

  return (
    routerDecision.case === CASES.BANKING_ACTION ||
    routerDecision.needsActionFlow ||
    ['pay_bill', 'create_complaint'].includes(actionName) ||
    (/\bpay\b/.test(text) && /\bbill\b/.test(text) && hasBillPaymentResource)
  );
};

const buildActionAiFromMatchedResource = ({ message = '', routerDecision = {}, resourceContext = {}, req }) => {
  const resourceJson = resourceContext.resourceJson || {};
  const actionName = inferActionNameFromMessageAndResource({ message, routerDecision, resourceJson }) || 'pay_bill';
  const resourceFields = resourceFieldsForAction(actionName, resourceJson, req.user);
  const billFields = actionName === 'pay_bill'
    ? extractBillPaymentFields(resourceJson)
    : {};
  const sourceAccountId = extractSourceAccountIdFromMessage(message) ||
    billFields.sourceAccountId ||
    resourceFields.sourceAccountId;
  const normalizedFields = normalizeVisionFields({
    ...billFields,
    ...resourceFields,
    ...(sourceAccountId ? { sourceAccountId } : {}),
  });
  const extractedFields = actionName === 'create_complaint'
    ? {
        ...normalizedFields,
        ...(resourceFields.merchant ? { merchant: resourceFields.merchant } : {}),
        ...(resourceFields.disputeId ? { disputeId: resourceFields.disputeId } : {}),
        ...(resourceFields.card ? { card: resourceFields.card } : {}),
        ...(resourceFields.deadline ? { deadline: resourceFields.deadline } : {}),
        ...(resourceFields.status ? { status: resourceFields.status } : {}),
        ...(resourceFields.date ? { date: resourceFields.date } : {}),
      }
    : normalizedFields;
  const safeResource = sanitizeResourceMetadata({
    ...(resourceJson || {}),
    fileName: getFileNameFromUrl(resourceContext.fileUrl || resourceContext.resourceUrl || ''),
  });

  return {
    ai: {
      ...decisionToAiPayload({
        action: actionName,
        intent: actionName,
        fields: extractedFields,
      }),
      source: 'resource_metadata_action',
      agentMode: 'banking_action',
      intent: actionName,
      actionName,
      suggestedAction: actionName,
      extractedFields,
      missingFields: [],
      requiredTool: 'connector_action',
      toolInput: {
        modelMode: 'text',
        metadataFirst: true,
        resourceMetadata: safeResource,
      },
      assistantMessage: buildMetadataFirstAnswer({ resourceJson }) ||
        `I found the matching resource for **${routerDecision.resourceHint || message}**.`,
      routerDecision,
    },
    safeResource,
  };
};

const RESOURCE_FIRST_ACTION_TERMS =
  /\b(pay|bill|invoice|receipt|saved beneficiary|beneficiary profile|dispute|complaint|appointment|card pickup|replacement|standing order)\b/i;

const RESOURCE_TOPIC_ONLY_TERMS =
  /\b(alert|bill|certificate|document|file|form|guide|invoice|notice|pdf|policy|qr|receipt|request|statement|txt)\b/i;

const isBareResourceTopic = (message = '') => {
  const text = normalizeText(message);
  if (!text || isBroadGeneralMessage(text) || isEducationalBankingQuestion(text)) {
    return false;
  }

  if (/^(what|how|why|when|where|can|could|should|would|do|does|is|are)\b/.test(text)) {
    return false;
  }

  const words = text.split(/\s+/).filter(Boolean);
  return words.length <= 8 && RESOURCE_TOPIC_ONLY_TERMS.test(text);
};

const shouldTryResourceFirst = (message = '', routerDecision = {}) => {
  if (routerDecision.case === CASES.UNSAFE_REQUEST) return false;
  if (routerDecision.needsResourceSearch || routerDecision.resourceHint) return true;
  if (routerDecision.needsActionFlow && RESOURCE_FIRST_ACTION_TERMS.test(message)) return true;
  if (appearsToNeedResourceLookup(message)) return true;
  if (isBareResourceTopic(message)) return true;
  return false;
};

const resourceTypeForMetrics = (resourceContext = {}) =>
  resourceContext.resourceFileType ||
  resourceContext.resourceJson?.resourceType ||
  resourceContext.matchedResource?.resourceType ||
  resourceContext.contentType ||
  'unknown';

const isExplicitVisualReasoningRequest = (message = '', routerDecision = {}) => {
  if (routerDecision.explicitPage) return true;
  const text = normalizeText(message);
  return /\b(visual|visually|image|picture|screenshot|scan|scanned|layout|signature|stamp|page\s+\d+)\b/.test(text);
};

const visionRequirementForResource = ({ message = '', routerDecision = {}, resourceContext = {} } = {}) => {
  const isImageContext =
    resourceContext.resourceFileType === 'image' ||
    isImageFileReference(
      resourceContext.fileUrl,
      resourceContext.contentType,
      resourceContext.resourceJson || {},
    );

  if (isImageContext) {
    return {
      visionRequired: true,
      reason: 'selected_resource_is_image',
    };
  }

  return {
    visionRequired: false,
    reason: resourceContext.extractionStatus === 'extracted'
      ? 'resource_text_extracted'
      : 'resource_metadata_or_text_available',
  };
};

const logResourceFirstMetrics = ({
  trace,
  resourceContext = null,
  visionRequired = false,
  visionRequiredReason = 'not_applicable',
}) => {
  const selection = selectModel({ requiresVision: visionRequired });
  logArchitecture('resource_first_routing', {
    requestId: trace?.requestId,
    threadId: trace?.threadId,
    resource_first_used: Boolean(resourceContext),
    resource_type: resourceTypeForMetrics(resourceContext || {}),
    vision_required: Boolean(visionRequired),
    vision_required_reason: visionRequiredReason,
    selected_model: selection.selectedModel,
    resourceId: getResourceIdForCache(resourceContext || {}),
  });
};

// Minimum model confidence to trust a catalog-description answer over the trusted-file path.
const DESCRIPTION_QA_MIN_CONFIDENCE = 0.5;

const DESCRIPTION_QA_BOLD = /\*\*([^*\n]+?)\*\*/g;
const DESCRIPTION_QA_SUPPORT_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'to', 'from', 'and', 'or', 'of', 'at', 'for', 'in', 'on',
  'its', 'with', 'open', 'branch', 'service', 'provides', 'hours',
]);

const descriptionQaTokens = (value = '') =>
  normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !DESCRIPTION_QA_SUPPORT_STOPWORDS.has(token));

// Validate a model-reformulated answer against the deterministically extracted single-row facts.
// Every bolded value must be one of the extracted facts, the answer must name the extracted branch,
// and it must not mention any other branch — this is what prevents row mixing. Any failure routes
// to the deterministic builder (correct by construction).
const validateReformulatedAnswer = ({ answer = '', facts = {}, otherBranchNames = [] }) => {
  const text = String(answer || '').trim();
  if (!text) return { accepted: false, rejectionReason: 'empty_answer' };
  if (/^\s*i found\b/i.test(text)) return { accepted: false, rejectionReason: 'echoes_i_found' };
  if (/this resource is\b|use it when the user asks\b/i.test(text)) {
    return { accepted: false, rejectionReason: 'echoes_description' };
  }
  if (/\[context trimmed\]/i.test(text)) return { accepted: false, rejectionReason: 'truncated_context' };
  if (text.length > 320) return { accepted: false, rejectionReason: 'too_long' };

  const boldValues = [...text.matchAll(DESCRIPTION_QA_BOLD)].map((m) => m[1].trim()).filter(Boolean);
  if (!boldValues.length) return { accepted: false, rejectionReason: 'no_bold' };

  // Allowed values = ONLY the extracted facts for the selected row.
  const allowedValues = [
    facts.branchName,
    ...(Array.isArray(facts.services) ? facts.services : []),
    facts.hours,
    facts.address,
    facts.supportPhone,
  ].filter(Boolean);
  const allowedNorms = allowedValues.map((value) => normalizeText(value));
  for (const boldValue of boldValues) {
    const tokens = descriptionQaTokens(boldValue);
    if (!tokens.length) continue;
    const supported = allowedNorms.some((norm) => tokens.every((token) => norm.includes(token)));
    if (!supported) return { accepted: false, rejectionReason: 'bold_value_not_in_extracted_facts' };
  }

  // Must name the extracted branch (protects against answering for a different branch).
  const answerNorm = normalizeText(text);
  const branchTokens = descriptionQaTokens(facts.branchName || '');
  if (branchTokens.length && !branchTokens.every((token) => answerNorm.includes(token))) {
    return { accepted: false, rejectionReason: 'missing_selected_branch' };
  }

  // Must not mention any OTHER branch row (catches nearest/default-branch leakage).
  for (const other of otherBranchNames) {
    const otherNorm = normalizeText(other);
    if (otherNorm && otherNorm !== normalizeText(facts.branchName) && answerNorm.includes(otherNorm)) {
      return { accepted: false, rejectionReason: 'mentions_other_branch' };
    }
  }

  // Service question must include the requested service and only services in the extracted facts.
  if (facts.serviceLabel) {
    const labelTokens = descriptionQaTokens(facts.serviceLabel);
    if (labelTokens.length && !labelTokens.every((token) => answerNorm.includes(token))) {
      return { accepted: false, rejectionReason: 'missing_requested_service' };
    }
  }

  return { accepted: true, rejectionReason: null };
};

const qaResourceResponse = ({ assistantMessage, finalAnswerSource, routerDecision = {} }) => {
  const formattedAssistantMessage = ensureMeaningfulBoldMarkdown(assistantMessage);
  return {
    success: true,
    status: 'resource_qa',
    agentMode: 'informational_answer',
    assistantMessage: formattedAssistantMessage,
    data: {
      ai: {
        source: finalAnswerSource,
        finalAnswerSource,
        agentMode: 'informational_answer',
        intent: 'resource_qa',
        actionName: null,
        suggestedAction: null,
        missingFields: [],
        responseStyle: RESPONSE_STYLES.RESOURCE_QUESTION_ANSWER,
        requiredTool: 'none',
        toolInput: { modelMode: 'text', resourceFound: true },
        assistantMessage: formattedAssistantMessage,
        routerDecision,
      },
    },
  };
};

// Resource_qa via description analysis: (1) deterministically extract the single matching branch
// row's facts; (2) ask Ollama to reformulate ONLY those facts (it never sees the full multi-row
// description, so it cannot mix rows); (3) validate the wording against the facts; (4) fall back to
// the deterministic builder if reformulation fails/validation rejects. Returns null when the
// resource has no extractable structured row (caller then uses the deterministic builder/writer).
const buildCatalogDescriptionQaResponse = async ({
  req,
  message,
  trace,
  resourceContext,
  routerDecision = {},
}) => {
  void req;
  const resourceJson = resourceContext?.resourceJson || {};
  const facts = extractBranchFacts(resourceJson, message);
  if (!facts) {
    traceRoute(trace?.requestId, 'catalog_description_qa', {
      extracted: false,
      reason: 'no_structured_row_for_question',
    });
    return null; // non-branch / no row → caller uses deterministic builder + writer
  }

  // Trusted deterministic answer from the extracted row — the authoritative fallback.
  const deterministicAnswer = buildBranchAnswerFromFacts(facts, message);
  const selectedResourceId =
    resourceJson.resourceId || resourceContext?.matchedResource?.fileName || null;
  const otherBranchNames = (Array.isArray(resourceJson.branches) ? resourceJson.branches : [])
    .map((branch) => branch?.name)
    .filter(Boolean);

  // Reformulation from facts only (natural wording). Validated; falls back to deterministic.
  let reformulated = null;
  let reformulationError = null;
  try {
    const result = await reformulateAnswer({
      requestId: trace?.requestId,
      threadId: trace?.threadId,
      userQuestion: message,
      selectedResourceId,
      extractedFacts: {
        branchName: facts.branchName,
        services: facts.serviceLabel ? [facts.serviceLabel] : facts.services,
        ...(facts.asks.hours || facts.serviceLabel ? { hours: facts.hours } : {}),
        ...(facts.asks.location ? { address: facts.address } : {}),
        ...(facts.asks.phone ? { supportPhone: facts.supportPhone } : {}),
      },
    });
    reformulated = String(result?.data?.answerMarkdown || '').trim() || null;
  } catch (error) {
    reformulationError = error.message || 'reformulation_failed';
  }

  const validation = reformulated
    ? validateReformulatedAnswer({ answer: reformulated, facts, otherBranchNames })
    : { accepted: false, rejectionReason: reformulationError ? 'reformulation_call_failed' : 'no_reformulation' };

  const useReformulated = validation.accepted && reformulated;
  const assistantMessage = normalizeResourceAnswerSpacing(useReformulated ? reformulated : deterministicAnswer || '');
  const finalAnswerSource = useReformulated ? 'description_qa_reformulated' : 'trusted_deterministic';

  traceRoute(trace?.requestId, 'catalog_description_qa', {
    extracted: true,
    selectedResourceId,
    matchType: facts.matchType,
    branch: facts.branchName,
    serviceLabel: facts.serviceLabel || 'none',
    extractedServices: facts.services,
    reformulatedPreview: reformulated ? reformulated.replace(/\s+/g, ' ').slice(0, 140) : 'none',
    accepted: validation.accepted,
    rejectionReason: validation.rejectionReason || 'none',
    finalAnswerSource,
  });

  if (!assistantMessage) return null; // deterministic produced nothing → let caller continue
  return qaResourceResponse({ assistantMessage, finalAnswerSource, routerDecision });
};

const buildResourceFirstResponse = async ({
  req,
  res,
  message,
  payload,
  deterministicRouterDecision,
  memory,
  threadId,
  trace,
}) => {
  if (!shouldTryResourceFirst(message, deterministicRouterDecision)) {
    return null;
  }
  if (deterministicRouterDecision.plannerDecision?.mode === 'resource_search') {
    return null;
  }

  const resourceQuery = deterministicRouterDecision.resourceHint || message;
  const candidates = await buildResolvedResourceCandidates(resourceQuery, {
    originalMessage: message,
    requestId: trace?.requestId,
    threadId: trace?.threadId,
    limit: 5,
    searchMode: 'semantic',
  });
  const resourceContext = candidates[0] || null;

  if (!resourceContext) {
    logResourceFirstMetrics({
      trace,
      resourceContext: null,
      visionRequired: false,
      visionRequiredReason: 'resource_not_found',
    });
    return null;
  }

  if (_isDemoMode() && !resourceContext.ambiguous) {
    const _matchedTitle =
      resourceContext.resourceJson?.title ||
      resourceContext.matchedResource?.title ||
      '';
    if (_matchedTitle) _stepLog('Match', _matchedTitle);
  }

  if (resourceContext.ambiguous) {
    logResourceFirstMetrics({
      trace,
      resourceContext: null,
      visionRequired: false,
      visionRequiredReason: 'ambiguous_resource_matches',
    });
    return buildResourceAmbiguityResponse(resourceContext.matchedResources || []);
  }

  const visionRequirement = visionRequirementForResource({
    message,
    routerDecision: deterministicRouterDecision,
    resourceContext,
  });
  logResourceFirstMetrics({
    trace,
    resourceContext,
    visionRequired: visionRequirement.visionRequired,
    visionRequiredReason: visionRequirement.reason,
  });

  const resourceJson = resourceContext.resourceJson || {};
  const actionRouterDecision = {
    ...deterministicRouterDecision,
    case: CASES.LARAGON_RESOURCE_METADATA,
    modelMode: 'text',
    needsResourceSearch: true,
    needsPdfVision: false,
    resourceHint: resourceQuery,
  };

  const inferredResourceActionName = inferActionNameFromMessageAndResource({
    message,
    routerDecision: actionRouterDecision,
    resourceJson,
  });
  if (
    deterministicRouterDecision.needsActionFlow &&
    inferredResourceActionName &&
    shouldPrepareActionFromMatchedResource({
      message,
      routerDecision: actionRouterDecision,
      resourceJson,
    })
  ) {
    const { ai, safeResource } = buildActionAiFromMatchedResource({
      message,
      routerDecision: actionRouterDecision,
      resourceContext,
      req,
    });
    updateAgentMemory({
      userId: req.user.id,
      threadId,
      lastActiveResource: safeResource,
      lastTopic: safeResource.title || resourceQuery,
    });
    return dispatchByAgentMode({
      res,
      req,
      ai,
      trace,
      message,
      payload,
      conversationHistory: memoryConversationHistory(memory),
      fileContext: null,
    });
  }

  if (deterministicRouterDecision.needsActionFlow) {
    return null;
  }

  if (visionRequirement.visionRequired) {
    const topIsImage =
      resourceContext.resourceFileType === 'image' ||
      isImageFileReference(
        resourceContext.fileUrl,
        resourceContext.contentType,
        resourceContext.resourceJson || {},
      );
    if (topIsImage) {
      const { response, safeResource } = await resolveImageResourceResponse({
        req,
        message,
        trace,
        routerDecision: deterministicRouterDecision,
        memory,
        resourceContext,
      });
      if (safeResource) {
        updateAgentMemory({
          userId: req.user.id,
          threadId,
          lastActiveResource: safeResource,
          lastTopic: safeResource.title || resourceQuery,
        });
      }
      return response;
    }
    const vision = await buildVisionResponseFromResourceCandidates({
      req,
      trace,
      message,
      conversationHistory: memoryConversationHistory(memory),
      profileContext: {},
      agentContext: {},
      aiDecision: {},
      candidates,
      pageNumbers: deterministicRouterDecision.explicitPage
        ? [deterministicRouterDecision.explicitPage]
        : null,
      detailMode: Boolean(deterministicRouterDecision.explicitPage),
    });
    return vision?.visionResult || null;
  }

  if (deterministicRouterDecision.case === CASES.RESOURCE_DOWNLOAD) {
    return null;
  }

  const responseStyle = classifyResourceResponseStyle({
    message,
    resourceJson,
    routerDecision: deterministicRouterDecision,
    defaultStyle: RESPONSE_STYLES.RESOURCE_QUESTION_ANSWER,
  });
  const fileUrl = resourceContext.fileUrl || resourceJson.fileUrl || resourceJson.documentUrl || resourceJson.url || null;
  const isPdfResource = isPdfFileReference(fileUrl, resourceContext.contentType || resourceJson.mimeType);
  const downloadAction = responseStyle === RESPONSE_STYLES.DOCUMENT_SUMMARY && isPdfResource
    ? buildPdfDownloadAction({
        fileUrl,
        fileName: getFileNameFromUrl(fileUrl || resourceContext.matchedResource?.fileName || ''),
        resourceId: resourceJson.resourceId || resourceContext.matchedResource?.fileName || null,
        title: resourceJson.title || resourceContext.matchedResource?.title || null,
      })
    : null;
  // A natural fact question ("which branch / what hours / how much / status / due date") is QA, not
  // a "show me the resource" request. Only DOCUMENT_SUMMARY (show/open/view/download) is metadata.
  const writerMode = responseStyle === RESPONSE_STYLES.DOCUMENT_SUMMARY
    ? 'resource_document'
    : 'resource_qa';
  // A — low-confidence guard (trusted QA only): if the best resource match is weak/too-generic, do
  // NOT answer from it and do NOT call Ollama. Return a clean "trusted info not enough" reply. File
  // view (DOCUMENT_SUMMARY), image/OCR, and banking actions already returned above, so this is safe.
  if (writerMode === 'resource_qa' && isLowConfidenceQaMatch(resourceContext)) {
    return buildLowConfidenceQaResponse(deterministicRouterDecision);
  }
  // resource_qa answers run catalog-description QA first inside buildResourceResponseWriterResponse,
  // then fall back to the deterministic builder — uniform across all resource_qa paths.
  const response = await buildResourceResponseWriterResponse({
    req,
    message,
    trace,
    routerDecision: {
      ...deterministicRouterDecision,
      modelMode: 'text',
      needsPdfVision: false,
      needsResourceSearch: true,
    },
    resourceContext,
    responseStyle,
    status: writerMode === 'resource_qa' ? 'resource_qa' : 'resource_metadata',
    quickActions: downloadAction ? [downloadAction] : [],
    writerMode,
  });
  const safeResource = sanitizeResourceMetadata({
    ...(resourceJson || {}),
    fileName: resourceContext.matchedResource?.fileName,
    ...(downloadAction
      ? {
          downloadId: downloadAction.id,
          safeDownloadUrl: downloadAction.downloadUrl,
        }
      : {}),
  });

  updateAgentMemory({
    userId: req.user.id,
    threadId,
    lastActiveResource: safeResource,
    lastTopic: safeResource.title || resourceQuery,
  });
  return response;
};

const handleRoutedChatMessage = async ({
  req,
  res,
  message,
  payload,
  routerDecision,
  memory,
  threadId,
  trace,
}) => {
  debugResourceSearchLog('[agent-router] selected case/mode:', {
    case: routerDecision.case,
    modelMode: routerDecision.modelMode,
    needsResourceSearch: routerDecision.needsResourceSearch,
    needsPdfVision: routerDecision.needsPdfVision,
    needsActionFlow: routerDecision.needsActionFlow,
    resourceHint: routerDecision.resourceHint,
    explicitPage: routerDecision.explicitPage,
  });

  if (routerDecision.case === CASES.UNSAFE_REQUEST) {
    return sendRoutedResponse({
      res,
      req,
      threadId,
      trace,
      message,
      routerDecision,
      response: buildUnsafeRequestResponse(),
    });
  }

  if (routerDecision.case === CASES.NORMAL_CHAT) {
    const response = await buildTextOnlyAiResponse({
      req,
      message,
      memory,
      trace,
      routerDecision,
    });
    return sendRoutedResponse({ res, req, threadId, trace, message, routerDecision, response });
  }

  if (routerDecision.case === CASES.GENERAL_NATURAL_CHAT) {
    const response = await buildGeneralNaturalChatResponse({
      req,
      message,
      memory,
      trace,
      routerDecision,
    });
    return sendRoutedResponse({ res, req, threadId, trace, message, routerDecision, response });
  }

  if (routerDecision.case === CASES.LARAGON_RESOURCE_METADATA) {
    const plannerSearch = Boolean(routerDecision.plannerDecision?.needsResourceSearch);
    const plannerMode = routerDecision.plannerDecision?.mode || null;
    const forceSingleResourceResponse =
      routerDecision.plannerDecision?.reason === 'file_analysis is disabled in widget chat' ||
      !isExplicitBroadResourceSearchMessage(message);
    if (plannerMode === 'resource_search' && !forceSingleResourceResponse) {
      const broadResourceResponse = await buildBroadResourceSearchResponse(
        message,
        {
          intent: 'broad_resource_search',
          resourceQuery: routerDecision.resourceHint || routerDecision.plannerDecision?.resourceSearchQuery || message,
        },
        {
          requestId: trace?.requestId,
          threadId: trace?.threadId,
        },
      );
      if (broadResourceResponse?.data?.resourceMatches?.length) {
        return sendRoutedResponse({
          res,
          req,
          threadId,
          trace,
          message,
          routerDecision,
          response: broadResourceResponse,
          lastTopic: routerDecision.resourceHint,
        });
      }
    }
    const matches = await findMatchingResources(routerDecision.resourceHint || message, {
      limit: 5,
      requestId: trace?.requestId,
      threadId: trace?.threadId,
      ...(plannerSearch ? { searchMode: 'semantic' } : {}),
    });
    if (!matches.length) {
      const response = plannerSearch
        ? buildPlannerResourceNoMatchResponse()
        : isGeneralBankingFallbackQuestion(message)
        ? await buildGeneralFallbackResponse({
            req,
            message,
            memory,
            trace,
            routerDecision,
            resourceQuery: routerDecision.resourceHint || message,
          })
        : buildResourceNotFoundResponse(routerDecision.resourceHint || message);
      return sendRoutedResponse({
        res,
        req,
        threadId,
        trace,
        message,
        routerDecision,
        response,
      });
    }

    if (matches[0]?.ambiguous) {
      return sendRoutedResponse({
        res,
        req,
        threadId,
        trace,
        message,
        routerDecision,
        response: buildResourceAmbiguityResponse(matches),
      });
    }

    const specificResourceMatch = findDominantSpecificResourceMatch(
      `${message} ${routerDecision.resourceHint || ''} ${routerDecision.plannerDecision?.resourceSearchQuery || ''}`,
      matches,
    );
    const shouldReturnSingleResource =
      forceSingleResourceResponse || Boolean(specificResourceMatch);

    if (plannerMode === 'resource_search' && !shouldReturnSingleResource) {
      const response = await buildResourceResponseWriterResponse({
        req,
        message,
        trace,
        routerDecision,
        resourceMatches: matches,
        responseStyle: RESPONSE_STYLES.RESOURCE_SEARCH_LIST,
        status: 'resource_matches',
        writerMode: 'resource_search',
      });
      return sendRoutedResponse({
        res,
        req,
        threadId,
        trace,
        message,
        routerDecision,
        response,
        lastTopic: routerDecision.resourceHint,
      });
    }

    const selectedMatch = shouldOllamaRerank(message, matches, specificResourceMatch)
      ? await rerankMatchCandidates({
          message,
          matches,
          requestId: trace?.requestId,
          threadId: trace?.threadId,
        })
      : matches[0];
    const resourceContext = await resolveMatchedResourceContext({
      resourceUrl: selectedMatch.url || null,
      matchedResource: selectedMatch,
      matchedResources: matches,
      lookupText: routerDecision.resourceHint || message,
      originalMessage: message,
      requestId: trace?.requestId,
    });
    const resourceJson = resourceContext.resourceJson || selectedMatch.metadata || {};
    if (isVisualResourceContext(resourceContext)) {
      const candidateVisionResponse = await buildVisionResponseFromResourceCandidates({
        req,
        trace,
        message,
        conversationHistory: memoryConversationHistory(memory),
        profileContext: {},
        agentContext: {},
        aiDecision: plannerDecisionToAiDecision(routerDecision.plannerDecision || {}, message) || {},
        candidates: [resourceContext],
        detailMode: Boolean(routerDecision.explicitPage),
      });
      const visionResult = candidateVisionResponse?.visionResult;
      if (!visionResult) {
        const response = buildPlannerResourceNoMatchResponse();
        return sendRoutedResponse({
          res,
          req,
          threadId,
          trace,
          message,
          routerDecision,
          response,
        });
      }
      const safeResource = sanitizeResourceMetadata({
        ...(resourceJson || {}),
        fileName: selectedMatch.fileName,
      });
      return sendRoutedResponse({
        res,
        req,
        threadId,
        trace,
        message,
        routerDecision: {
          ...routerDecision,
          modelMode: 'text',
          needsPdfVision: false,
        },
        response: visionResult,
        lastActiveResource: safeResource,
        lastTopic: safeResource.title || routerDecision.resourceHint,
      });
    }
    if (shouldPrepareActionFromMatchedResource({ message, routerDecision, resourceJson })) {
      const inferredActionName = inferActionNameFromMessageAndResource({ message, routerDecision, resourceJson }) || 'pay_bill';
      logAgentStep(trace?.requestId, 'action_intent_preserved_after_resource_search', {
        selectedCase: routerDecision.case,
        needsActionFlow: routerDecision.needsActionFlow,
        actionName: inferredActionName,
        resourceId: resourceJson.resourceId || selectedMatch.fileName || null,
      });
      logAgentStep(trace?.requestId, 'resource_to_action_preparation_started', {
        actionType: inferredActionName,
        resourceId: resourceJson.resourceId || selectedMatch.fileName || null,
        status: resourceJson.status || null,
      });
      const { ai, safeResource } = buildActionAiFromMatchedResource({
        message,
        routerDecision,
        resourceContext: {
          ...resourceContext,
          resourceJson,
        },
        req,
      });
      updateAgentMemory({
        userId: req.user.id,
        threadId,
        lastActiveResource: safeResource,
        lastTopic: safeResource.title || routerDecision.resourceHint,
      });
      return dispatchByAgentMode({
        res,
        req,
        ai,
        trace,
        message,
        payload,
        conversationHistory: memoryConversationHistory(memory),
        fileContext: null,
      });
    }
    const fileUrl = resourceContext.fileUrl || resourceJson.fileUrl || resourceJson.documentUrl || resourceJson.url || null;
    const responseStyle = classifyResourceResponseStyle({
      message,
      resourceJson,
      routerDecision,
      defaultStyle: plannerMode === 'resource_document'
        ? RESPONSE_STYLES.DOCUMENT_SUMMARY
        : RESPONSE_STYLES.RESOURCE_QUESTION_ANSWER,
    });
    const downloadAction = responseStyle === RESPONSE_STYLES.DOCUMENT_SUMMARY
      && isPdfFileReference(fileUrl, resourceContext.contentType || resourceJson.mimeType)
      ? buildPdfDownloadAction({
          fileUrl,
          fileName: getFileNameFromUrl(fileUrl || selectedMatch.fileName || ''),
          resourceId: resourceJson.resourceId || selectedMatch.fileName || null,
          title: resourceJson.title || selectedMatch.fileName || null,
        })
      : null;
    const laragonWriterMode = responseStyle === RESPONSE_STYLES.DOCUMENT_SUMMARY
      ? 'resource_document'
      : 'resource_qa';
    if (_isDemoMode() && laragonWriterMode === 'resource_qa') {
      const _mTitle = resourceJson.title || resourceContext.matchedResource?.title || '';
      if (_mTitle) _stepLog('Match', _mTitle);
    }
    const response = await buildResourceResponseWriterResponse({
      req,
      message,
      trace,
      routerDecision,
      resourceContext,
      responseStyle,
      status: laragonWriterMode === 'resource_qa' ? 'resource_qa' : 'resource_metadata',
      quickActions: downloadAction ? [downloadAction] : [],
      writerMode: laragonWriterMode,
    });
    if (shouldReturnSingleResource) {
      logAgentStep(trace?.requestId, 'resource_answer_after_forced_search', {
        title: resourceJson.title || selectedMatch.fileName || null,
        type: resourceJson.resourceType || resourceJson.type || null,
        status: resourceJson.status || null,
        responseStyle,
      });
    }
    const safeResource = sanitizeResourceMetadata({
      ...(resourceJson || {}),
      fileName: selectedMatch.fileName,
      ...(downloadAction
        ? {
            downloadId: downloadAction.id,
            safeDownloadUrl: downloadAction.downloadUrl,
          }
        : {}),
    });
    logAgentRoutingDebug({
      message,
      routerDecision,
      response: {
        ...response,
        data: {
          ...(response.data || {}),
          resource: safeResource,
        },
      },
      finalRoute: 'resource_metadata',
    });
    return sendRoutedResponse({
      res,
      req,
      threadId,
      trace,
      message,
      routerDecision,
      response,
      lastActiveResource: safeResource,
      lastTopic: safeResource.title || routerDecision.resourceHint,
    });
  }

  if (routerDecision.case === CASES.RESOURCE_DOWNLOAD) {
    const { response, safeResource } = await buildResourceDownloadResponse({
      req,
      message,
      routerDecision,
      trace,
    });
    return sendRoutedResponse({
      res,
      req,
      threadId,
      trace,
      message,
      routerDecision,
      response,
      lastActiveResource: safeResource,
      lastTopic: safeResource?.title || routerDecision.resourceHint,
    });
  }

  if (routerDecision.case === CASES.MEMORY_CONTINUE) {
    return sendRoutedResponse({
      res,
      req,
      threadId,
      trace,
      message,
      routerDecision,
      response: buildMemoryContinueResponse({ routerDecision, memory }),
    });
  }

  if (routerDecision.case === CASES.RESOURCE_MEMORY_FOLLOWUP) {
    const response = buildResourceHistoryFollowupResponse({
      message,
      routerDecision,
    });
    return sendRoutedResponse({
      res,
      req,
      threadId,
      message,
      routerDecision,
      response,
    });
  }

  if (routerDecision.case === CASES.PDF_FOLLOWUP) {
    const resourceMemoryResponse = buildResourceMemoryFollowupResponse({
      message,
      routerDecision,
      activeResource: memory.lastActiveResource,
    });
    if (resourceMemoryResponse) {
      return sendRoutedResponse({
        res,
        req,
        threadId,
        trace,
        message,
        routerDecision: {
          ...routerDecision,
          modelMode: 'text',
          needsPdfVision: false,
        },
        response: resourceMemoryResponse,
      });
    }

  }

  if (
    [
      CASES.LARAGON_PDF_VISION,
      CASES.PDF_FOLLOWUP,
      CASES.SPECIFIC_PDF_DETAIL,
      CASES.EXPLICIT_PAGE_QUESTION,
    ].includes(routerDecision.case)
  ) {
    const { response, safeResource, usedMetadataFirst } = await buildRoutedVisionResponse({
      req,
      message,
      routerDecision,
      memory,
      trace,
    });
    const finalRouterDecision = usedMetadataFirst
      ? {
          ...routerDecision,
          modelMode: 'text',
          needsPdfVision: false,
        }
      : {
          ...routerDecision,
          modelMode: 'text',
          needsPdfVision: false,
        };
    return sendRoutedResponse({
      res,
      req,
      threadId,
      trace,
      message,
      routerDecision: finalRouterDecision,
      response,
      lastActiveResource: safeResource,
      lastTopic: safeResource?.title || routerDecision.resourceHint,
    });
  }

  if (routerDecision.case === CASES.BANKING_ACTION) {
    updateAgentMemory({
      userId: req.user.id,
      threadId,
      userMessage: message,
      lastCase: routerDecision.case,
      lastTopic: routerDecision.detailHint,
    });

    const canUsePlannerActionDecision = Boolean(routerDecision.plannerDecision?.actionName);
    let aiDecision = canUsePlannerActionDecision
      ? plannerDecisionToAiDecision(routerDecision.plannerDecision, message)
      : null;
    if (!aiDecision) {
      const availableActions = getAvailableAiActions(req.user.role);
      const decisionResponse = await decideMessage({
        requestId: trace?.requestId,
        threadId: trace?.threadId,
        message,
        userRole: req.user.role,
        availableActions,
        conversationHistory: memoryConversationHistory(memory),
        fileContext: null,
        profileContext: {},
        agentContext: {},
      });
      aiDecision = normalizeAiDecision(decisionResponse.data);
    }
    logArchitecture('router_decision', {
      requestId: trace?.requestId,
      threadId: trace?.threadId,
      selectedCase: routerDecision.case,
      aiDecision: aiDecision.decision,
      action: aiDecision.action,
      resourceQueryLength: String(aiDecision.resourceQuery || '').length,
    });

    if (aiDecision.decision === 'ask_clarification') {
      return handleAskClarificationDecision(res, {
        ...aiDecision,
        routerDecision,
      });
    }

    const shouldResolveActionResource =
      aiDecision.action &&
      (
        aiDecision.resourceQuery ||
        aiDecision.decision === 'search_resource' ||
        aiDecision.action === 'pay_bill'
      );

    if (shouldResolveActionResource) {
      const resourceContext = await buildResolvedResourceContext(
        aiDecision.resourceQuery || routerDecision.resourceHint || message,
        {
          originalMessage: message,
          requestId: trace?.requestId,
          threadId: trace?.threadId,
          ...(routerDecision.plannerDecision?.needsResourceSearch
            ? { searchMode: 'semantic' }
            : {}),
        },
      );

      if (resourceContext?.resourceJson) {
        // Safety: never prepare a NEW bill payment from a receipt or an already-Paid record. Answer
        // with a safe clarification (already paid → which unpaid bill?) instead of pay_bill prep.
        if (
          aiDecision.action === 'pay_bill' &&
          isAlreadyPaidOrReceiptResource(resourceContext.resourceJson)
        ) {
          const paidAnswer = normalizeResourceAnswerSpacing(
            buildMetadataFirstAnswer({ resourceJson: resourceContext.resourceJson, message }) ||
              'That record is already paid, so there is nothing to pay on it. Tell me which unpaid bill or provider you want to pay.',
          );
          const safeResource = sanitizeResourceMetadata({
            ...(resourceContext.resourceJson || {}),
            fileName: getFileNameFromUrl(resourceContext.fileUrl || resourceContext.resourceUrl || ''),
          });
          traceRoute(trace?.requestId, 'paid_receipt_payment_blocked', {
            resourceId: resourceContext.resourceJson.resourceId || null,
            status: resourceContext.resourceJson.status || null,
            action: 'pay_bill',
          });
          return sendRoutedResponse({
            res,
            req,
            threadId,
            trace,
            message,
            routerDecision,
            response: qaResourceResponse({
              assistantMessage: paidAnswer,
              finalAnswerSource: 'trusted_deterministic',
              routerDecision,
            }),
            lastActiveResource: safeResource,
            lastTopic: safeResource.title || aiDecision.resourceQuery,
          });
        }
        const resourceFields = resourceFieldsForAction(
          aiDecision.action,
          resourceContext.resourceJson,
          req.user,
        );
        const billFields = aiDecision.action === 'pay_bill'
          ? extractBillPaymentFields(resourceContext.resourceJson)
          : {};
        const extractedFields = normalizeVisionFields({
          ...(aiDecision.fields || {}),
          ...billFields,
          ...resourceFields,
        });
        const metadataAnswer = buildMetadataFirstAnswer({
          resourceJson: resourceContext.resourceJson,
        });
        const safeResource = sanitizeResourceMetadata({
          ...(resourceContext.resourceJson || {}),
          fileName: getFileNameFromUrl(resourceContext.fileUrl || resourceContext.resourceUrl || ''),
        });

        updateAgentMemory({
          userId: req.user.id,
          threadId,
          lastActiveResource: safeResource,
          lastTopic: safeResource.title || aiDecision.resourceQuery,
        });

        return dispatchByAgentMode({
          res,
          req,
          ai: {
            ...decisionToAiPayload(aiDecision),
            source: 'resource_metadata_action',
            agentMode: 'banking_action',
            intent: aiDecision.action,
            actionName: aiDecision.action,
            suggestedAction: aiDecision.action,
            extractedFields,
            missingFields: [],
            requiredTool: 'connector_action',
            toolInput: {
              modelMode: 'text',
              metadataFirst: true,
              resourceMetadata: safeResource,
            },
            assistantMessage:
              metadataAnswer ||
              `I found the matching resource for **${aiDecision.resourceQuery || message}**.`,
            routerDecision,
          },
          trace,
          message,
          payload,
          conversationHistory: memoryConversationHistory(memory),
          fileContext: null,
        });
      }
    }

    return dispatchByAgentMode({
      res,
      req,
      ai: {
        ...decisionToAiPayload(aiDecision),
        routerDecision,
      },
      trace,
      message,
      payload,
      conversationHistory: memoryConversationHistory(memory),
      fileContext: null,
    });
  }

  return null;
};

const buildWidgetFileAnalysisDisabledRouterDecision = (message = '') => {
  const plannerDecision = {
    intentType: 'multi_resource_search',
    mode: 'resource_search',
    resourceNeed: true,
    needsResourceSearch: true,
    resourceQuery: String(message || '').trim(),
    resourceSearchQuery: String(message || '').trim(),
    resourceCategoryHint: null,
    needsVision: false,
    needsActionFlow: false,
    needsDownload: false,
    actionType: null,
    actionName: null,
    missingFields: [],
    userGoal: String(message || '').trim() || null,
    confidence: 0.35,
    reason: 'file_analysis is disabled in widget chat',
  };

  return {
    case: CASES.LARAGON_RESOURCE_METADATA,
    modelMode: 'text',
    needsResourceSearch: true,
    needsPdfVision: false,
    needsActionFlow: false,
    needsMemory: true,
    resourceHint: plannerDecision.resourceSearchQuery,
    detailHint: null,
    explicitPage: null,
    safetyDecision: 'allowed',
    resourceMemoryMatch: null,
    reason: plannerDecision.reason,
    plannerDecision,
    plannerApplied: true,
  };
};

const handleWidgetFileAnalysisDisabled = async ({
  req,
  res,
  trace,
  message,
  payload = {},
  memory = null,
  threadId = null,
  source = 'unknown',
}) => {
  const effectiveThreadId = threadId || getBackendThreadId(req);
  const effectiveMemory = memory || getAgentMemory({
    userId: req.user.id,
    threadId: effectiveThreadId,
  });
  const routerDecision = buildWidgetFileAnalysisDisabledRouterDecision(message);
  const isTextFallback = source === 'uploaded_file_fallback_text' ||
    source === 'forbidden_file_analysis_text';

  logAgentStep(
    trace?.requestId,
    isTextFallback
      ? 'uploaded_file_fallback_blocked_widget_chat'
      : 'file_analysis_blocked_widget_chat',
    {
      source,
      responseIntent: 'file_analysis',
      reason: isTextFallback
        ? 'Widget chat response contained uploaded-file fallback text.'
        : 'Widget chat attempted to use file_analysis.',
    },
  );
  logAgentStep(trace?.requestId, 'forced_resource_search_after_blocked_file_analysis', {
    source,
    mode: routerDecision.plannerDecision.mode,
    needsResourceSearch: true,
    resourceSearchQuery: routerDecision.resourceHint,
    reason: routerDecision.reason,
  });

  return handleRoutedChatMessage({
    req,
    res,
    message,
    payload,
    routerDecision,
    memory: effectiveMemory,
    threadId: effectiveThreadId,
    trace,
  });
};

const dispatchByAgentMode = async ({
  res,
  req,
  ai,
  trace = null,
  message,
  payload = {},
  conversationHistory = [],
  fileContext = null,
  fileFallbackMessage = null,
}) => {
  const agentMode = ai.agentMode || 'informational_answer';
  if (isWidgetChatRequest(req)) {
    const blockedReason = getWidgetBlockedFileAnalysisReason(ai);
    if (blockedReason) {
      return handleWidgetFileAnalysisDisabled({
        req,
        res,
        trace,
        message,
        payload,
        source: blockedReason,
      });
    }
  }

  // file_analysis
  if (agentMode === 'file_analysis') {
    return handleFileAnalysisMode(res, ai, fileContext, trace);
  }

  // file_generation
  if (agentMode === 'file_generation') {
    return handleFileGenerationMode(res, req, ai, conversationHistory, fileContext);
  }

  // banking_action
  if (agentMode === 'banking_action' && ai.actionName) {
    ai = {
      ...ai,
      responseStyle: RESPONSE_STYLES.ACTION_CONTEXT,
      toolInput: {
        ...(ai.toolInput || {}),
        responseStyle: RESPONSE_STYLES.ACTION_CONTEXT,
      },
    };
    const finalPayload = mergePayloadWithExtractedFields({
      extractedFields: ai.extractedFields || {},
      payload,
    });
    logArchitecture('action_flow', {
      requestId: trace?.requestId,
      threadId: trace?.threadId,
      actionType: ai.actionName,
      requiredFieldsPresent: Object.keys(finalPayload || {}).filter((key) => !String(key).startsWith('_')),
      missingFields: ai.missingFields || [],
      confirmationRequired: true,
      smsRequired: false,
      auditLogCreated: false,
      executionStatus: 'preparation_started',
    });
    return handleBankingActionMode(res, req, ai, finalPayload, fileContext, trace, message);
  }

  // unsupported / informational_answer / unknown (fallback)
  if (fileFallbackMessage) {
    ai = { ...ai, assistantMessage: fileFallbackMessage };
  }
  return handleInformationalMode(res, ai, fileContext, trace);
};

const runOllamaFirstChat = async ({
  res,
  req,
  trace,
  message,
  payload = {},
  conversationHistory = [],
  profileContext = {},
  agentContext = {},
  fileContext = null,
  fileFallbackMessage = null,
  postProcessAi = null,
}) => {
  const availableActions = getAvailableAiActions(req.user.role);
  const safeProfileContext = sanitizeProfileContext(profileContext);
  const preDecisionBroadResourceResponse = await buildBroadResourceSearchResponse(message);
  if (preDecisionBroadResourceResponse) {
    logFinalResponse(trace, preDecisionBroadResourceResponse, 'resource_search_list');
    return res.json(preDecisionBroadResourceResponse);
  }

  const preDecisionThreadId = getBackendThreadId(req);
  const preDecisionMemory = getAgentMemory({
    userId: req.user.id,
    threadId: preDecisionThreadId,
  });
  const preDecisionRouterDecision = routeAgentCase({
    message,
    memoryContext: preDecisionMemory,
  });
  logAgentRoutingDebug({
    message,
    routerDecision: preDecisionRouterDecision,
    finalRoute: preDecisionRouterDecision.case,
  });
  const preDecisionResourceFirstResponse = await buildResourceFirstResponse({
    req,
    res,
    message,
    payload,
    deterministicRouterDecision: preDecisionRouterDecision,
    memory: preDecisionMemory,
    threadId: preDecisionThreadId,
    trace,
  });
  if (preDecisionResourceFirstResponse) {
    if (res.headersSent) return preDecisionResourceFirstResponse;
    logAgentRoutingDebug({
      message,
      routerDecision: {
        ...preDecisionRouterDecision,
        resourceFirst: true,
      },
      response: preDecisionResourceFirstResponse,
      finalRoute: 'resource_first_pre_decision',
    });
    logFinalResponse(trace, preDecisionResourceFirstResponse, 'resource_first_pre_decision');
    return res.json(preDecisionResourceFirstResponse);
  }

  const decisionResponse = await decideMessage({
    requestId: trace?.requestId,
    threadId: trace?.threadId,
    message,
    userRole: req.user.role,
    availableActions,
    conversationHistory,
    fileContext,
    profileContext: safeProfileContext,
    agentContext,
  });
  const aiDecision = normalizeAiDecision(decisionResponse.data);

  console.log('[chat/message] AI first decision:', aiDecision.decision);
  console.log('[chat/message] AI first intent:', aiDecision.intent);
  console.log('[chat/message] AI first resourceQueryLength:', String(aiDecision.resourceQuery || '').length);

  if (
    isWidgetChatRequest(req) &&
    (aiDecision.decision === 'file_analysis' || aiDecision.intent === 'file_analysis')
  ) {
    return handleWidgetFileAnalysisDisabled({
      req,
      res,
      trace,
      message,
      payload,
      source: 'ai_decision',
    });
  }

  const broadResourceResponse = await buildBroadResourceSearchResponse(message, aiDecision);
  if (broadResourceResponse) {
    const response = {
      ...broadResourceResponse,
      data: {
        ...broadResourceResponse.data,
        aiDecision,
      },
    };
    logFinalResponse(trace, response, 'resource_search_list');
    return res.json(response);
  }

  if (aiDecision.decision === 'ask_clarification') {
    const threadId = getBackendThreadId(req);
    const memory = getAgentMemory({ userId: req.user.id, threadId });
    const deterministicRouterDecision = routeAgentCase({ message, memoryContext: memory });
    const resourceFirstResponse = await buildResourceFirstResponse({
      req,
      res,
      message,
      payload,
      deterministicRouterDecision,
      memory,
      threadId,
      trace,
    });
    if (resourceFirstResponse) {
      return res.json(resourceFirstResponse);
    }
    return handleAskClarificationDecision(res, aiDecision);
  }

  let resolvedResourceContext = null;
  let resolvedResourceCandidates = [];
  if (aiDecision.decision === 'search_resource') {
    resolvedResourceCandidates = await buildResolvedResourceCandidates(
      aiDecision.resourceQuery || message,
      { originalMessage: message },
    );
    resolvedResourceContext = resolvedResourceCandidates[0] || null;

    if (!resolvedResourceContext) {
      const notFound = isExistingTransferDetailRequest(message)
        ? buildTransferRequestNotFoundResponse()
        : isSpecificResourceRequest(message)
          ? buildSpecificDocumentNotFoundResponse()
          : buildResourceNotFoundResponse(aiDecision.resourceQuery || message);
      return res.json({
        ...notFound,
        data: {
          ...notFound.data,
          aiDecision,
        },
      });
    }

    console.log('[chat/message] resource search triggered after AI decision:', {
      resourceQuery: aiDecision.resourceQuery || message,
      resourceType: resolvedResourceContext.matchedResource?.resourceType ||
        resolvedResourceContext.resourceJson?.resourceType ||
        'unknown',
      title: resolvedResourceContext.matchedResource?.title ||
        resolvedResourceContext.resourceJson?.title ||
        'unknown',
      extractionStatus: resolvedResourceContext.extractionStatus,
      fileSize: resolvedResourceContext.fileSize || 0,
      hasPdfPayload: Boolean(resolvedResourceContext.pdfBase64),
    });

    const accountResourceChoice = buildAccountResourceChoice(
      message,
      resolvedResourceContext,
    );
    if (accountResourceChoice) {
      return res.json({
        ...accountResourceChoice,
        data: {
          ...accountResourceChoice.data,
          aiDecision,
        },
      });
    }

    if (
      isVisualResourceContext(resolvedResourceContext) &&
      !shouldAnswerResourceFromJson(message, resolvedResourceContext, aiDecision)
    ) {
      const candidateVisionResponse = await buildVisionResponseFromResourceCandidates({
        req,
        trace,
        message,
        conversationHistory,
        profileContext: safeProfileContext,
        agentContext,
        aiDecision,
        candidates: resolvedResourceCandidates,
      });

      const visionResult = candidateVisionResponse?.visionResult;
      if (!visionResult) {
        return res.json(buildResourceNotFoundResponse(aiDecision.resourceQuery || message));
      }
      if (isWidgetChatRequest(req) && getWidgetBlockedFileAnalysisReason(visionResult)) {
        return handleWidgetFileAnalysisDisabled({
          req,
          res,
          trace,
          message,
          payload,
          source: getWidgetBlockedFileAnalysisReason(visionResult),
        });
      }

      return res.json({
        ...visionResult,
        data: {
          ...visionResult.data,
          aiDecision,
        },
      });
    }
  }

  const finalAiContext = {
    userRole: req.user.role,
    availableActions,
    conversationHistory,
    fileContext,
    profileContext: safeProfileContext,
    resolvedResourceContext: sanitizeResolvedResourceContextForAi(resolvedResourceContext),
    agentContext: mergeDecisionIntoAgentContext(agentContext, aiDecision),
  };
  logAiContextPrepared({
    trace,
    mode: 'text',
    message,
    resources: resolvedResourceContext ? [resolvedResourceContext] : [],
    context: finalAiContext,
  });
  const aiResponse = await analyzeMessage({
    requestId: trace?.requestId,
    threadId: trace?.threadId,
    message,
    ...finalAiContext,
  });

  let ai = {
    ...aiResponse.data,
    aiDecision,
  };
  if (resolvedResourceContext?.resourceJson) {
    ai = applyResourceResponseStyle({
      ai,
      message,
      resolvedResourceContext,
      aiDecision,
      trace,
    });
  }
  if (postProcessAi) {
    ai = postProcessAi(ai);
  }

  if (
    isWidgetChatRequest(req) &&
    (
      ai.agentMode === 'file_analysis' ||
      containsWidgetFileAnalysisText(ai.assistantMessage)
    )
  ) {
    return handleWidgetFileAnalysisDisabled({
      req,
      res,
      trace,
      message,
      payload,
      source: ai.agentMode === 'file_analysis'
        ? 'ai_response'
        : 'forbidden_file_analysis_text',
    });
  }

  console.log('[chat/message] final AI agentMode:', ai.agentMode);
  console.log('[chat/message] final AI intent:', ai.intent);
  console.log('[chat/message] final AI actionName:', ai.actionName);

  return dispatchByAgentMode({
    res,
    req,
    ai,
    trace,
    message,
    payload,
    conversationHistory,
    fileContext,
    fileFallbackMessage,
  });
};

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

const analyzeChatMessage = async (req, res) => {
  const { message, conversationHistory = [], agentContext = {} } = req.body;

  if (!message) {
    return res.status(400).json({ success: false, message: 'message is required' });
  }

  let trace = null;
  try {
    trace = getTraceContext(req, message);
    logArchitecture('request_received', {
      requestId: trace.requestId,
      threadId: trace.threadId,
      userId: trace.userId,
      route: trace.route,
      messagePreview: trace.messagePreview,
    });
    logAgentStep(trace.requestId, 'request_received', {
      messagePreview: trace.messagePreview,
      endpoint: trace.route,
      threadId: trace.threadId,
      userId: trace.userId,
    });

    const broadResourceResponse = await buildBroadResourceSearchResponse(message, {}, {
      requestId: trace.requestId,
      threadId: trace.threadId,
    });
    if (broadResourceResponse) {
      return res.json({
        success: true,
        message: 'Message analyzed successfully',
        data: {
          ...broadResourceResponse.data.ai,
          resourceMatches: broadResourceResponse.data.resourceMatches,
        },
      });
    }

    const threadId = getBackendThreadId(req);
    const memory = getAgentMemory({ userId: req.user.id, threadId });
    const deterministicRouterDecision = routeAgentCase({ message, memoryContext: memory });
    const resourceFirstResponse = await buildResourceFirstResponse({
      req,
      res,
      message,
      payload: {},
      deterministicRouterDecision,
      memory,
      threadId,
      trace,
    });
    if (resourceFirstResponse) {
      return res.json(adaptResourceResponseForAnalyze(
        resourceFirstResponse,
        {
          ...deterministicRouterDecision,
          resourceFirst: true,
        },
      ));
    }

    const availableActions = getAvailableAiActions(req.user.role);
    const decisionResponse = await decideMessage({
      requestId: trace.requestId,
      threadId: trace.threadId,
      message,
      userRole: req.user.role,
      availableActions,
      conversationHistory,
      agentContext,
    });
    const aiDecision = normalizeAiDecision(decisionResponse.data);

    const postDecisionBroadResourceResponse = await buildBroadResourceSearchResponse(
      message,
      aiDecision,
      { requestId: trace.requestId, threadId: trace.threadId },
    );
    if (postDecisionBroadResourceResponse) {
      return res.json({
        success: true,
        message: 'Message analyzed successfully',
        data: {
          ...postDecisionBroadResourceResponse.data.ai,
          aiDecision,
          resourceMatches: postDecisionBroadResourceResponse.data.resourceMatches,
        },
      });
    }

    if (aiDecision.decision === 'ask_clarification') {
      const postDecisionResourceFirstResponse = await buildResourceFirstResponse({
        req,
        res,
        message,
        payload: {},
        deterministicRouterDecision,
        memory,
        threadId,
        trace,
      });
      if (postDecisionResourceFirstResponse) {
        return res.json(adaptResourceResponseForAnalyze(
          postDecisionResourceFirstResponse,
          {
            ...deterministicRouterDecision,
            resourceFirst: true,
          },
        ));
      }
      return res.json({
        success: true,
        message: 'Message analyzed successfully',
        data: {
          ...decisionToAiPayload(aiDecision),
          aiDecision,
        },
      });
    }

    const resolvedResourceCandidates = aiDecision.decision === 'search_resource'
      ? await buildResolvedResourceCandidates(aiDecision.resourceQuery || message, {
          originalMessage: message,
          requestId: trace.requestId,
          threadId: trace.threadId,
        })
      : [];
    const resolvedResourceContext = resolvedResourceCandidates[0] || null;

    if (aiDecision.decision === 'search_resource' && !resolvedResourceContext) {
      const notFound = isExistingTransferDetailRequest(message)
        ? buildTransferRequestNotFoundResponse()
        : isSpecificResourceRequest(message)
          ? buildSpecificDocumentNotFoundResponse()
          : buildResourceNotFoundResponse(aiDecision.resourceQuery || message);
      return res.json({
        success: true,
        message: 'Message analyzed successfully',
        data: {
          ...notFound.data.ai,
          aiDecision,
        },
      });
    }

    if (
      resolvedResourceContext &&
      isVisualResourceContext(resolvedResourceContext) &&
      !shouldAnswerResourceFromJson(message, resolvedResourceContext, aiDecision)
    ) {
      const candidateVisionResponse = await buildVisionResponseFromResourceCandidates({
        req,
        trace,
        message,
        conversationHistory,
        profileContext: {},
        agentContext,
        aiDecision,
        candidates: resolvedResourceCandidates,
      });
      const visionResult = candidateVisionResponse?.visionResult;
      if (!visionResult) {
        const notFound = buildResourceNotFoundResponse(aiDecision.resourceQuery || message);
        return res.json({
          success: true,
          message: 'Message analyzed successfully',
          data: {
            ...notFound.data.ai,
            aiDecision,
          },
        });
      }

      return res.json({
        success: true,
        message: 'Message analyzed successfully',
        data: {
          ...(visionResult?.data?.ai || {}),
          aiDecision,
        },
      });
    }

    const analyzeAiContext = {
      userRole: req.user.role,
      availableActions,
      conversationHistory,
      resolvedResourceContext: sanitizeResolvedResourceContextForAi(resolvedResourceContext),
      agentContext: mergeDecisionIntoAgentContext(agentContext, aiDecision),
    };
    logAiContextPrepared({
      trace,
      mode: 'text',
      message,
      resources: resolvedResourceContext ? [resolvedResourceContext] : [],
      context: analyzeAiContext,
    });
    const aiResponse = await analyzeMessage({
      requestId: trace.requestId,
      threadId: trace.threadId,
      message,
      ...analyzeAiContext,
    });
    const ai = resolvedResourceContext?.resourceJson
      ? applyResourceResponseStyle({
          ai: aiResponse.data,
          message,
          resolvedResourceContext,
          aiDecision,
          trace,
        })
      : aiResponse.data;

    return res.json({
      success: true,
      message: 'Message analyzed successfully',
      data: {
        ...ai,
        aiDecision,
      },
    });
  } catch (error) {
    logError('request_failed', error, {
      requestId: trace?.requestId,
      threadId: trace?.threadId,
      route: req.originalUrl || req.path,
    });
    logAgentStep(trace?.requestId, 'error', {
      failingStage: 'request_failed',
      message: error.message,
      fallbackUsed: error instanceof ResourceCatalogUnavailableError
        ? 'resource_server_unreachable'
        : 'service_unavailable',
      ...(env.nodeEnv === 'development' ? { stack: error.stack } : {}),
    });
    if (error instanceof ResourceCatalogUnavailableError) {
      return handleResourceServerUnavailable(res);
    }

    console.error('[chat/analyze] orchestration failed:', error.message);
    return res.status(503).json({
      success: false,
      message: 'AI service is currently unavailable. Please try again later.',
    });
  }
};

const handleChatMessage = async (req, res) => {
  const {
    message,
    payload = {},
    conversationHistory = [],
    profileContext = {},
    agentContext = {},
  } = req.body;

  if (!message) {
    return res.status(400).json({ success: false, message: 'message is required' });
  }

  let trace = null;
  try {
    const threadId = getBackendThreadId(req);
    trace = getTraceContext(req, message);
    logArchitecture('request_received', {
      requestId: trace.requestId,
      threadId: trace.threadId,
      userId: trace.userId,
      route: trace.route,
      messagePreview: trace.messagePreview,
    });
    logAgentStep(trace.requestId, 'request_received', {
      messagePreview: trace.messagePreview,
      endpoint: trace.route,
      threadId: trace.threadId,
      userId: trace.userId,
    });
    traceRoute(trace.requestId, 'router_start', {
      originalUserMessage: message,
      hasUploadedFiles: Boolean(req.files?.length),
      endpoint: trace.route,
    });
    const memory = getAgentMemory({ userId: req.user.id, threadId });
    logArchitecture('memory', {
      requestId: trace.requestId,
      threadId: trace.threadId,
      userId: trace.userId,
      memoryLoaded: Boolean(memory),
      recentMessageCount: memory.recentMessages?.length || 0,
      lastActiveResourceTitle: memory.lastActiveResource?.title || null,
      resourceHistoryCount: memory.resourceHistory?.length || 0,
      cache: 'disabled',
    });

    const earlyPendingConfirmationResponse = await handlePendingConfirmationFollowUp({
      res,
      req,
      message,
      agentContext,
    });
    if (earlyPendingConfirmationResponse) {
      return earlyPendingConfirmationResponse;
    }

    const earlyPendingClarificationResponse = await handlePendingClarificationSelection({
      res,
      req,
      message,
      payload,
      conversationHistory,
      profileContext,
      agentContext,
      fileContext: null,
    });
    if (earlyPendingClarificationResponse) {
      return earlyPendingClarificationResponse;
    }

    const deterministicRouterDecision = routeAgentCase({ message, memoryContext: memory });
    if (
      hasClearNewResourceTarget(message) &&
      Array.isArray(memory.resourceHistory) &&
      memory.resourceHistory.length &&
      deterministicRouterDecision.case !== CASES.RESOURCE_MEMORY_FOLLOWUP
    ) {
      logAgentStep(trace.requestId, 'memory_followup_rejected_new_target', {
        messagePreview: trace.messagePreview,
        meaningfulWords: message
          .toLowerCase()
          .replace(/[^a-z0-9\s]+/g, ' ')
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 12),
        selectedCase: deterministicRouterDecision.case,
      });
    }

    const { plannerDecision, error: plannerError } = await runIntentPlanner({
      trace,
      req,
      message,
      conversationHistory,
      fileContext: null,
      profileContext,
      agentContext,
      conversationContext: req._conversationContext || null,
      requestContext: req._requestContext || null,
      agentPlan: req._agentPlan || null,
    });
    const routerDecision = plannerDecision
      ? buildPlannerRouterDecision({
          plannerDecision,
          deterministicDecision: deterministicRouterDecision,
          message,
        })
      : buildPlannerParseFallbackDecision(message, deterministicRouterDecision);

    // F: Ollama suggested no_match AND the request is not resource/file/bank-info-like, so a catalog
    // search is not useful. Return a clean MVP unsupported reply instead of "could not find resource".
    if (
      plannerDecision &&
      plannerDecision.intentType === 'no_match' &&
      !routerDecision.needsActionFlow &&
      !isCapabilitiesQuestion(message) &&
      !looksResourceLike(message)
    ) {
      if (env.debugAgentRouting) {
        console.log(
          '[PATH_DECISION] ollamaSuggested=no_match backendCase=mvp_unsupported' +
          ' mvpPath=unsupported plannerApplied=true needsCatalog=false needsAction=false',
        );
      }
      const unsupportedResponse = buildUnsupportedMvpResponse(routerDecision);
      logFinalResponse(trace, unsupportedResponse, unsupportedResponse.status);
      return res.json(unsupportedResponse);
    }
    logMvpPathDecision({ routerDecision, plannerDecision });
    logAgentStep(trace.requestId, 'planner_decision_applied', {
      plannerAvailable: Boolean(plannerDecision),
      fallbackUsed: plannerDecision ? false : 'safe_resource_search',
      plannerError: plannerError ? plannerError.message : null,
      intentType: routerDecision.plannerDecision?.intentType || plannerDecision?.intentType || null,
      mode: routerDecision.plannerDecision?.mode || plannerDecision?.mode || null,
      selectedCase: routerDecision.case,
      needsResourceSearch: routerDecision.needsResourceSearch,
      resourceSearchQueryLength: String(
        routerDecision.plannerDecision?.resourceSearchQuery || routerDecision.resourceHint || '',
      ).length,
      needsActionFlow: routerDecision.needsActionFlow,
    });
    logArchitecture('router_decision', {
      requestId: trace.requestId,
      threadId: trace.threadId,
      selectedCase: routerDecision.case,
      modelMode: routerDecision.modelMode,
      needsResourceSearch: routerDecision.needsResourceSearch,
      needsPdfVision: routerDecision.needsPdfVision,
      needsActionFlow: routerDecision.needsActionFlow,
      needsMemory: routerDecision.needsMemory,
      safetyDecision: routerDecision.safetyDecision,
    });
    logRouterDecisionStep(trace, message, routerDecision);
    traceRoute(trace.requestId, 'router_decision', {
      route: routerDecision.case,
      mode: routerDecision.plannerDecision?.mode || null,
      agentMode: routerDecision.agentMode || null,
      intent: routerDecision.plannerDecision?.intentType || routerDecision.intentType || null,
      requiredTool: routerDecision.requiredTool || null,
      resourceHint: routerDecision.resourceHint || null,
      needsResourceSearch: routerDecision.needsResourceSearch,
      confidence: routerDecision.plannerDecision?.confidence ?? null,
    });
    logAgentRoutingDebug({
      message,
      routerDecision,
      finalRoute: routerDecision.case,
      endpoint: req.originalUrl || req.path || null,
    });
    const resourceFirstResponse = await buildResourceFirstResponse({
      req,
      res,
      message,
      payload,
      deterministicRouterDecision: routerDecision,
      memory,
      threadId,
      trace,
    });
    if (resourceFirstResponse) {
      if (res.headersSent) {
        return resourceFirstResponse;
      }
      logAgentRoutingDebug({
        message,
        routerDecision: {
          ...routerDecision,
          resourceFirst: true,
        },
        response: resourceFirstResponse,
        finalRoute: 'resource_first',
        endpoint: req.originalUrl || req.path || null,
        finalAnswer: resourceFirstResponse?.data?.assistantMessage || null,
      });
      return sendRoutedResponse({
        res,
        req,
        threadId,
        trace,
        message,
        routerDecision: {
          ...routerDecision,
          resourceFirst: true,
        },
        response: resourceFirstResponse,
      });
    }
    const routedResponse = await handleRoutedChatMessage({
      req,
      res,
      message,
      payload,
      routerDecision,
      memory,
      threadId,
      trace,
    });
    if (routedResponse) {
      return routedResponse;
    }

    const pendingConfirmationResponse = await handlePendingConfirmationFollowUp({
      res,
      req,
      message,
      agentContext,
    });
    if (pendingConfirmationResponse) {
      return pendingConfirmationResponse;
    }

    const pendingClarificationResponse = await handlePendingClarificationSelection({
      res,
      req,
      message,
      payload,
      conversationHistory,
      profileContext,
      agentContext,
      fileContext: null,
    });
    if (pendingClarificationResponse) {
      return pendingClarificationResponse;
    }

    // Follow-up commands ("pay it", "continue", ...) reuse the context the
    // assistant extracted earlier instead of being re-analyzed from scratch.
    if (isFollowUpMessage(message)) {
      const followUpAction = inferActionFromContext(agentContext);

      if (followUpAction) {
        console.log('[chat/message] follow-up resolved to action:', followUpAction);
        return await dispatchByAgentMode({
          res,
          req,
          ai: buildFollowUpAi(followUpAction, agentContext),
          message,
          payload,
          conversationHistory,
          fileContext: null,
        });
      }
    }

    return await runOllamaFirstChat({
      res,
      req,
      trace,
      message,
      payload,
      conversationHistory,
      profileContext,
      agentContext,
      fileContext: null,
    });
  } catch (error) {
    logError('request_failed', error, {
      requestId: trace?.requestId,
      threadId: trace?.threadId,
      route: req.originalUrl || req.path,
    });
    logAgentStep(trace?.requestId, 'error', {
      failingStage: 'request_failed',
      message: error.message,
      fallbackUsed: error instanceof ResourceCatalogUnavailableError
        ? 'resource_server_unreachable'
        : 'service_unavailable',
      ...(env.nodeEnv === 'development' ? { stack: error.stack } : {}),
    });
    if (error instanceof ResourceCatalogUnavailableError) {
      return handleResourceServerUnavailable(res);
    }

    console.error('[chat/message] orchestration failed:', error.message);
    return res.status(503).json({
      success: false,
      message: 'AI service is currently unavailable. Please try again later.',
    });
  }
};

const handleChatMessageWithFiles = async (req, res) => {
  const message =
    req.body.message?.trim() || 'Please review the uploaded file attachments.';
  const payload = {};
  const conversationHistory = parseConversationHistory(req.body.conversationHistory);
  const profileContext = sanitizeProfileContext(
    parseProfileContext(req.body.profileContext),
  );
  const agentContext = parseAgentContext(req.body.agentContext);
  const uploadedFiles = req.files || [];

  console.log('[chat/with-files] message-with-files called');
  console.log('[chat/with-files] Uploaded files count:', uploadedFiles.length);
  console.log('[chat/with-files] Uploaded files:', uploadedFiles.map((f) => f.originalname));

  if (!message && !uploadedFiles.length) {
    return res.status(400).json({
      success: false,
      message: 'message or files are required',
    });
  }

  let trace = null;
  try {
    trace = getTraceContext(req, message);
    logAgentStep(trace.requestId, 'request_received', {
      messagePreview: trace.messagePreview,
      endpoint: trace.route,
      threadId: trace.threadId,
      userId: trace.userId,
    });
    const fileContext = await buildFileContext(uploadedFiles);
    createFileChatAuditLog({ req, fileContext });

    console.log('[chat/with-files] fileContext.files:', fileContext.files.length);
    console.log('[chat/with-files] fileContext.hasUploadedFiles:', fileContext.hasUploadedFiles);
    console.log('[chat/with-files] fileContext.combinedText length:', fileContext.combinedText?.length || 0);

    console.log('[chat/with-files] Sending to AI:', {
      hasUploadedFiles: fileContext.hasUploadedFiles,
      fileCount: fileContext.files.length,
      combinedTextLength: fileContext.combinedText?.length || 0,
    });

    const fileFallbackMessage = buildFileFallbackMessage(fileContext);

    const pendingConfirmationResponse = await handlePendingConfirmationFollowUp({
      res,
      req,
      message,
      agentContext,
    });
    if (pendingConfirmationResponse) {
      return pendingConfirmationResponse;
    }

    const pendingClarificationResponse = await handlePendingClarificationSelection({
      res,
      req,
      message,
      payload,
      conversationHistory,
      profileContext,
      agentContext,
      fileContext,
    });
    if (pendingClarificationResponse) {
      return pendingClarificationResponse;
    }

    const uploadedPdfVisionResponse = await buildUploadedPdfVisionResponse({
      req,
      trace,
      message,
      conversationHistory,
      profileContext,
      agentContext,
      fileContext,
    });
    if (uploadedPdfVisionResponse) {
      logFinalResponse(trace, uploadedPdfVisionResponse, uploadedPdfVisionResponse.status);
      return res.json(uploadedPdfVisionResponse);
    }

    return await runOllamaFirstChat({
      res,
      req,
      trace,
      message,
      payload,
      conversationHistory,
      profileContext,
      agentContext,
      fileContext,
      fileFallbackMessage,
      postProcessAi: (ai) => {
        console.log('[chat/with-files] AI agentMode:', ai.agentMode);
        console.log('[chat/with-files] AI intent:', ai.intent);
        console.log('[chat/with-files] AI actionName:', ai.actionName);
        console.log('[chat/with-files] AI assistantMessagePreview:', messagePreview(ai.assistantMessage, 120));

        if (fileContext.hasUploadedFiles && ai.assistantMessage) {
          const lower = ai.assistantMessage.toLowerCase();
          if (
            lower.includes('please upload') ||
            lower.includes('upload the file') ||
            lower.includes('upload a file') ||
            lower.includes('upload your file')
          ) {
            console.log('[chat/with-files] SAFEGUARD triggered - overriding bad AI message');
            return {
              ...ai,
              agentMode: 'file_analysis',
              assistantMessage: fileContext.combinedText
                ? `I read the uploaded file. Here is what I found:\n\n${fileContext.combinedText.slice(0, 500)}`
                : fileFallbackMessage ||
                  'I received the uploaded file, but I could not extract readable text from it.',
            };
          }
        }

        return ai;
      },
    });
  } catch (error) {
    logAgentStep(trace?.requestId, 'error', {
      failingStage: 'request_failed',
      message: error.message,
      fallbackUsed: error instanceof ResourceCatalogUnavailableError
        ? 'resource_server_unreachable'
        : 'service_unavailable',
      ...(env.nodeEnv === 'development' ? { stack: error.stack } : {}),
    });
    if (error instanceof ResourceCatalogUnavailableError) {
      return handleResourceServerUnavailable(res);
    }

    console.error('[chat/with-files] orchestration failed:', error.message);
    return res.status(503).json({
      success: false,
      message: 'AI service is currently unavailable. Please try again later.',
    });
  }
};

module.exports = {
  _private: {
    buildBroadResourceSearchResponse,
    buildActionAiFromMatchedResource,
    buildConfirmationQuickActions,
    buildPreparedActionMessage,
    buildPdfDownloadAction,
    buildImageViewAction,
    buildImageWriterResourceContext,
    buildStatementGenerationClarification,
    isStatementGenerationRequest,
    buildPlannerResourceNoMatchResponse,
    buildResourceFirstResponse,
    buildResponseWriterContext,
    buildResourceMetadataResponse,
    buildResourceMemoryFollowupResponse,
    buildWidgetFileAnalysisDisabledRouterDecision,
    buildVisionPdfErrorFromException,
    classifyResourceResponseStyle,
    getWidgetBlockedFileAnalysisReason,
    isImageFileReference,
    isVisualResourceContext,
    preprocessImageForVision,
    prepareVisionPayloadFromResourceContext,
    resolveImageResourceResponse,
    resolveMatchedResourceContext,
    shouldPrepareActionFromMatchedResource,
    isStructuredResourceAnswer,
    buildResourceResponseWriterResponse,
    shouldOllamaRerank,
    RESPONSE_STYLES,
  },
  analyzeChatMessage,
  handleChatMessage,
  handleChatMessageWithFiles,
};
