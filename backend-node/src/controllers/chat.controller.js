const fs = require('fs/promises');
const { randomUUID } = require('crypto');
const {
  getConnectedActionsByRole,
} = require('../actions/actionRegistry');
const env = require('../config/env');
const { selectModel } = require('../config/modelRouting');
const { executeAction } = require('../services/actionExecution.service');
const { prepareAction } = require('../services/actionPreparation.service');
const {
  analyzeMessage,
  analyzeVisionDocument,
  decideMessage,
  planIntent,
} = require('../services/aiClient.service');
const { createAuditLog } = require('../services/auditLog.service');
const { buildFileContext } = require('../services/fileContext.service');
const { generateFile } = require('../services/generatedFile.service');
const mockBeneficiaries = require('../data/mockBeneficiaries');
const {
  RESOURCE_JSON_BASE_URL,
  ResourceCatalogUnavailableError,
  findMatchingResources,
} = require('../services/resourceCatalog.service');
const {
  resolveResource,
  resolveResourcePayload,
} = require('../services/resourceResolver.service');
const { createResourceDownload } = require('../services/resourceDownload.service');
const {
  CASES,
  hasClearNewResourceTarget,
  routeAgentCase,
} = require('../services/agentCaseRouter.service');
const {
  getAgentMemory,
  getPdfVisionCache,
  sanitizeResourceMetadata,
  setPdfVisionCache,
  updateAgentMemory,
} = require('../services/agentMemory.service');
const { selectPdfPages } = require('../services/pdfPageSelection.service');
const {
  buildFallbackAssistantMessage,
  buildGeneralBankingFallbackAnswer,
  buildMetadataFirstAnswer,
  buildResourceFollowupAnswer,
  extractBillPaymentFields,
  isCapabilitiesQuestion,
  isGeneralBankingFallbackQuestion,
  isGenericCapabilitiesResponse,
  isMetadataAnswerLikelyEnough,
} = require('../services/resourceAnswer.service');
const {
  appearsToNeedResourceLookup,
  buildPlannerParseFallbackDecision,
  buildPlannerRouterDecision,
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
  shouldSaveAiContext,
  truncate,
} = require('../services/agentLogger.service');

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
  'You are ATB’s digital banking assistant. Answer naturally and professionally. Use only the provided resource context. Use clean Markdown. Prefer short titled sections and natural paragraphs. Avoid robotic metadata-only answers like ‘I found X. Category Y.’ Use compact tables only when the data is financial, tabular, or action-confirmation data. Do not expose backend details. Mask sensitive data. If an action is prepared, clearly state that confirmation is required before execution.';

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
    ...(shouldSaveAiContext() ? { context } : {}),
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
    });
    const plannerDecision = normalizePlannerDecision(plannerResponse.data);
    logAgentStep(trace?.requestId, 'planner_finished', {
      mode: plannerDecision.mode,
      needsResourceSearch: plannerDecision.needsResourceSearch,
      resourceSearchQueryLength: String(plannerDecision.resourceSearchQuery || '').length,
      needsActionFlow: plannerDecision.needsActionFlow,
      needsDownload: plannerDecision.needsDownload,
      actionType: plannerDecision.actionType,
      userGoalLength: String(plannerDecision.userGoal || '').length,
      confidence: plannerDecision.confidence,
      reasonLength: String(plannerDecision.reason || '').length,
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
      mode: 'resource_search',
      needsResourceSearch: true,
      resourceSearchQuery: message,
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

const getFileNameFromUrl = (value = '') => {
  try {
    const parsed = new URL(value);
    return parsed.pathname.split('/').pop() || 'document.pdf';
  } catch {
    return String(value || '').split(/[\\/]/).pop() || 'document.pdf';
  }
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

const buildVisionPdfErrorFromException = (error) => {
  const detail = String(error?.response?.data?.detail || error?.message || '');
  const statusCode = error?.response?.status;
  console.error('[vision-pdf] analysis failed:', {
    statusCode: statusCode || 'none',
    detail: detail || 'unknown_error',
  });

  if (!env.enableVisionPdfAnalysis || /disabled/i.test(detail)) {
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
      status: 'vision_pdf_empty_response',
      assistantMessage:
        'I found the PDF, but the vision model returned an empty response. Please try again.',
    });
  }

  return buildVisionPdfErrorResponse();
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
  return buildPdfDownloadAction({
    fileUrl: resolvedResourceContext.fileUrl,
    fileName: getFileNameFromUrl(resolvedResourceContext.fileUrl),
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
  /^do\s+i\s+have\b/,
  /^which\b/,
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

  const resourceType = normalizeResourceType(resourceJson?.resourceType);
  const isDirectQuestion = DIRECT_RESOURCE_QA_PATTERNS.some((pattern) => pattern.test(text));
  const hasStrongDocumentVerb = DOCUMENT_SUMMARY_STRONG_PATTERNS.some((pattern) => pattern.test(text));
  const hasDocumentNoun = DOCUMENT_SUMMARY_NOUN_PATTERNS.some((pattern) => pattern.test(text));
  const hasDocumentSummaryPhrase =
    /\b(profile overview|policy summary|product sheet|request draft)\b/.test(text);

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
  requestedActionName = null,
  maxPages = null,
  pageNumbers = null,
  detailMode = false,
}) => {
  if (!env.enableVisionPdfAnalysis) {
    return buildVisionPdfErrorFromException(new Error('Vision PDF analysis is disabled'));
  }

  if (!pdfBase64) {
    console.error('[vision-pdf] missing PDF base64 payload');
    return buildVisionPdfErrorResponse({
      status: 'vision_pdf_missing_payload',
      assistantMessage:
        'I found the PDF, but the backend could not prepare it for visual analysis.',
    });
  }

  try {
    const visionTimer = startTimer();
    console.log('[vision-pdf] backend payload ready:', {
      source,
      mimeType: mimeType || 'application/pdf',
      pdfBase64Length: String(pdfBase64).length,
      pageNumbers,
      detailMode: Boolean(detailMode),
    });
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
      mode: 'vision',
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
    logArchitecture('pdf_vision_flow', {
      requestId: trace?.requestId,
      threadId: trace?.threadId,
      event: 'vision_response_received',
      selectedPages: pageNumbers || [],
      detailMode: Boolean(detailMode),
      latencyMs: endTimer(visionTimer),
    });
    const downloadAction = attachDownloadAction
      ? providedDownloadAction || buildPdfDownloadAction({
          fileUrl,
          fileName,
          resourceId: resourceJson?.resourceId || null,
          title: resourceJson?.title || fileName || null,
        })
      : null;
    let ai = attachPdfDownloadAction(
      normalizeVisionAiForBackend(visionResponse.data, req.user),
      downloadAction,
    );
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
    console.log('[vision-pdf] backend normalized response:', {
      documentType: ai.documentType || 'unknown',
      suggestedAction: ai.suggestedAction || 'none',
      confidence: ai.confidence,
    });
    const requestedType = getRequestedDocumentType(message);
    const documentMatchesRequest = ai.toolInput?.documentMatchesRequest !== false;
    if (
      !documentMatchesRequest ||
      !isCompatibleDetectedDocumentType(requestedType, ai.documentType)
    ) {
      console.log('[vision-pdf] rejected mismatched document:', {
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
        ...(downloadAction
          ? {
              document: {
                fileName,
                fileType: 'pdf',
                downloadUrl: downloadAction.downloadUrl,
              },
              actions: [downloadAction],
            }
          : {}),
      },
      ...(downloadAction
        ? {
            document: {
              fileName,
              fileType: 'pdf',
              downloadUrl: downloadAction.downloadUrl,
            },
            actions: [downloadAction],
          }
        : {}),
    };
  } catch (error) {
    return buildVisionPdfErrorFromException(error);
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
  const originalMessage = options.originalMessage || resourceQuery;
  const lookupText = String(resourceQuery || originalMessage || '').trim();
  return ['receipt', 'document', 'request', 'statement', 'profile', 'overview']
    .includes(normalizeText(lookupText))
    ? String(originalMessage || lookupText).trim()
    : lookupText;
};

const summarizeMatchedResources = (matchedResources = []) =>
  matchedResources.map((resource) => ({
    fileName: resource.fileName,
    score: resource.score,
    resourceType: resource.metadata?.resourceType,
    title: resource.metadata?.title,
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
}) => ({
    resourceUrl,
  resourceJson: resolved.resourceJson,
  fileUrl: resolved.fileUrl,
  fileTextPreview: '',
  fileText: resolved.fileText || '',
  pdfBase64: resolved.fileBuffer ? resolved.fileBuffer.toString('base64') : null,
  fileSize: resolved.fileSize || null,
  contentType: resolved.contentType,
  resourceFileType: resolved.resourceFileType || 'pdf',
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
          },
        }
      : {}),
    ...(resolved.extractionError || extractionError
      ? { extractionError: resolved.extractionError || extractionError }
      : {}),
  });

const resolveMatchedResourceContext = async ({
  resourceUrl,
  matchedResource = null,
  matchedResources = [],
  lookupText,
  originalMessage,
  requestId = null,
}) => {
  const timer = startTimer();
  const candidateFileUrl = matchedResource?.metadata?.fileUrl ||
    matchedResource?.metadata?.documentUrl ||
    matchedResource?.metadata?.url ||
    null;
  try {
    const resolved = resourceUrl
      ? await resolveResource(resourceUrl)
      : await resolveResourcePayload(matchedResource.metadata);
    logAgentStep(requestId, 'pdf_result', {
      success: resolved.extractionStatus !== 'failed',
      resourceId: matchedResource?.fileName || null,
      elapsedMs: endTimer(timer),
      charCount: resolved.fileText ? String(resolved.fileText).length : 0,
      pageCount: resolved.pageCount || null,
      extractionStatus: resolved.extractionStatus,
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
      const resolved = await resolveResourcePayload(matchedResource.metadata);
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
  const matchedResources = await findMatchingResources(catalogLookupText || originalMessage, {
    limit: options.limit || 6,
    requestId: options.requestId,
    threadId: options.threadId,
    searchMode: options.searchMode,
    semanticSearch: options.semanticSearch,
    minScore: options.minScore,
    minMargin: options.minMargin,
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
    return [];
  }

  const contexts = [];
  for (const matchedResource of matchedResources) {
    const resourceUrl = matchedResource.url || null;
    if (matchedResource) {
      console.log('[resource-catalog] resource candidate:', {
        resourceId: matchedResource.fileName || 'unknown_resource',
        resourceType: matchedResource.metadata?.resourceType || 'unknown',
        score: matchedResource.score,
      });
    }
    contexts.push(await resolveMatchedResourceContext({
      resourceUrl,
      matchedResource,
      matchedResources,
      lookupText,
      originalMessage,
      requestId: options.requestId,
    }));
  }

  const selectedContext = contexts[0];
  const selectedJson = selectedContext?.resourceJson || selectedContext?.matchedResource || {};
  if (selectedContext) {
    logAgentStep(options.requestId, 'resource_selected', {
      resourceId: selectedContext.matchedResource?.fileName || selectedJson.resourceId || null,
      type: selectedJson.resourceType || selectedContext.matchedResource?.resourceType || null,
      reasonCode: 'highest_scoring_resource_candidate',
      metadata: safeMetadata(selectedJson),
    });
  }

  return contexts;
};

const buildResolvedResourceContext = async (resourceQuery, options = {}) => {
  const candidates = await buildResolvedResourceCandidates(resourceQuery, options);
  const best = candidates[0] || null;

  if (best?.matchedResource) {
    console.log('[resource-catalog] resource selected:', {
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
    if (
      !isPdfFileReference(
        resolvedResourceContext.fileUrl,
        resolvedResourceContext.contentType,
      )
    ) {
      continue;
    }

    const visionResult = await toVisionPdfResponse({
      req,
      trace,
      message,
      conversationHistory,
      profileContext,
      agentContext: mergeDecisionIntoAgentContext(agentContext, aiDecision),
      source: 'laragon_resource',
      fileName: getFileNameFromUrl(resolvedResourceContext.fileUrl),
      fileUrl: resolvedResourceContext.fileUrl,
      mimeType: resolvedResourceContext.contentType,
      pdfBase64: resolvedResourceContext.pdfBase64,
      resourceJson: resolvedResourceContext.resourceJson,
      allowActionPreparation: shouldAllowVisionActionPreparation(
        message,
        aiDecision,
      ) && !detailMode,
      attachDownloadAction: shouldAttachPdfDownloadForRequest(
        message,
        resolvedResourceContext.resourceJson,
      ),
      requestedActionName: aiDecision.action || null,
      maxPages: pageNumbers?.length || null,
      pageNumbers,
      detailMode,
    });

    if (visionResult.status === 'resource_mismatch') {
      lastMismatch = visionResult;
      console.log('[vision-pdf] trying next resource candidate after mismatch');
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
      'customer_profile',
      'account_statement',
      'salary_certificate',
      'bill',
      'payment_receipt',
      'standing_order',
      'international_transfer_request',
      'checkbook_request',
      'atm_receipt',
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

const resourceMetadataText = (metadata = {}) =>
  normalizeText(JSON.stringify(metadata || {}));

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

const resourceSearchListRequestFromMessage = (message = '', aiDecision = {}) => {
  const category = broadSearchCategoryFromMessage(message);
  const accountId = firstAccountIdFromMessage(message);

  if (category) {
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

  const text = normalizeText(message);
  const hasSearchVerb = /\b(find|show|list|search|get|look for|which|display)\b/.test(text) ||
    /\bdo i have\b/.test(text);
  const hasBroadScope = /\b(anything|everything|all|any|linked|related|about|resources?|records?|files?|documents?|certificates?)\b/.test(text);
  if (!hasSearchVerb || !hasBroadScope) return null;

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
    return /\bacc\s*[_-]?\s*001\b/.test(text);
  }

  return true;
};

const broadResourcePriority = (category, resource = {}) => {
  const config = BROAD_RESOURCE_SEARCH_CONFIG[category];
  const resourceType = normalizeResourceType(resource.metadata?.resourceType);
  const index = config?.priority?.indexOf(resourceType) ?? -1;
  return index >= 0 ? index : 999;
};

const broadResourceTitle = (resource = {}) =>
  resource.metadata?.title || resource.fileName || 'Resource';

const SEARCH_LIST_TECHNICAL_FIELDS = new Set([
  'body',
  'content',
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

  const matches = (await findMatchingResources(descriptor.query, {
    catalog: options.catalog,
    forceRefresh: options.forceRefresh,
    requestId: options.requestId,
    threadId: options.threadId,
    limit: 24,
    minScore: 1,
  }))
    .filter((resource) => shouldIncludeBroadResourceMatch(descriptor.category, resource))
    .filter((resource) => {
      if (!descriptor.accountId) return true;
      return resourceMetadataText(resource.metadata).includes(normalizeText(descriptor.accountId));
    })
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

  const resultLines = [];
  matches.forEach((resource) => {
    resultLines.push(
      `- **${markdownSafeInline(broadResourceTitle(resource))}** - ${matchReasonForResource(resource, descriptor)}`,
    );
    importantResourceFieldsForList(resource.metadata, 4).forEach((field) => {
      resultLines.push(`  - ${field.label}: **${markdownSafeInline(field.value)}**`);
    });
  });

  const assistantMessage = [
    `I found ${matches.length} ${descriptor.label} resources:`,
    '',
    ...resultLines,
  ].join('\n');

  const downloadActions = matches
    .map((resource) => {
      const metadata = resource.metadata || {};
      const fileUrl = metadata.fileUrl || metadata.documentUrl || metadata.url;
      const action = buildPdfDownloadAction({
        fileUrl,
        fileName: getFileNameFromUrl(fileUrl || resource.fileName || ''),
        resourceId: metadata.resourceId || resource.fileName || null,
        title: broadResourceTitle(resource),
      });
      return action
        ? {
            ...action,
            label: `Download PDF - ${broadResourceTitle(resource)}`.slice(0, 80),
          }
        : null;
    })
    .filter(Boolean)
    .slice(0, 6);
  const quickActions = dedupeQuickActions(downloadActions);

  return {
    success: true,
    status: 'resource_matches',
    agentMode: 'informational_answer',
    assistantMessage,
    actions: quickActions,
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
        toolInput: quickActions.length ? { quickActions } : {},
        assistantMessage,
      },
      actions: quickActions,
      resourceMatches: matches.map((resource) => ({
        fileName: resource.fileName,
        score: resource.score,
        resourceType: resource.metadata?.resourceType,
        title: resource.metadata?.title,
        status: resource.metadata?.status,
        provider: resource.metadata?.provider,
        importantFields: importantResourceFieldsForList(resource.metadata, 4),
        matchReason: matchReasonForResource(resource, descriptor),
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

const buildPreparedActionMessage = (preparation = {}, options = {}) => {
  const summary = parseSummaryItems(preparation.summary || []);
  const payload = preparation.payload || {};
  const config = PREPARED_ACTION_CONFIG[preparation.actionName];

  if (config) {
    const table = buildDetailsTable(config.rows(summary, payload));
    const intro = options.fromFile && config.fileIntro ? config.fileIntro : config.intro;
    const confirmText = config.confirmText || 'Please confirm before I continue.';

    return [intro, '', table, '', confirmText]
      .filter((line) => line !== null)
      .join('\n');
  }

  const table = buildDetailsTable(
    (preparation.summary || []).map((item) => {
      const [label, ...rest] = String(item).split(':');
      return [label.trim(), rest.join(':').trim()];
    }),
  );

  return ['I can continue with this.', '', table, '', 'Please confirm before I continue.']
    .filter((line) => line !== null)
    .join('\n');
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

const handleBankingActionMode = async (res, req, ai, finalPayload, fileContext, trace = null) => {
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
          assistantMessage: buildPreparedActionMessage({
            ...preparationData,
            summary: confirmationData.summary || preparationData.summary,
            payload: confirmationData.finalPayload || preparationData.payload,
          }, {
            fromFile: Boolean(fileContext?.combinedText),
          }),
          data: {
            ai: confirmationAi,
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
      response = {
        success: true,
        status: 'action_prepared',
        agentMode: 'banking_action',
        assistantMessage: buildPreparedActionMessage(preparationData, {
          fromFile: Boolean(fileContext?.combinedText),
        }),
        data: { ai, finalPayload, preparation: preparationData, ...fileData },
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
    'I cannot help with bypassing security controls or accessing another user\'s private banking data.';

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
  const availableActions = getAvailableAiActions(req.user.role);
  const resources = resourceContext
    ? [summarizeResourceForWriter(resourceContext)]
    : resourceMatches.map(summarizeResourceForWriter);
  const resolvedResourceContext = resourceContext
    ? sanitizeResolvedResourceContextForAi(resourceContext)
    : null;
  const aiContext = {
    userRole: req.user.role,
    availableActions,
    conversationHistory: [],
    fileContext: null,
    profileContext: {},
    resolvedResourceContext,
    agentContext: {
      systemInstruction: RESPONSE_WRITER_INSTRUCTION,
      resourceResponseWriter: {
        mode: writerMode,
        responseStyle,
        resources,
        resourceCount: resources.length,
        userAskedForDownload: quickActions.some((action) => isDownloadLikeQuickAction(action)),
        statusAnswerFirst: isStatusQuestion(message) && Boolean(resources[0]?.status),
        statusAnswerInstruction: isStatusQuestion(message) && resources[0]?.status
          ? 'The user asks for status. Start the answer by directly stating the resource status, then add the most relevant supporting details from the provided resource context.'
          : null,
        confirmationRequired: Boolean(extraContext.confirmationRequired),
        ...extraContext,
      },
    },
  };

  logAgentStep(trace?.requestId, 'response_writer_started', {
    mode: writerMode,
    responseStyle,
    resourceCount: resources.length,
    downloadActionIncluded: quickActions.some((action) => isDownloadLikeQuickAction(action)),
  });
  logAiContextPrepared({
    trace,
    mode: 'text',
    message,
    resources,
    context: aiContext,
  });

  const aiResponse = await analyzeMessage({
    requestId: trace?.requestId,
    threadId: trace?.threadId,
    message,
    ...aiContext,
  });
  const assistantMessage = aiResponse.data?.assistantMessage ||
    buildFallbackAssistantMessage({
      originalAnswer: '',
      userMessage: message,
      resourceQuery: routerDecision.resourceHint || message,
    });
  const normalizedQuickActions = dedupeQuickActions(quickActions);
  const ai = {
    ...aiResponse.data,
    source: 'resource_response_writer',
    agentMode: 'informational_answer',
    intent: writerMode,
    actionName: null,
    suggestedAction: null,
    responseStyle,
    requiredTool: 'none',
    toolInput: {
      ...(aiResponse.data?.toolInput || {}),
      modelMode: 'text',
      responseStyle,
      resourceFound: resources.length > 0,
      ...(normalizedQuickActions.length ? { quickActions: normalizedQuickActions } : {}),
    },
    assistantMessage,
    routerDecision,
  };

  logAgentStep(trace?.requestId, 'response_writer_finished', {
    mode: writerMode,
    responseStyle,
    responsePreview: truncate(assistantMessage, 250),
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

const findFirstPdfResourceContext = async (resourceQuery, message, trace = null, searchOptions = {}) => {
  const candidates = await buildResolvedResourceCandidates(resourceQuery || message, {
    originalMessage: message,
    limit: 6,
    requestId: trace?.requestId,
    threadId: trace?.threadId,
    ...searchOptions,
  });

  return candidates.find((candidate) =>
    isPdfFileReference(candidate.fileUrl, candidate.contentType),
  ) || null;
};

const buildResourceDownloadResponse = async ({ req, message, routerDecision, trace = null }) => {
  const resourceContext = await findFirstPdfResourceContext(
    routerDecision.resourceHint || message,
    message,
    trace,
    routerDecision.plannerDecision?.needsResourceSearch
      ? { searchMode: 'semantic' }
      : {},
  );

  if (!resourceContext?.fileUrl) {
    return {
      response: routerDecision.plannerDecision?.needsResourceSearch
        ? buildPlannerResourceNoMatchResponse()
        : buildResourceNotFoundResponse(routerDecision.resourceHint || message),
      safeResource: null,
    };
  }

  const fileName = getFileNameFromUrl(resourceContext.fileUrl);
  const downloadAction = buildPdfDownloadAction({
    fileUrl: resourceContext.fileUrl,
    fileName,
    resourceId: resourceContext.resourceJson?.resourceId || resourceContext.matchedResource?.fileName || null,
    title: resourceContext.resourceJson?.title || resourceContext.matchedResource?.title || null,
  });

  if (!downloadAction) {
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
    downloadId: downloadAction.id,
    safeDownloadUrl: downloadAction.downloadUrl,
  });
  return {
    response: await buildResourceResponseWriterResponse({
      req,
      message,
      trace,
      routerDecision,
      resourceContext,
      responseStyle: RESPONSE_STYLES.DOCUMENT_SUMMARY,
      status: 'resource_download_ready',
      quickActions: [downloadAction],
      writerMode: 'resource_document',
      extraContext: {
        document: {
          fileName,
          fileType: 'pdf',
        },
      },
    }),
    safeResource,
  };
};

const cacheMatchesQuestion = (message = '', cachedVisionResult = {}) => {
  const stopTokens = new Set(['about', 'what', 'which', 'the', 'and', 'from', 'there']);
  const queryTokens = normalizeText(message)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !stopTokens.has(token))
    .flatMap((token) =>
      token.endsWith('s') && token.length > 3
        ? [token, token.slice(0, -1)]
        : [token],
    );
  if (!queryTokens.length || !cachedVisionResult) {
    return null;
  }

  const evidence = Array.isArray(cachedVisionResult.evidence)
    ? cachedVisionResult.evidence
    : [];
  const matchingEvidence = evidence.find((item) => {
    const text = normalizeText(item.text || item.evidence_text || item);
    return queryTokens.some((token) => text.includes(token));
  });
  if (matchingEvidence) {
    return {
      page: matchingEvidence.page || null,
      text: matchingEvidence.text || matchingEvidence.evidence_text || String(matchingEvidence),
      confidence: cachedVisionResult.confidence || 0.7,
    };
  }

  const fields = cachedVisionResult.extractedFields || {};
  const matchingField = Object.entries(fields).find(([key, value]) => {
    const text = normalizeText(`${key} ${value}`);
    return queryTokens.some((token) => text.includes(token));
  });
  if (matchingField) {
    const [key, value] = matchingField;
    return {
      page: fields.page || null,
      text: `${key}: ${value}`,
      confidence: cachedVisionResult.confidence || 0.7,
    };
  }

  return null;
};

const buildCacheAnswerResponse = ({
  message,
  routerDecision,
  cachedVisionResult,
  activeResource,
}) => {
  const match = cacheMatchesQuestion(message, cachedVisionResult);
  if (!match) return null;

  const title = activeResource?.title || 'the last PDF';
  const pageText = match.page ? ` Page ${match.page}.` : '';
  const assistantMessage = `From **${title}**:${pageText} ${match.text}`;

  return {
    success: true,
    status: 'answered_from_pdf_cache',
    agentMode: 'informational_answer',
    assistantMessage,
    data: {
      ai: {
        source: 'pdf_vision_cache',
        language: 'english',
        agentMode: 'informational_answer',
        intent: routerDecision.case,
        actionName: null,
        confidence: match.confidence,
        missingFields: [],
        extractedFields: {
          page: match.page,
          evidence_text: match.text,
          cacheHit: true,
        },
        requiredTool: 'none',
        toolInput: {
          modelMode: 'text',
          cacheHit: true,
          page: match.page,
          evidence_text: match.text,
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
  const vision = memory.lastVisionResult;
  const assistantMessage = vision?.documentSummary
    ? `Continuing from **${activeResource?.title || 'the last PDF'}**: ${vision.documentSummary}`
    : activeResource
      ? `Continuing from **${activeResource.title || 'the last resource'}**. Ask a specific detail and I can inspect selected PDF pages if needed.`
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
  const resourceContext = await findFirstPdfResourceContext(
    resourceQuery,
    message,
    trace,
    routerDecision.plannerDecision?.needsResourceSearch
      ? { searchMode: 'semantic' }
      : {},
  );

  if (!resourceContext?.pdfBase64) {
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

  const fileName = getFileNameFromUrl(resourceContext.fileUrl);
  const downloadAction = buildPdfDownloadAction({
    fileUrl: resourceContext.fileUrl,
    fileName,
    resourceId: resourceContext.resourceJson?.resourceId || resourceContext.matchedResource?.fileName || null,
    title: resourceContext.resourceJson?.title || resourceContext.matchedResource?.title || null,
  });
  const safeResource = sanitizeResourceMetadata({
    ...(resourceContext.resourceJson || {}),
    fileName,
    downloadId: downloadAction?.id,
    safeDownloadUrl: downloadAction?.downloadUrl,
  });
  if (
    resourceContext.resourceJson &&
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

  const resourceId = getResourceIdForCache(resourceContext);
  const cachedVisionResult =
    getPdfVisionCache({ resourceId, pdfUrl: resourceContext.fileUrl, requestId: trace.requestId }) ||
    memory.lastVisionResult ||
    null;
  const pageSelection = selectPdfPages({
    message,
    explicitPage: routerDecision.explicitPage,
    cachedVisionResult,
    resourceMetadata: resourceContext.resourceJson,
  });

  console.log('[agent-router] selected PDF pages:', {
    case: routerDecision.case,
    resourceId,
    pages: pageSelection.pages,
    reason: pageSelection.reason,
  });

  const visionResult = await toVisionPdfResponse({
    req,
    trace,
    message,
    conversationHistory: memoryConversationHistory(memory),
    profileContext: {},
    agentContext: {
      routerCase: routerDecision.case,
      detailHint: routerDecision.detailHint,
      pageSelection,
    },
    source: 'laragon_resource',
    fileName,
    fileUrl: resourceContext.fileUrl,
    mimeType: resourceContext.contentType,
    pdfBase64: resourceContext.pdfBase64,
    resourceJson: resourceContext.resourceJson,
    allowActionPreparation: false,
    attachDownloadAction: Boolean(downloadAction),
    downloadAction,
    maxPages: pageSelection.pages.length,
    pageNumbers: pageSelection.pages,
    detailMode: true,
  });

  setPdfVisionCache({
    resourceId,
    pdfUrl: resourceContext.fileUrl,
    visionResult,
    requestId: trace.requestId,
  });

  return {
    response: {
      ...visionResult,
      data: {
        ...(visionResult.data || {}),
        pageSelection,
      },
    },
    safeResource,
    visionResult,
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
  if (/\b(create|submit|open|file)\b/.test(text) && /\b(complaint|claim|dispute)\b/.test(text)) {
    return 'create_complaint';
  }
  if (/\bpay\b/.test(text) && /\bbill\b/.test(text)) {
    return 'pay_bill';
  }
  if (resourceType.includes('dispute') || resourceType.includes('complaint')) {
    return 'create_complaint';
  }
  return null;
};

const shouldPrepareActionFromMatchedResource = ({ message = '', routerDecision = {}, resourceJson = {} } = {}) => {
  const actionName = inferActionNameFromMessageAndResource({ message, routerDecision, resourceJson });
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

const shouldTryResourceFirst = (message = '', routerDecision = {}) => {
  if (routerDecision.case === CASES.UNSAFE_REQUEST) return false;
  if (routerDecision.needsResourceSearch || routerDecision.resourceHint) return true;
  if (routerDecision.needsActionFlow && RESOURCE_FIRST_ACTION_TERMS.test(message)) return true;
  if (appearsToNeedResourceLookup(message)) return true;
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
  if (resourceContext.needsVision) {
    return {
      visionRequired: true,
      reason: resourceContext.resourceFileType === 'image'
        ? 'selected_resource_is_image'
        : resourceContext.extractionStatus || 'selected_resource_requires_vision',
    };
  }

  if (isExplicitVisualReasoningRequest(message, routerDecision)) {
    return {
      visionRequired: true,
      reason: routerDecision.explicitPage
        ? 'explicit_page_question'
        : 'explicit_visual_reasoning',
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

  const resourceQuery = deterministicRouterDecision.resourceHint || message;
  const candidates = await buildResolvedResourceCandidates(resourceQuery, {
    originalMessage: message,
    requestId: trace?.requestId,
    threadId: trace?.threadId,
    limit: 5,
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
    if (!resourceContext.pdfBase64 || resourceContext.resourceFileType === 'image') {
      return null;
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
  const downloadAction = responseStyle === RESPONSE_STYLES.DOCUMENT_SUMMARY
    ? buildPdfDownloadAction({
        fileUrl,
        fileName: getFileNameFromUrl(fileUrl || resourceContext.matchedResource?.fileName || ''),
        resourceId: resourceJson.resourceId || resourceContext.matchedResource?.fileName || null,
        title: resourceJson.title || resourceContext.matchedResource?.title || null,
      })
    : null;
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
    status: 'resource_metadata',
    quickActions: downloadAction ? [downloadAction] : [],
    writerMode: responseStyle === RESPONSE_STYLES.DOCUMENT_SUMMARY
      ? 'resource_document'
      : 'resource_qa',
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
  console.log('[agent-router] selected case/mode:', {
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
      routerDecision.plannerDecision?.reason === 'file_analysis is disabled in widget chat';
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

    if (plannerMode === 'resource_search' && !forceSingleResourceResponse) {
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

    const resourceContext = await resolveMatchedResourceContext({
      resourceUrl: matches[0].url || null,
      matchedResource: matches[0],
      matchedResources: matches,
      lookupText: routerDecision.resourceHint || message,
      originalMessage: message,
      requestId: trace?.requestId,
    });
    const resourceJson = resourceContext.resourceJson || matches[0].metadata || {};
    if (shouldPrepareActionFromMatchedResource({ message, routerDecision, resourceJson })) {
      const inferredActionName = inferActionNameFromMessageAndResource({ message, routerDecision, resourceJson }) || 'pay_bill';
      logAgentStep(trace?.requestId, 'action_intent_preserved_after_resource_search', {
        selectedCase: routerDecision.case,
        needsActionFlow: routerDecision.needsActionFlow,
        actionName: inferredActionName,
        resourceId: resourceJson.resourceId || matches[0].fileName || null,
      });
      logAgentStep(trace?.requestId, 'resource_to_action_preparation_started', {
        actionType: inferredActionName,
        resourceId: resourceJson.resourceId || matches[0].fileName || null,
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
      ? buildPdfDownloadAction({
          fileUrl,
          fileName: getFileNameFromUrl(fileUrl || matches[0].fileName || ''),
          resourceId: resourceJson.resourceId || matches[0].fileName || null,
          title: resourceJson.title || matches[0].fileName || null,
        })
      : null;
    const response = await buildResourceResponseWriterResponse({
      req,
      message,
      trace,
      routerDecision,
      resourceContext,
      responseStyle,
      status: 'resource_metadata',
      quickActions: downloadAction ? [downloadAction] : [],
      writerMode: responseStyle === RESPONSE_STYLES.DOCUMENT_SUMMARY
        ? 'resource_document'
        : 'resource_qa',
    });
    if (forceSingleResourceResponse) {
      logAgentStep(trace?.requestId, 'resource_answer_after_forced_search', {
        title: resourceJson.title || matches[0].fileName || null,
        type: resourceJson.resourceType || resourceJson.type || null,
        status: resourceJson.status || null,
        responseStyle,
      });
    }
    const safeResource = sanitizeResourceMetadata({
      ...(resourceJson || {}),
      fileName: matches[0].fileName,
      ...(downloadAction
        ? {
            downloadId: downloadAction.id,
            safeDownloadUrl: downloadAction.downloadUrl,
          }
        : {}),
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

    const cachedResponse = buildCacheAnswerResponse({
      message,
      routerDecision,
      cachedVisionResult: memory.lastVisionResult,
      activeResource: memory.lastActiveResource,
    });
    if (cachedResponse) {
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
        response: cachedResponse,
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
    const { response, safeResource, visionResult, usedMetadataFirst } = await buildRoutedVisionResponse({
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
          modelMode: 'vision',
          needsPdfVision: true,
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
      lastVisionResult: visionResult,
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
    mode: 'resource_search',
    needsResourceSearch: true,
    resourceSearchQuery: String(message || '').trim(),
    needsActionFlow: false,
    needsDownload: false,
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
    return handleBankingActionMode(res, req, ai, finalPayload, fileContext, trace);
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
      isPdfFileReference(
        resolvedResourceContext.fileUrl,
        resolvedResourceContext.contentType,
      ) &&
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
      isPdfFileReference(
        resolvedResourceContext.fileUrl,
        resolvedResourceContext.contentType,
      ) &&
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
    const memory = getAgentMemory({ userId: req.user.id, threadId });
    logArchitecture('memory', {
      requestId: trace.requestId,
      threadId: trace.threadId,
      userId: trace.userId,
      memoryLoaded: Boolean(memory),
      recentMessageCount: memory.recentMessages?.length || 0,
      lastActiveResourceTitle: memory.lastActiveResource?.title || null,
      resourceHistoryCount: memory.resourceHistory?.length || 0,
      cache: memory.lastVisionResult ? 'hit' : 'miss',
    });
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
      if (res.headersSent) {
        return resourceFirstResponse;
      }
      return sendRoutedResponse({
        res,
        req,
        threadId,
        trace,
        message,
        routerDecision: {
          ...deterministicRouterDecision,
          resourceFirst: true,
        },
        response: resourceFirstResponse,
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
    });
    const routerDecision = plannerDecision
      ? buildPlannerRouterDecision({
          plannerDecision,
          deterministicDecision: deterministicRouterDecision,
          message,
        })
      : buildPlannerParseFallbackDecision(message, deterministicRouterDecision);
    logAgentStep(trace.requestId, 'planner_decision_applied', {
      plannerAvailable: Boolean(plannerDecision),
      fallbackUsed: plannerDecision ? false : 'safe_resource_search',
      plannerError: plannerError ? plannerError.message : null,
      mode: routerDecision.plannerDecision?.mode || plannerDecision?.mode || null,
      selectedCase: routerDecision.case,
      needsResourceSearch: routerDecision.needsResourceSearch,
      resourceSearchQueryLength: String(
        routerDecision.plannerDecision?.resourceSearchQuery || routerDecision.resourceHint || '',
      ).length,
      needsActionFlow: routerDecision.needsActionFlow,
      reasonLength: String(routerDecision.reason || '').length,
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
    buildPdfDownloadAction,
    buildPlannerResourceNoMatchResponse,
    buildResourceMetadataResponse,
    buildResourceMemoryFollowupResponse,
    buildWidgetFileAnalysisDisabledRouterDecision,
    classifyResourceResponseStyle,
    getWidgetBlockedFileAnalysisReason,
    shouldPrepareActionFromMatchedResource,
    RESPONSE_STYLES,
  },
  analyzeChatMessage,
  handleChatMessage,
  handleChatMessageWithFiles,
};
