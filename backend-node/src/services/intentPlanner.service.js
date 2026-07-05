const { CASES, hasResourceObjectDetected, isComplaintStatusEligible } = require('./agentCaseRouter.service');

const PLANNER_MODES = new Set([
  'resource_qa',
  'resource_document',
  'banking_action',
  'resource_search',
  'natural_chat',
  'clarification',
]);

const PLANNER_INTENT_TYPES = new Set([
  'resource_qa',
  'document_show',
  'action_prepare',
  'multi_resource_search',
  'account_balance',
  'clarification',
  'no_match',
]);

const INTENT_TYPE_TO_MODE = {
  resource_qa: 'resource_qa',
  document_show: 'resource_document',
  action_prepare: 'banking_action',
  multi_resource_search: 'resource_search',
  account_balance: 'banking_action',
  clarification: 'clarification',
  no_match: 'natural_chat',
};

const PRESERVED_DETERMINISTIC_CASES = new Set([
  CASES.UNSAFE_REQUEST,
  CASES.MEMORY_CONTINUE,
  CASES.EXPLICIT_PAGE_QUESTION,
]);

const ACTION_TYPE_MAP = {
  none: null,
  bill_payment: 'pay_bill',
  'bill payment': 'pay_bill',
  pay_bill: 'pay_bill',
  'pay bill': 'pay_bill',
  transfer: 'make_transfer',
  make_transfer: 'make_transfer',
  'make transfer': 'make_transfer',
  appointment: 'book_appointment',
  appointment_booking: 'book_appointment',
  'appointment booking': 'book_appointment',
  book_appointment: 'book_appointment',
  'book appointment': 'book_appointment',
  complaint: 'create_complaint',
  check_complaint_status: 'check_complaint_status',
  'check complaint status': 'check_complaint_status',
  complaint_status: 'check_complaint_status',
  'complaint status': 'check_complaint_status',
  create_complaint: 'create_complaint',
  'create complaint': 'create_complaint',
  balance: 'check_balance',
  balance_check: 'check_balance',
  'balance check': 'check_balance',
  check_balance: 'check_balance',
  'check balance': 'check_balance',
  document_generation: 'generate_document',
  'document generation': 'generate_document',
  generate_document: 'generate_document',
  'generate document': 'generate_document',
  cancel: 'cancel',
  reset: 'reset',
};

const normalizeText = (value = '') =>
  String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const cleanString = (value) => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
};

// Hard lexical guard: a retrieval verb (download/open/view/get/show/fetch/retrieve/access) paired
// with a document noun (statement/PDF/certificate/receipt/document/report/form/sheet/policy/notice)
// is ALWAYS an existing-resource retrieval — never document generation. This protects the
// RESOURCE_DOWNLOAD route from a Python planner that mis-classifies it as a banking action.
// An explicit generation verb (generate/create/produce/issue/prepare/new) disqualifies it so that
// "Generate a new account statement" still flows to the action/generation path.
const RETRIEVAL_VERB = /\b(download|open|view|get|show|fetch|retrieve|access|provide|share)\b/;
const DOCUMENT_NOUN = /\b(statement|pdf|certificate|receipt|document|report|form|sheet|policy|notice|invoice)\b/;
const GENERATION_VERB = /\b(generate|create|produce|issue|make|prepare|new)\b/;

// "What/which documents do I need" (or "required documents for ...") is a CONTENT question about a
// checklist — answered as resource QA — even though it contains a retrieval-like verb (e.g. "open an
// account") and the noun "document". It is not a request to download a specific file.
const REQUIRED_DOCUMENTS_CONTENT_QUESTION = /\bdocuments?\b/;
const isRequiredDocumentsContentQuestion = (text = '') =>
  REQUIRED_DOCUMENTS_CONTENT_QUESTION.test(text) &&
  /\b(need|needed|require|required|necessary|do i need|must i)\b/.test(text);

const isResourceRetrievalDownloadRequest = (message = '') => {
  const text = normalizeText(message);
  if (!text) return false;
  if (GENERATION_VERB.test(text)) return false;
  if (isRequiredDocumentsContentQuestion(text)) return false;
  return RETRIEVAL_VERB.test(text) && DOCUMENT_NOUN.test(text);
};

const normalizePlannerDecision = (data = {}) => {
  const rawIntentType = cleanString(data.intentType);
  const intentType = PLANNER_INTENT_TYPES.has(rawIntentType)
    ? rawIntentType
    : null;
  const mode = intentType
    ? INTENT_TYPE_TO_MODE[intentType]
    : cleanString(data.mode);
  if (!PLANNER_MODES.has(mode)) {
    throw new Error('Invalid planner mode');
  }

  const confidence = Number(data.confidence);
  const actionType = cleanString(data.actionType);
  const resourceQuery = cleanString(data.resourceQuery) || cleanString(data.resourceSearchQuery);
  const resourceNeed = intentType
    ? Boolean(data.resourceNeed)
    : Boolean(data.needsResourceSearch);
  const isActionIntent = intentType === 'action_prepare' || intentType === 'account_balance' || mode === 'banking_action';
  const actionName = intentType === 'account_balance'
    ? 'check_balance'
    : ACTION_TYPE_MAP[normalizeText(actionType)] || null;
  const needsDownload = intentType
    ? Boolean(data.needsDownload || intentType === 'document_show')
    : Boolean(data.needsDownload);
  return {
    intentType: intentType || ({
      resource_qa: 'resource_qa',
      resource_document: 'document_show',
      banking_action: 'action_prepare',
      resource_search: 'multi_resource_search',
      natural_chat: 'no_match',
      clarification: 'clarification',
    }[mode] || 'no_match'),
    mode,
    resourceNeed,
    needsResourceSearch: resourceNeed,
    resourceQuery,
    resourceSearchQuery: resourceQuery,
    resourceCategoryHint: cleanString(data.resourceCategoryHint),
    needsVision: Boolean(data.needsVision),
    needsActionFlow: isActionIntent || Boolean(data.needsActionFlow),
    needsDownload,
    actionType: actionType && normalizeText(actionType) !== 'none' ? actionType : null,
    actionName,
    missingFields: Array.isArray(data.missingFields)
      ? data.missingFields.filter((field) => typeof field === 'string' && field.trim()).map((field) => field.trim())
      : [],
    userGoal: cleanString(data.userGoal),
    confidence: Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0,
    reason: cleanString(data.reason),
  };
};

const isCardPaymentObligationQuestion = (message = '') => {
  const text = normalizeText(message);
  return (
    /\bcard\b/.test(text) &&
    (
      /\b(still\s+)?(?:have|need)\s+to\s+pay\b/.test(text) ||
      /\bpay\s+(?:something|anything)\b/.test(text) ||
      /\banything\s+to\s+pay\b/.test(text) ||
      /\bnothing\s+to\s+pay\b/.test(text) ||
      /\bowe\b/.test(text) ||
      /\bminimum\s+payment\b/.test(text)
    )
  );
};

const isSmeAccountOpeningChecklistQuestion = (message = '') => {
  const text = normalizeText(message);
  if (!text) return false;

  const asksDocuments =
    /\bdocuments?\s+(?:are\s+)?required\b/.test(text) ||
    /\brequired\s+documents?\b/.test(text) ||
    /\bdocuments?\b.{0,50}\b(?:need|needed|required|necessary|must)\b/.test(text) ||
    /\b(?:need|needed|required|necessary|must)\b.{0,50}\bdocuments?\b/.test(text) ||
    /\bchecklist\b/.test(text);
  const isOpeningContext =
    /\bopen(?:ing)?\b.{0,40}\b(?:sme|business|small business)\s+account\b/.test(text) ||
    /\b(?:sme|business|small business)\s+account\b.{0,40}\bopen(?:ing)?\b/.test(text) ||
    /\baccount\s+opening\b/.test(text);
  const isSmeDocumentQuery =
    /\b(?:sme|business|small business)\s+account\b/.test(text) && asksDocuments;
  const namesChecklistField =
    /\b(business\s+registration|tax\s+id\s+certificate|owner\s+cin|proof\s+of\s+address)\b/.test(text);

  return namesChecklistField || (asksDocuments && isOpeningContext) || isSmeDocumentQuery;
};

const normalizePlannerResourceHint = (message = '', resourceHint = null) => {
  if (isSmeAccountOpeningChecklistQuestion(message)) {
    return 'SME Account Opening Checklist';
  }
  return resourceHint;
};

const buildSafeFallbackPlannerDecision = (message = '') => {
  const fallbackQuery = isCardPaymentObligationQuestion(message)
    ? 'card payment due'
    : isSmeAccountOpeningChecklistQuestion(message)
    ? 'SME Account Opening Checklist'
    : String(message || '').trim();
  return {
    intentType: 'multi_resource_search',
    mode: 'resource_search',
    resourceNeed: true,
    needsResourceSearch: true,
    resourceQuery: fallbackQuery,
    resourceSearchQuery: fallbackQuery,
    resourceCategoryHint: null,
    needsVision: false,
    needsActionFlow: false,
    needsDownload: false,
    actionType: null,
    actionName: null,
    missingFields: [],
    userGoal: String(message || '').trim() || null,
    confidence: 0.35,
    reason: 'Planner failed; falling back to generic resource search.',
  };
};

const appearsToNeedResourceLookup = (message = '') => {
  const text = normalizeText(message);
  if (!text) return false;

  const asksAboutOwnData = /\b(my|mine|me|i have|do i have)\b/.test(text);
  const asksForExistingThing =
    /\b(show|open|download|view|get|find|search|list|retrieve|fetch|status|details?|summary)\b/.test(text);
  const bankInformationTarget =
    /\b(document|form|receipt|certificate|request|appointment|payment|transfer|account|card|branch|product|statement|bill|record|file|pdf|saved information|profile|notice|guide|policy)\b/.test(text);

  return (
    /\bhow\s+(do|can)\s+i\s+activate\b/.test(text) ||
    /\bactivation\s+(guide|steps|process)\b/.test(text) ||
    /\bwhat\s+does\b.{0,80}\b(notice|guide|document|resource|policy)\b.{0,80}\b(recommend|say|show|contain)\b/.test(text) ||
    (asksAboutOwnData && bankInformationTarget) ||
    (asksForExistingThing && bankInformationTarget)
  );
};

const fallbackResourceQuery = (message = '') => {
  const text = String(message || '').trim();
  const normalized = normalizeText(text);

  if (isCardPaymentObligationQuestion(normalized)) {
    return 'card payment due';
  }
  if (isSmeAccountOpeningChecklistQuestion(normalized)) {
    return 'SME Account Opening Checklist';
  }
  if (
    /\b(checkbook|chequebook)\b/.test(normalized) &&
    /\b(when|ready|available|pick\s+up|pickup|collect|status|preparation|prepared)\b/.test(normalized)
  ) {
    return 'checkbook ready date';
  }
  if (
    /\bcard\b/.test(normalized) &&
    /\b(pick\s+up|pickup|appointment|collect)\b/.test(normalized)
  ) {
    return 'card pickup appointment';
  }

  const activation = normalized.match(/\bhow\s+(?:do|can)\s+i\s+activate\s+(.+)$/);
  if (activation?.[1]) return `activation guide for ${activation[1]}`;

  const status = normalized.match(/\bstatus\s+(?:of|for)\s+(?:my\s+)?(.+)$/) ||
    normalized.match(/\bwhat\s+is\s+the\s+status\s+(?:of|for)\s+(?:my\s+)?(.+)$/);
  if (status?.[1]) return `status of ${status[1]}`;

  const appointment = normalized.match(/\bdo\s+i\s+have\s+(?:an?\s+)?appointment\s+(?:for|about)\s+(.+)$/);
  if (appointment?.[1]) return `appointment for ${appointment[1]}`;

  const showMine = normalized.match(/\b(?:show|open|download|view|get|retrieve)\s+(?:me\s+)?(?:my\s+)?(.+)$/);
  if (showMine?.[1]) return showMine[1];

  const related = normalized.match(/\bfind\s+(?:anything|everything|resources?|documents?)\s+related\s+to\s+(.+)$/);
  if (related?.[1]) return related[1];

  return text;
};

const isPureAccountBalanceRequest = (message = '') => {
  const text = normalizeText(message);
  return (
    /\b(balance|solde)\b/.test(text) &&
    /\b(account|accounts|acc\s*\d+|acc_\d+|current|savings|checking)\b/.test(text) &&
    !/\b(limit|notice|receipt|document|statement|certificate|card limit|credit limit|payment due|minimum payment)\b/.test(text)
  );
};

const isPureAccountDetailsRequest = (message = '') => {
  const text = normalizeText(message);
  return (
    (
      /\baccounts?\b.*\b(details?|information|info|summary|status)\b/.test(text) ||
      /\b(details?|information|info|summary|status)\b.*\baccounts?\b/.test(text) ||
      /\b(show|view|give|get|display|list)\b.*\bmy\s+(current|savings|checking|main|primary)?\s*accounts?\b/.test(text)
    ) &&
    !/\b(card|credit|limit|notice|receipt|document|statement|certificate|payment due|minimum payment)\b/.test(text)
  );
};

const isCardResourceQuestion = (message = '') => {
  const text = normalizeText(message);
  if (!text) return false;

  return (
    /\b(?:credit\s+card|card)\b.{0,50}\b(?:current\s+)?limit\b/.test(text) ||
    /\b(?:current\s+|available\s+)?limit\b.{0,50}\b(?:credit\s+card|card)\b/.test(text) ||
    /\bavailable\s+(?:card\s+)?limit\b/.test(text) ||
    /\b(?:credit\s+card|card)\b.{0,50}\bpayment\s+due(?:\s+date)?\b/.test(text) ||
    /\bpayment\s+due(?:\s+date)?\b.{0,50}\b(?:credit\s+card|card)\b/.test(text) ||
    /\b(?:credit\s+card|card)\b.{0,50}\bminimum\s+payment\b/.test(text) ||
    /\bminimum\s+payment\b.{0,50}\b(?:credit\s+card|card)\b/.test(text) ||
    isCardPaymentObligationQuestion(text) ||
    /\bcard\s+notice\b/.test(text)
  );
};

const isResourceLikeQuestion = (message = '') => {
  const text = normalizeText(message);
  if (!text) return false;

  return (
    isCardResourceQuestion(text) ||
    /\b(notice|receipt|certificate|bill|dispute|appointment|product\s+sheet|security\s+recommendation|security\s+notice|request\s+status|document|pdf|file|form|statement|policy|checkbook|chequebook)\b/.test(text) ||
    /\b(card\s+pickup|pick\s+up\s+my\s+card|pick\s+up\s+my\s+new\s+checkbook|checkbook\s+ready|chequebook\s+ready)\b/.test(text) ||
    /\bstatus\b.{0,60}\b(request|complaint|dispute|replacement|checkbook|chequebook|appointment|transfer)\b/.test(text) ||
    /\b(request|complaint|dispute|replacement|checkbook|chequebook|appointment|transfer)\b.{0,60}\bstatus\b/.test(text) ||
    /\bwhat\s+does\b.{0,80}\b(notice|guide|document|resource|policy)\b.{0,80}\b(recommend|say|show|contain)\b/.test(text) ||
    /\b(show|open|get|find|view|retrieve|download)\b.{0,80}\b(atm|receipt|notice|certificate|appointment|request|document|product|sheet)\b/.test(text)
  );
};

const shouldRouteAccountPlannerToResource = (message = '', plannerDecision = {}) => {
  if (plannerDecision.intentType !== 'account_balance') return false;
  if (isPureAccountBalanceRequest(message)) return false;
  if (isPureAccountDetailsRequest(message)) return false;

  const text = normalizeText([
    message,
    plannerDecision.resourceSearchQuery,
    plannerDecision.resourceQuery,
    plannerDecision.userGoal,
  ].filter(Boolean).join(' '));

  return (
    isResourceLikeQuestion(text) ||
    /\b(card|credit|debit)\b.{0,40}\blimit\b/.test(text) ||
    /\blimit\b.{0,40}\b(card|credit|debit)\b/.test(text) ||
    /\b(available limit|payment due|minimum payment|statement date|card notice|notice|receipt|document|certificate|statement|request|appointment|dispute|product sheet|security recommendation)\b/.test(text)
  );
};

const shouldPreserveStrongResourceRoute = (message = '', plannerDecision = {}, deterministicDecision = {}) => {
  if (!deterministicDecision.needsResourceSearch) return false;
  if (isPureAccountBalanceRequest(message) || isPureAccountDetailsRequest(message)) return false;
  if (plannerDecision.mode !== 'banking_action' && plannerDecision.intentType !== 'account_balance') return false;

  const deterministicResourceRoute =
    deterministicDecision.case === CASES.LARAGON_RESOURCE_METADATA ||
    deterministicDecision.case === CASES.RESOURCE_DOWNLOAD ||
    deterministicDecision.case === CASES.LARAGON_PDF_VISION;

  // Description-first priority. The deterministic router only emits a strong
  // resource route after it has already rejected explicit action commands and
  // complaint queries. So when it points at a resource AND the message names a
  // concrete banking object (checkbook, card pickup, receipt, ...) that is not a
  // complaint, the catalog must be searched before any planner/LLM banking-action
  // guess wins — regardless of which action the planner guessed. This stops a
  // misclassified "check_complaint_status"/"create_complaint"/"appointment" from
  // hijacking a resource-object question.
  if (
    deterministicResourceRoute &&
    hasResourceObjectDetected(message) &&
    !isComplaintStatusEligible(message)
  ) {
    return true;
  }

  const actionName = plannerDecision.actionName || null;
  // Narrow fallback for account-balance-style overrides that carry no concrete
  // resource object: only no-op / check_balance actions may be redirected to a
  // resource route, and only when the request actually looks resource-like.
  const isAllowedOverride = ['check_balance', null].includes(actionName);
  if (!isAllowedOverride) return false;

  return deterministicResourceRoute || isResourceLikeQuestion(message);
};

const buildPlannerRouterDecision = ({
  plannerDecision,
  deterministicDecision,
  message,
}) => {
  if (PRESERVED_DETERMINISTIC_CASES.has(deterministicDecision.case)) {
    return {
      ...deterministicDecision,
      plannerDecision,
      plannerApplied: false,
      plannerApplyReason: 'Preserved deterministic safety, memory, or PDF follow-up route.',
    };
  }

  if (
    [CASES.RESOURCE_MEMORY_FOLLOWUP, CASES.PDF_FOLLOWUP].includes(deterministicDecision.case) &&
    !plannerDecision.needsResourceSearch &&
    !plannerDecision.resourceSearchQuery
  ) {
    return {
      ...deterministicDecision,
      plannerDecision,
      plannerApplied: false,
      plannerApplyReason: 'Preserved vague resource-memory follow-up route.',
    };
  }

  if (
    deterministicDecision.needsResourceSearch &&
    !plannerDecision.needsResourceSearch &&
    !plannerDecision.needsActionFlow &&
    ['clarification', 'natural_chat'].includes(plannerDecision.mode)
  ) {
    return {
      ...deterministicDecision,
      plannerDecision,
      plannerApplied: false,
      plannerApplyReason: 'Preserved deterministic resource search before generic planner fallback.',
    };
  }

  // When the deterministic router detected a retrieval/download request (download, open, get,
  // view, show … document/PDF) and the Python planner tries to reclassify it as a banking
  // action (e.g. generate_document / action_prepare), keep the download route.
  // buildResourceDownloadResponse handles both the "PDF found → Download" and
  // "no PDF found → not found message" outcomes correctly — it never asks for account/period
  // unless isStatementGenerationRequest returns true (which requires an explicit generation verb).
  const plannerWantsAction =
    plannerDecision.mode === 'banking_action' || plannerDecision.intentType === 'action_prepare';
  if (
    plannerWantsAction &&
    (deterministicDecision.case === CASES.RESOURCE_DOWNLOAD ||
      isResourceRetrievalDownloadRequest(message))
  ) {
    // Force the download/retrieval route even if the deterministic case differed: a retrieval verb
    // + document noun must fetch the existing resource, not enter statement/document generation.
    return {
      ...deterministicDecision,
      case: CASES.RESOURCE_DOWNLOAD,
      needsResourceSearch: true,
      needsActionFlow: false,
      plannerDecision,
      plannerApplied: false,
      plannerApplyReason:
        'Hard guard: retrieval verb + document noun => RESOURCE_DOWNLOAD; planner banking-action override rejected.',
    };
  }

  const rawResourceHint =
    plannerDecision.resourceSearchQuery ||
    (plannerDecision.needsResourceSearch || plannerDecision.intentType === 'no_match' || plannerDecision.confidence < 0.45
      ? fallbackResourceQuery(message)
      : null);
  const resourceHint = normalizePlannerResourceHint(message, rawResourceHint);
  const reason = plannerDecision.reason ||
    `Planner selected ${plannerDecision.intentType || plannerDecision.mode}.`;
  const fallbackSearchBeforeNoMatch =
    plannerDecision.intentType === 'no_match' || plannerDecision.confidence < 0.45;
  const common = {
    modelMode: 'text',
    needsResourceSearch: plannerDecision.needsResourceSearch || fallbackSearchBeforeNoMatch,
    needsPdfVision: false,
    needsActionFlow: plannerDecision.needsActionFlow,
    needsMemory: true,
    resourceHint,
    detailHint: plannerDecision.userGoal,
    explicitPage: deterministicDecision.explicitPage || null,
    safetyDecision: deterministicDecision.safetyDecision || 'allowed',
    resourceMemoryMatch: deterministicDecision.resourceMemoryMatch || null,
    reason,
    plannerDecision,
    plannerApplied: true,
  };

  if (shouldPreserveStrongResourceRoute(message, plannerDecision, deterministicDecision)) {
    const query = deterministicDecision.resourceHint || resourceHint || fallbackResourceQuery(message);
    return {
      ...common,
      case: CASES.LARAGON_RESOURCE_METADATA,
      modelMode: 'text',
      needsResourceSearch: true,
      needsPdfVision: false,
      needsActionFlow: false,
      resourceHint: query,
      plannerDecision: {
        ...plannerDecision,
        intentType: 'resource_qa',
        mode: 'resource_qa',
        resourceNeed: true,
        needsResourceSearch: true,
        needsActionFlow: false,
        actionType: null,
        actionName: null,
        resourceQuery: query,
        resourceSearchQuery: query,
        reason: plannerDecision.reason || 'Banking-action planner result overridden by a strong resource route.',
      },
      reason: 'A strong resource route matched before account clarification.',
    };
  }

  if (shouldRouteAccountPlannerToResource(message, plannerDecision)) {
    return {
      ...common,
      case: CASES.LARAGON_RESOURCE_METADATA,
      modelMode: 'text',
      needsResourceSearch: true,
      needsPdfVision: false,
      needsActionFlow: false,
      resourceHint: resourceHint || fallbackResourceQuery(message),
      plannerDecision: {
        ...plannerDecision,
        intentType: 'resource_qa',
        mode: 'resource_qa',
        resourceNeed: true,
        needsResourceSearch: true,
        needsActionFlow: false,
        actionType: null,
        actionName: null,
        resourceQuery: resourceHint || fallbackResourceQuery(message),
        resourceSearchQuery: resourceHint || fallbackResourceQuery(message),
        reason: plannerDecision.reason || 'Account planner result overridden by resource-like request.',
      },
      reason: 'Planner selected account balance, but the request matches a stored resource topic.',
    };
  }

  if (plannerDecision.mode === 'banking_action') {
    return {
      ...common,
      case: CASES.BANKING_ACTION,
      needsActionFlow: true,
      needsResourceSearch: plannerDecision.intentType === 'account_balance' ? false : Boolean(resourceHint),
    };
  }

  if (plannerDecision.mode === 'resource_document') {
    // The planner sometimes labels a fact question ("what services are available at Lac 1?") as
    // document_show. Only honour document/download when the user EXPLICITLY asks to retrieve a
    // file (retrieval verb + document noun). Otherwise this is resource QA, and forcing the
    // document/download route would skip the description-analysis answer path.
    if (!isResourceRetrievalDownloadRequest(message)) {
      return {
        ...common,
        case: CASES.LARAGON_RESOURCE_METADATA,
        modelMode: 'text',
        needsResourceSearch: true,
        needsPdfVision: false,
        plannerApplyReason: 'Planner document_show demoted to resource_qa (no explicit file retrieval).',
      };
    }
    return {
      ...common,
      case: plannerDecision.needsDownload
        ? CASES.RESOURCE_DOWNLOAD
        : CASES.LARAGON_RESOURCE_METADATA,
      needsResourceSearch: true,
    };
  }

  if (plannerDecision.mode === 'resource_search') {
    return {
      ...common,
      case: CASES.LARAGON_RESOURCE_METADATA,
      needsResourceSearch: true,
    };
  }

  if (plannerDecision.mode === 'resource_qa') {
    return {
      ...common,
      case: CASES.LARAGON_RESOURCE_METADATA,
      modelMode: 'text',
      needsResourceSearch: true,
      needsPdfVision: false,
    };
  }

  if (plannerDecision.mode === 'natural_chat') {
    if (fallbackSearchBeforeNoMatch) {
      return {
        ...common,
        case: CASES.LARAGON_RESOURCE_METADATA,
        needsResourceSearch: true,
        needsPdfVision: false,
        needsActionFlow: false,
        resourceHint,
      };
    }
    return {
      ...common,
      case: CASES.GENERAL_NATURAL_CHAT,
      needsResourceSearch: false,
      needsPdfVision: false,
      needsActionFlow: false,
      resourceHint: null,
    };
  }

  if (fallbackSearchBeforeNoMatch) {
    return {
      ...common,
      case: CASES.LARAGON_RESOURCE_METADATA,
      needsResourceSearch: true,
      needsPdfVision: false,
      needsActionFlow: false,
      resourceHint: resourceHint || fallbackResourceQuery(message),
    };
  }

  return {
    ...common,
    case: plannerDecision.intentType === 'clarification'
      ? CASES.NORMAL_CHAT
      : CASES.GENERAL_NATURAL_CHAT,
    needsResourceSearch: false,
    needsPdfVision: false,
    needsActionFlow: false,
    resourceHint: null,
  };
};

const buildPlannerParseFallbackDecision = (message, deterministicDecision) => {
  const fallbackPlannerDecision = buildSafeFallbackPlannerDecision(message);
  if (deterministicDecision.case === CASES.BANKING_ACTION && !deterministicDecision.needsResourceSearch) {
    return {
      ...deterministicDecision,
      plannerApplied: false,
      plannerFallbackUsed: true,
      plannerDecision: deterministicDecision.plannerDecision || fallbackPlannerDecision,
      reason: deterministicDecision.reason || fallbackPlannerDecision.reason,
    };
  }
  const deterministicResourceHint = deterministicDecision.needsResourceSearch
    ? deterministicDecision.resourceHint
    : null;
  if (deterministicResourceHint) {
    fallbackPlannerDecision.resourceQuery = deterministicResourceHint;
    fallbackPlannerDecision.resourceSearchQuery = deterministicResourceHint;
  }
  return {
    ...buildPlannerRouterDecision({
      plannerDecision: fallbackPlannerDecision,
      deterministicDecision,
      message,
    }),
    plannerApplied: false,
    plannerFallbackUsed: true,
    plannerDecision: fallbackPlannerDecision,
    reason: fallbackPlannerDecision.reason,
  };
};

const plannerDecisionToAiDecision = (plannerDecision = {}, message = '') => {
  const action = plannerDecision.actionName || null;
  const complaintReference = action === 'check_complaint_status'
    ? String(message || '').match(/\bCMP[-\s]?[A-Z0-9-]*\d[A-Z0-9-]*\b/i)?.[0]?.replace(/\s+/g, '-')
    : null;
  const fields = complaintReference ? { reference: complaintReference } : {};
  const missingFields = Array.isArray(plannerDecision.missingFields)
    ? plannerDecision.missingFields
    : [];
  return {
    decision: action
      ? 'prepare_action'
      : plannerDecision.needsResourceSearch
      ? 'search_resource'
      : 'answer_directly',
    intent: action || plannerDecision.intentType || plannerDecision.mode || 'unknown',
    resourceQuery: plannerDecision.resourceSearchQuery ||
      (plannerDecision.needsResourceSearch ? fallbackResourceQuery(message) : null),
    action,
    fields,
    missingFields: complaintReference
      ? missingFields.filter((field) => field !== 'reference')
      : missingFields,
    clarificationQuestion: null,
    quickActions: [],
  };
};

module.exports = {
  appearsToNeedResourceLookup,
  buildPlannerParseFallbackDecision,
  buildPlannerRouterDecision,
  buildSafeFallbackPlannerDecision,
  isResourceRetrievalDownloadRequest,
  normalizePlannerDecision,
  plannerDecisionToAiDecision,
};
