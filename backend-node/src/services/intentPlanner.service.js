const { CASES } = require('./agentCaseRouter.service');

const PLANNER_MODES = new Set([
  'resource_qa',
  'resource_document',
  'banking_action',
  'resource_search',
  'natural_chat',
  'clarification',
]);

const PRESERVED_DETERMINISTIC_CASES = new Set([
  CASES.UNSAFE_REQUEST,
  CASES.MEMORY_CONTINUE,
  CASES.EXPLICIT_PAGE_QUESTION,
]);

const ACTION_TYPE_MAP = {
  bill_payment: 'pay_bill',
  pay_bill: 'pay_bill',
  transfer: 'make_transfer',
  make_transfer: 'make_transfer',
  appointment: 'book_appointment',
  appointment_booking: 'book_appointment',
  book_appointment: 'book_appointment',
  complaint: 'create_complaint',
  create_complaint: 'create_complaint',
  balance: 'check_balance',
  balance_check: 'check_balance',
  check_balance: 'check_balance',
  document_generation: 'generate_document',
  generate_document: 'generate_document',
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

const normalizePlannerDecision = (data = {}) => {
  const mode = cleanString(data.mode);
  if (!PLANNER_MODES.has(mode)) {
    throw new Error('Invalid planner mode');
  }

  const confidence = Number(data.confidence);
  return {
    mode,
    needsResourceSearch: Boolean(data.needsResourceSearch),
    resourceSearchQuery: cleanString(data.resourceSearchQuery),
    needsActionFlow: mode === 'banking_action' || Boolean(data.needsActionFlow),
    needsDownload: Boolean(data.needsDownload),
    actionType: cleanString(data.actionType),
    actionName: ACTION_TYPE_MAP[normalizeText(data.actionType)] || null,
    userGoal: cleanString(data.userGoal),
    confidence: Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0,
    reason: cleanString(data.reason),
  };
};

const buildSafeFallbackPlannerDecision = (message = '') => ({
  mode: 'resource_search',
  needsResourceSearch: true,
  resourceSearchQuery: String(message || '').trim(),
  needsActionFlow: false,
  needsDownload: false,
  actionType: null,
  actionName: null,
  userGoal: String(message || '').trim() || null,
  confidence: 0.35,
  reason: 'Planner failed; falling back to generic resource search.',
});

const appearsToNeedResourceLookup = (message = '') => {
  const text = normalizeText(message);
  if (!text) return false;

  const asksAboutOwnData = /\b(my|mine|me|i have|do i have)\b/.test(text);
  const asksForExistingThing =
    /\b(show|open|download|view|get|find|search|list|retrieve|fetch|status|details?|summary)\b/.test(text);
  const bankInformationTarget =
    /\b(document|form|receipt|certificate|request|appointment|payment|transfer|account|card|branch|product|statement|bill|record|file|pdf|saved information|profile)\b/.test(text);

  return (
    /\bhow\s+(do|can)\s+i\s+activate\b/.test(text) ||
    /\bactivation\s+(guide|steps|process)\b/.test(text) ||
    (asksAboutOwnData && bankInformationTarget) ||
    (asksForExistingThing && bankInformationTarget)
  );
};

const fallbackResourceQuery = (message = '') => {
  const text = String(message || '').trim();
  const normalized = normalizeText(text);

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

  const resourceHint =
    plannerDecision.resourceSearchQuery ||
    (plannerDecision.needsResourceSearch ? fallbackResourceQuery(message) : null);
  const reason = plannerDecision.reason ||
    `Planner selected ${plannerDecision.mode}.`;
  const common = {
    modelMode: 'text',
    needsResourceSearch: plannerDecision.needsResourceSearch,
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

  if (plannerDecision.mode === 'banking_action') {
    return {
      ...common,
      case: CASES.BANKING_ACTION,
      needsActionFlow: true,
      needsResourceSearch: Boolean(resourceHint),
    };
  }

  if (plannerDecision.mode === 'resource_document') {
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
      case: CASES.LARAGON_PDF_VISION,
      modelMode: 'vision',
      needsResourceSearch: true,
      needsPdfVision: true,
    };
  }

  if (plannerDecision.mode === 'natural_chat') {
    return {
      ...common,
      case: CASES.GENERAL_NATURAL_CHAT,
      needsResourceSearch: false,
      needsPdfVision: false,
      needsActionFlow: false,
      resourceHint: null,
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
};

const buildPlannerParseFallbackDecision = (message, deterministicDecision) => {
  const fallbackPlannerDecision = buildSafeFallbackPlannerDecision(message);
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
  return {
    decision: plannerDecision.needsResourceSearch
      ? 'search_resource'
      : action
        ? 'prepare_action'
        : 'answer_directly',
    intent: action || plannerDecision.mode || 'unknown',
    resourceQuery: plannerDecision.resourceSearchQuery ||
      (plannerDecision.needsResourceSearch ? fallbackResourceQuery(message) : null),
    action,
    fields: {},
    missingFields: [],
    clarificationQuestion: null,
    quickActions: [],
  };
};

module.exports = {
  appearsToNeedResourceLookup,
  buildPlannerParseFallbackDecision,
  buildPlannerRouterDecision,
  buildSafeFallbackPlannerDecision,
  normalizePlannerDecision,
  plannerDecisionToAiDecision,
};
