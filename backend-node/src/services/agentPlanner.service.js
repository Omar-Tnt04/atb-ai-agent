'use strict';

// Deterministic agent planner. Runs after withRequestContext.
// Converts req._intentClass + req._requestContext into req._agentPlan.
// Does NOT execute the plan and does NOT change routing.

// ─── Route config table ───────────────────────────────────────────────────────
// Each entry describes how the system WOULD handle this intent if routing is unchanged.
// find_document splits by mode (ask vs act).

const _ROUTES = {
  answer_current_page: {
    selectedRoute: 'site_context',
    executorType: 'ask_retrieval',
    steps: ['extract_page_context', 'build_answer'],
    requiredEvidence: ['site_context_dom'],
    fallbackRoute: 'site_index',
  },
  summarize_page: {
    selectedRoute: 'site_context',
    executorType: 'ask_retrieval',
    steps: ['extract_page_context', 'summarize_content'],
    requiredEvidence: ['site_context_dom'],
    fallbackRoute: 'site_index',
  },
  scroll_or_highlight: {
    selectedRoute: 'dom_inspect',
    executorType: 'dom_action',
    steps: ['read_page_snapshot', 'resolve_element', 'execute_dom_action'],
    requiredEvidence: ['page_snapshot'],
    fallbackRoute: 'site_context',
  },
  answer_from_site: {
    selectedRoute: 'site_index',
    executorType: 'ask_retrieval',
    steps: ['search_site_index', 'build_answer'],
    requiredEvidence: ['site_index_content'],
    fallbackRoute: 'catalog_search',
  },
  find_document_ask: {
    selectedRoute: 'site_index_document',
    executorType: 'document_resolver',
    steps: ['search_site_index', 'score_document_links', 'return_download_url'],
    requiredEvidence: ['document_download_url'],
    fallbackRoute: 'browser_document',
  },
  find_document_act: {
    selectedRoute: 'site_index_document',
    executorType: 'site_index_navigator',
    steps: ['parse_intent', 'search_downloads_index', 'navigate_then_download'],
    requiredEvidence: ['document_download_url'],
    fallbackRoute: 'suggestions',
  },
  open_page: {
    selectedRoute: 'site_index_page',
    executorType: 'site_index_navigator',
    steps: ['parse_intent', 'search_pages_index', 'navigate'],
    requiredEvidence: ['page_url'],
    fallbackRoute: 'suggestions',
  },
  complex_browser_task: {
    selectedRoute: 'site_index',
    executorType: 'site_index_navigator',
    steps: ['parse_intent', 'search_indexes', 'navigate'],
    requiredEvidence: ['page_url'],
    fallbackRoute: 'suggestions',
  },
  blocked_sensitive_action: {
    selectedRoute: 'safety_blocked',
    executorType: 'blocked',
    steps: [],
    requiredEvidence: [],
    fallbackRoute: 'blocked',
  },
  unclear: {
    selectedRoute: 'catalog_search',
    executorType: 'ask_retrieval',
    steps: ['search_catalog', 'plan_intent_with_ollama', 'build_answer'],
    requiredEvidence: ['catalog_resource', 'planner_intent'],
    fallbackRoute: 'general_answer',
  },
};

// ─── Goal description ─────────────────────────────────────────────────────────

const _buildUnderstoodGoal = (intentType, target, message, mode) => {
  const t = target ? `"${target.slice(0, 50)}"` : null;
  switch (intentType) {
    case 'find_document':
      return t ? `Retrieve document: ${t}` : 'Find a document or form on ATB website';
    case 'answer_current_page':
      return 'Answer question from currently open page';
    case 'summarize_page':
      return 'Summarize the currently open page';
    case 'scroll_or_highlight':
      return t ? `Inspect page element: ${t}` : 'Inspect or highlight a page element';
    case 'answer_from_site':
      return t ? `Get site information: ${t}` : 'Get information from ATB website';
    case 'open_page':
      return t ? `Navigate to: ${t}` : 'Navigate to a page on ATB website';
    case 'complex_browser_task':
      return t ? `Complete task: ${t}` : 'Complete a multi-step browser task';
    case 'blocked_sensitive_action':
      return 'Sensitive action — not allowed';
    default:
      return String(message || '').trim().slice(0, 80) || 'Unclear request';
  }
};

// ─── Confidence derivation ────────────────────────────────────────────────────
// Caps at 0.95 — deterministic planner never claims full certainty.
// Reduces when preconditions for the selected route are missing.

const _computeConfidence = (intentType, baseConf, hasPageCtx, isActMode) => {
  const capped = Math.min(Number(baseConf) || 0.30, 0.95);

  // Current-page or summarize intents need live page context to succeed
  if (['answer_current_page', 'summarize_page'].includes(intentType) && !hasPageCtx) {
    return Math.max(capped * 0.80, 0.30);
  }

  // Browser intents in ask mode will be redirected — plan is still valid but describes ask-mode behavior
  if (['complex_browser_task', 'open_page'].includes(intentType) && !isActMode) {
    return Math.max(capped * 0.85, 0.30);
  }

  return capped;
};

// ─── Main builder ─────────────────────────────────────────────────────────────

/**
 * Builds a deterministic agent plan from req._intentClass and req._requestContext.
 * Pure function — no I/O, no side effects.
 *
 * @param {import('express').Request} req
 * @returns {object}
 */
const buildAgentPlan = (req) => {
  const intentClass = req._intentClass || null;
  const requestContext = req._requestContext || null;

  const intentType = intentClass?.type || 'unclear';
  const mode = requestContext?.mode || String(req.body?.mode || 'ask').toLowerCase();
  const isActMode = mode === 'act';
  const hasPageCtx = Boolean(requestContext?.currentPage?.url);
  const target = intentClass?.target || '';
  const message = requestContext?.message || String(req.body?.message || '');

  // Resolve route config — find_document depends on mode
  let routeKey = intentType;
  if (intentType === 'find_document') {
    routeKey = isActMode ? 'find_document_act' : 'find_document_ask';
  }
  const route = _ROUTES[routeKey] || _ROUTES.unclear;

  const confidence = _computeConfidence(intentType, intentClass?.confidence, hasPageCtx, isActMode);
  const allowed = intentType !== 'blocked_sensitive_action';

  return {
    understoodGoal: _buildUnderstoodGoal(intentType, target, message, mode),
    selectedRoute: route.selectedRoute,
    executorType: route.executorType,
    steps: [...route.steps],
    requiredEvidence: [...route.requiredEvidence],
    fallbackRoute: route.fallbackRoute,
    confidence,
    allowed,
    reason: intentClass?.reason || 'No strong pattern matched; using catalog fallback.',
  };
};

module.exports = { buildAgentPlan };
