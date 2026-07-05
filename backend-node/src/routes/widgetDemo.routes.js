const express = require('express');
const path = require('path');

const {
  cancelAgentAction,
  confirmAgentAction,
  executeAgentAction,
  prepareAgentAction,
  verifyAndExecuteAgentAction,
} = require('../controllers/actionExecution.controller');
const { handleChatMessage } = require('../controllers/chat.controller');
const {
  isBrowserAgentTask,
  _routingSignals,
} = require('../services/requestRouting.service');
const {
  checkCdpReachable,
  createDocFastPathJob,
  createPageFastPathJob,
  launchBrowserAgentJob,
  getBrowserAgentJob,
} = require('../services/pageNavigator.service');
const { decideAction } = require('../services/siteIndexAgent.service');
const { buildPagePlan, isPageControlTask, detectGoals } = require('../services/pageControl.service');

// Goals whose intent is a specific document or form — site index takes priority over
// pageControl for these because it has the exact PDF URL, not just the listing page.
const _DOC_INDEX_GOALS = new Set([
  'documents_forms', 'card_request', 'account_opening', 'customer_onboarding', 'complaint_support',
]);
const env = require('../config/env');
const { getGeneratedFile } = require('../services/generatedFile.service');
const { routeTraceMiddleware, isVerboseRequestLog } = require('../services/routeTrace.service');
const { isDemoMode, stepLog, runWithTrace } = require('../utils/demoLogger');
const { createTrace, getTrace, markTraceDone } = require('../services/traceBuffer.service');
const { SOURCE_TYPES, detectSourceType, buildContactFactsAnswer } = require('../services/askRetrieval.service');
const { resolveAskAnswer, isListIntent } = require('../services/askEvidenceResolver.service');
const { classifyIntent } = require('../services/intentPreclassifier.service');
const { buildRequestContext, summarizeRequestContext } = require('../services/requestContextBuilder.service');
const { buildAgentPlan } = require('../services/agentPlanner.service');
const {
  normalizeSiteContext,
  siteContextHasUsefulContent,
  isCurrentPageQuestion,
  isSiteWideQuestion,
  buildSiteContextAnswer,
} = require('../services/siteContext.service');
const {
  getSiteIndex,
  summarizeSiteIndex,
  searchSiteIndex,
  searchDocumentLinks,
  buildSiteIndexAnswer,
  getBestMatchPage,
  getPageLabel,
} = require('../services/siteIndex.service');

const router = express.Router();

const DEMO_USER = {
  id: 'user_client_001',
  demoUserId: 'user_001',
  fullName: 'Omar Tentouch',
  email: 'widget.demo@atb.local',
  role: 'CLIENT',
  phoneNumber: '+21655123456',
  phoneVerified: true,
  accounts: ['acc_001', 'acc_002'],
};

const isWidgetDemoEnabled = () =>
  env.widgetDemoMode || env.nodeEnv !== 'production';

// Development-only route guard for the standalone widget preview.
// This bypasses normal token auth only for synthetic demo data and must not be
// used as a production authentication path.
const widgetDemoGuard = (req, res, next) => {
  if (!isWidgetDemoEnabled()) {
    return res.status(403).json({
      success: false,
      status: 'widget_demo_disabled',
      message: 'Widget demo mode is disabled.',
    });
  }

  req.user = DEMO_USER;
  return next();
};

router.use(widgetDemoGuard);
router.use(routeTraceMiddleware);

// First-line proof that a widget request reached THIS process/handler (before any routing logic).
const logWidgetRequestEntered = (req, res, next) => {
  if (isVerboseRequestLog()) {
    const message = String(req.body?.message || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    console.log(`[WIDGET_REQUEST_ENTERED] message="${message}"`);
  }
  return next();
};

// Per-request trace context: creates a trace buffer entry and propagates the
// traceId through the entire async middleware chain via AsyncLocalStorage.
// Only activated when the client supplies a traceId in the request body.
const withTrace = (req, res, next) => {
  const raw = String(req.body?.traceId || '').trim().slice(0, 64);
  if (!raw || !/^[a-zA-Z0-9_-]+$/.test(raw)) return next();
  req.traceId = raw;
  createTrace(raw);
  res.on('finish', () => {
    if (!req._isBrowserJob) markTraceDone(raw);
  });
  return runWithTrace(raw, next);
};

// Attaches lightweight conversation context to every /chat request so downstream
// handlers and the Python planner can see prior-turn count and last resolved intent
// without re-parsing the full conversationHistory each time.
const withConversationContext = (req, res, next) => {
  const history = Array.isArray(req.body?.conversationHistory) ? req.body.conversationHistory : [];
  const lastIntent = req.body?.cacheContext?.lastIntent || null;
  req._conversationContext = {
    priorTurns: history.slice(-3),
    lastIntent,
  };
  if (!isDemoMode()) {
    console.log(`[CONVERSATION_CONTEXT] priorTurns=${req._conversationContext.priorTurns.length} lastIntent=${lastIntent || 'none'}`);
  }
  return next();
};

// Deterministic intent pre-classification. Sets req._intentClass for every /chat request.
// Does NOT affect routing — observation and future use only.
const withIntentPreclassify = (req, res, next) => {
  const message = String(req.body?.message || '').trim();
  // req.siteContext is not yet normalized at this point; read URL from raw body.
  const siteContextUrl = String(req.body?.siteContext?.url || '');
  req._intentClass = classifyIntent(message, { siteContextUrl });
  const { type, confidence, target } = req._intentClass;
  if (isDemoMode()) {
    const targetStr = target ? ` target="${target.slice(0, 40)}"` : '';
    stepLog('Intent', `${type}${targetStr}`);
  } else {
    const targetStr = target ? ` target="${target.slice(0, 40)}"` : '';
    console.log(`[INTENT_PRECLASSIFY] type=${type} confidence=${confidence.toFixed(2)}${targetStr}`);
  }
  return next();
};

// Assembles req._requestContext from req._intentClass, req._conversationContext,
// and raw siteContext. Does NOT change routing.
const withRequestContext = (req, res, next) => {
  req._requestContext = buildRequestContext(req);
  const summary = summarizeRequestContext(req._requestContext);
  if (isDemoMode()) {
    stepLog('Ctx', summary);
  } else {
    console.log(`[REQUEST_CONTEXT] ${summary}`);
  }
  return next();
};

// Deterministic planner: maps req._intentClass + req._requestContext → req._agentPlan.
// Does NOT execute the plan and does NOT change routing.
const withAgentPlan = (req, res, next) => {
  req._agentPlan = buildAgentPlan(req);
  const { executorType, selectedRoute, confidence } = req._agentPlan;
  if (isDemoMode()) {
    stepLog('Plan', `executor=${executorType} route=${selectedRoute}`);
  } else {
    console.log(`[AGENT_PLAN] executor=${executorType} route=${selectedRoute} confidence=${confidence.toFixed(2)}`);
  }
  return next();
};

// Action-like phrases that should be redirected to Act mode in Ask mode.
const _ASK_MODE_ACTION_RE =
  /\b(open|navigate|go\s+to|find|search|download|show|get|fetch|look\s+for|display|access|visit|browse|click|fill|submit)\b/i;
const _ASK_INFORMATIONAL_RE = /^(?:what|which|who|where|when|why|is|are|does|do|tell me about)\b/i;

const handleBrowserTaskOrDelegate = async (req, res, next) => {
  const message = String(req.body?.message || '').trim();
  if (!message) return next();

  const agentMode = String(req.body?.mode || req.body?.agentMode || 'ask').toLowerCase();
  const isAskMode = agentMode !== 'act';

  const snapshot = req.body?.pageSnapshot || null;
  const hasSnapshot = snapshot && Array.isArray(snapshot.headings);
  const goals = detectGoals(message);

  // PRIORITY 1 — serious document / form / navigation / onboarding / complaint / agency intents.
  // Returns a QUEUED jobId — python NOT spawned yet. Widget persists state, then calls /start.
  const isBrowserAgent = isBrowserAgentTask(message, { goals });
  const sig = _routingSignals(message);

  // Normalize siteContext unconditionally so handleAskRetrieval can use it in all modes.
  const rawSiteCtx = req.body?.siteContext || null;
  req.siteContext = rawSiteCtx ? normalizeSiteContext(rawSiteCtx) : null;

  if (isDemoMode()) {
    // Emit clean User line; Route/Decision are emitted later by the site-index agent.
    stepLog('User', `"${message.slice(0, 80).replace(/"/g, "'")}"`);
    stepLog('Mode', isAskMode ? 'Ask question' : 'Act on site');
    const cacheCtx = req.body?.cacheContext || {};
    if (cacheCtx.contactHit != null) {
      stepLog('Cache', cacheCtx.contactHit ? 'contact info hit' : 'contact info refreshed');
    }
    if (cacheCtx.docIndexHit != null) {
      stepLog('Cache', cacheCtx.docIndexHit ? 'document index hit' : 'document index refreshed');
    }
    const siteCtxUsable = siteContextHasUsefulContent(req.siteContext);
    if (req.siteContext && req.siteContext.url) {
      stepLog('SiteCtx', `url=${req.siteContext.url.slice(0, 60)} title="${req.siteContext.title.slice(0, 40)}" h=${req.siteContext.stats?.headings || 0} links=${req.siteContext.stats?.links || 0} dl=${req.siteContext.stats?.downloadLinks || 0} textLen=${req.siteContext.stats?.textLength || 0} usable=${siteCtxUsable ? 'yes' : 'no'}`);
    } else {
      stepLog('SiteCtx', 'none usable=no');
    }
    const _si = getSiteIndex();
    if (_si && _si.stats) {
      const _pc   = _si.stats.acceptedPages ?? _si.stats.pageCount ?? _si.stats.pagesCrawled ?? (_si.pages || []).length;
      const _docs = _si.stats.documentsFound ?? _si.stats.downloadsFound ?? _si.stats.totalDownloads ?? 0;
      const _acts = _si.stats.documentActionsFound ?? 0;
      stepLog('SiteIndex', `exists=yes pageCount=${_pc} docs=${_docs} docActions=${_acts}`);
    } else {
      stepLog('SiteIndex', 'exists=no');
    }
    // Act mode non-browser → resource catalog. Ask mode Route is emitted by handleAskRetrieval.
    if (!isAskMode && !isBrowserAgent) {
      stepLog('Route', 'resource catalog');
    }
  } else {
    const msgPreview = message.slice(0, 100).replace(/"/g, "'");
    console.log(
      `[ROUTER_DECISION] user_text="${msgPreview}" mode="${agentMode}" ` +
      `siteTarget=${sig.isSiteTarget} siteNav=${sig.isSiteNav} formDocNav=${sig.isFormDocNav} ` +
      `explicitFile=${sig.isExplicitFile} goals=${goals.length} ` +
      `selected_path="${isBrowserAgent && !isAskMode ? 'dom_agent' : 'resource_analysis'}" ` +
      `reason="${isBrowserAgent && !isAskMode ? 'site navigation request' : isAskMode ? 'ask mode' : 'not a site navigation request'}"`,
    );
  }

  // ASK MODE — skip all browser routing; if user asks for a browser action, redirect to Act mode.
  if (isAskMode) {
    if (isBrowserAgent && _ASK_MODE_ACTION_RE.test(message) && !_ASK_INFORMATIONAL_RE.test(message)) {
      return res.json({
        success: true,
        assistantMessage:
          'Switch to **Act on site** mode so I can perform browser actions like navigating, opening documents, or clicking on the page.',
      });
    }
    return next();
  }

  // ── ACT MODE ───────────────────────────────────────────────────────────────

  // DOC/FORM PRE-CHECK — runs before pageControl for document/download/form intents.
  // pageControl can only navigate to a listing page and stop; the site index has the
  // exact document URL so we resolve straight to navigate_then_download here.
  // Falls through if the index finds no document match, letting pageControl handle it.
  {
    const _primaryGoalId = goals[0]?.id;
    const _hasDocSignal = /\b(formulaires?|pdf|download|t[eé]l[eé]charg\w*|documents?|fichiers?|dossier|demande|liste)\b/i.test(message);
    if (hasSnapshot && isPageControlTask(message) && _DOC_INDEX_GOALS.has(_primaryGoalId) && _hasDocSignal) {
      let _preAllowedDomain = '';
      try { _preAllowedDomain = new URL(process.env.TARGET_URL || 'https://atb.tn').hostname; } catch {}
      const _preDecision = await decideAction(message, { allowedDomain: _preAllowedDomain });
      const _preAction = _preDecision.action || { type: 'not_found' };
      if (_preDecision.found && (_preAction.type === 'navigate_then_download' || _preAction.type === 'download')) {
        if (isDemoMode()) {
          stepLog('Route', 'site index (doc pre-check)');
          stepLog('Intent', `${_preDecision.resourceType} → ${_preAction.type} (${_preDecision.confidence.toFixed(2)})`);
          if (_preDecision.topMatches?.[0]) stepLog('Match', _preDecision.topMatches[0].title.slice(0, 60));
        } else {
          console.log(`[DOC_PRE_CHECK] resourceType=${_preDecision.resourceType} action=${_preAction.type} confidence=${_preDecision.confidence.toFixed(2)} doc=${(_preAction.documentUrl || _preAction.url || '').slice(0, 80)}`);
        }
        const _docUrl = _preAction.type === 'navigate_then_download'
          ? (_preAction.documentUrl || _preAction.url)
          : _preAction.url;
        const _cdpOk = await checkCdpReachable();
        if (!_cdpOk) {
          if (isDemoMode()) stepLog('Done', 'Chrome not connected — returning direct link');
          return res.json({
            success: true,
            assistantMessage:
              `I can't drive the browser right now — Chrome is not connected for visible control.\n` +
              `Direct link: ${_docUrl}`,
          });
        }
        req._isBrowserJob = true;
        const _preJobId = createDocFastPathJob({
          title:    _preAction.title,
          pageUrl:  _preAction.type === 'navigate_then_download' ? (_preAction.sourceUrl || null) : null,
          docUrl:   _docUrl,
          linkText: _preAction.type === 'navigate_then_download' ? (_preAction.highlightText || '') : '',
          traceId:  req.traceId,
        });
        return res.json({ success: true, status: 'browser_agent_queued', jobId: _preJobId });
      }
      // Site index found no document — fall through to normal pageControl
    }
  }

  // PRIORITY 1 — lightweight same-page control (highlight / scroll / summarize / list).
  // Runs widget-side via the host-page loader; no site-index lookup needed.
  if (hasSnapshot && isPageControlTask(message)) {
    const goalState = req.body?.pageGoalState || null;
    const plan = buildPagePlan(message, snapshot, goalState);
    return res.json({
      success: true,
      assistantMessage: plan.answer,
      pagePlan: {
        actions: plan.actions,
        status: plan.status || 'done',
        goalState: plan.goalState || null,
        goal: plan.goal || null,
      },
    });
  }

  // PRIORITY 2 — index-guided decision. Gemma parses intent only; the backend
  // scores it against the precomputed site-index collections and picks the route,
  // document, form, or contact result. pageNavigator executes it visibly.
  let allowedDomain = '';
  try { allowedDomain = new URL(process.env.TARGET_URL || 'https://atb.tn').hostname; } catch {}

  const decision = await decideAction(message, { allowedDomain });
  const action = decision.action || { type: 'not_found' };

  if (isDemoMode()) {
    stepLog('Route', 'site index');
    stepLog('Intent', `${decision.resourceType} → ${action.type} (${decision.confidence.toFixed(2)})`);
    if (decision.topMatches?.[0]) stepLog('Match', decision.topMatches[0].title.slice(0, 60));
  } else {
    console.log(
      `[SITE_INDEX_AGENT] resourceType=${decision.resourceType} action=${action.type} found=${decision.found} ` +
      `confidence=${decision.confidence.toFixed(2)} matches=${decision.topMatches.length}`,
    );
  }

  // The visible-navigation target for each browser action.
  const navTargetUrl =
    action.type === 'navigate_then_download' ? (action.documentUrl || action.url)
    : action.type === 'download'             ? action.url
    : action.type === 'navigate_then_click'  ? (action.sourceUrl || action.url)
    : action.url;

  const isBrowserAction =
    ['navigate', 'navigate_then_download', 'download', 'navigate_then_click'].includes(action.type);

  // CDP-disconnected guard: never fail silently. Return a deterministic message
  // with the direct URL so the user can act manually.
  if (isBrowserAction) {
    const cdpOk = await checkCdpReachable();
    if (!cdpOk) {
      if (isDemoMode()) stepLog('Done', 'Chrome not connected — returning direct link');
      return res.json({
        success: true,
        assistantMessage:
          `I can't drive the browser right now — Chrome is not connected for visible control.\n` +
          `Direct link: ${navTargetUrl}`,
      });
    }
  }

  switch (action.type) {
    // Navigate the visible tab to the source page, highlight the document link,
    // then open/download it.
    case 'navigate_then_download': {
      req._isBrowserJob = true;
      const jobId = createDocFastPathJob({
        title:    action.title,
        pageUrl:  action.sourceUrl || null,
        docUrl:   action.documentUrl || action.url,
        linkText: action.highlightText || '',
        traceId:  req.traceId,
      });
      return res.json({ success: true, status: 'browser_agent_queued', jobId });
    }

    // Open/download the matched document directly (no source page indexed).
    case 'download': {
      req._isBrowserJob = true;
      const jobId = createDocFastPathJob({
        title:   action.title,
        pageUrl: null,
        docUrl:  action.url,
        traceId: req.traceId,
      });
      return res.json({ success: true, status: 'browser_agent_queued', jobId });
    }

    case 'navigate': {
      req._isBrowserJob = true;
      const jobId = createPageFastPathJob({
        title:   action.title,
        pageUrl: action.url,
        traceId: req.traceId,
      });
      return res.json({ success: true, status: 'browser_agent_queued', jobId });
    }

    // Document whose file URL is not known at index time (click_visible_document_button).
    // Open the source page where the visible document button lives — the user completes
    // the click. Reuses page navigation; pageNavigator click behaviour is unchanged.
    case 'navigate_then_click': {
      req._isBrowserJob = true;
      const jobId = createPageFastPathJob({
        title:   action.title || action.linkText,
        pageUrl: action.sourceUrl || action.url,
        traceId: req.traceId,
      });
      return res.json({ success: true, status: 'browser_agent_queued', jobId });
    }

    // No navigation needed — answer directly (suggestions, not found).
    case 'suggestions':
    case 'not_found':
    default:
      return res.json({ success: true, assistantMessage: decision.answer });
  }
};

// Ask mode pre-retrieval: classify query into a source type and resolve fast-path cases
// before they ever reach the resource catalog or AI service.
// - current-page intent + usable siteContext → answer directly from DOM extraction
// - contact_facts → static phone/address answer, no catalog needed
// - document_index → redirect to Act mode (requires site navigation)
// - website_page   → redirect to Act mode (requires browser)
// - branch/catalog/general at score >= 0.30 → site-index second-chance answer
// - all others     → pass through to handleChatMessage
// ASK PRIORITY 1 — Selected Page Evidence Resolver (async, own middleware so the
// synchronous handleAskRetrieval below keeps Express's normal error semantics).
// Retrieves candidates from site-index + catalog (+ current page), resolves the best
// into evidence, and lets Gemma answer ONLY from that evidence. Silent — never uses
// visible Chrome/CDP and never emits browser_agent_* jobs. On null (Gemma down / not
// confident) it calls next() so the deterministic ASK path still runs.
const _normQuery = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const handleAskEvidenceResolver = async (req, res, next) => {
  const agentMode = String(req.body?.mode || req.body?.agentMode || 'ask').toLowerCase();
  if (agentMode !== 'ask') return next();
  const message = String(req.body?.message || '').trim();
  if (!message) return next();

  try {
    const dbg = {};
    const resolved = await resolveAskAnswer(message, {
      siteIndex: getSiteIndex(), siteCtx: req.siteContext || null, debug: dbg,
    });

    // Deterministic page-list fallback is only allowed when the user asked for a list.
    req._askArbitration = { fallbackPolicy: { allowSiteIndexFallback: isListIntent(message) } };

    if (isDemoMode()) {
      const sc = dbg.sourceConfidence || {};
      stepLog('Route', 'ask_retrieval');
      stepLog('ASKResolverVersion', dbg.version || '(error)');
      stepLog('SourceScope', dbg.scope || '(none)');
      stepLog('NormQuery', _normQuery(message).slice(0, 80));
      stepLog('CandSite(dedup)', (dbg.siteTop || []).join(' | ') || '(none)');
      stepLog('CandCatalog(strip)', (dbg.catalogTop || []).join(' | ') || '(none)');
      stepLog('Confidence', `site=${(sc.site_index || 0).toFixed(2)} catalog=${(sc.catalog || 0).toFixed(2)}`);
      stepLog('ExtractSource', dbg.extractSource || '(none)');
      stepLog('SelectedResource', dbg.selectedResource || '(none)');
      stepLog('SelectedFact', dbg.selectedFact ? String(dbg.selectedFact).slice(0, 120) : '(none)');
      stepLog('FactIntent', dbg.factIntent || '(none)');
      stepLog('FactRankScores', (dbg.factRankScores || [])
        .map((x) => `${Number(x.score).toFixed(2)}:${String(x.fact).slice(0, 45)}`).join(' | ') || '(none)');
      stepLog('MetaFactsRemoved', String(dbg.metaFactsRemoved || 0));
      if (dbg.siteFactFilter) {
        stepLog('SiteFactFilter', `nav/menu removed=${dbg.siteFactFilter.removedChrome} category-lists rejected=${dbg.siteFactFilter.rejectedLists} kept=${dbg.siteFactFilter.kept}`);
      }
      stepLog('SiteNoiseRejected', String(dbg.siteNoiseRejected || 0));
      stepLog('AnswerFacts', (dbg.answerFacts || []).map((f) => f.slice(0, 40)).join(' | ') || '(none)');
      if (dbg.siteFactQuality) stepLog('SiteFactQuality', dbg.siteFactQuality);
      stepLog('Gemma', dbg.gemma ? `used=[${(dbg.gemma.usedFacts || []).join(',')}] conf=${dbg.gemma.confidence}` : 'unavailable');
      stepLog('Validation', dbg.validation || '(none)');
      if (dbg.fallback) stepLog('DeterministicFallback', dbg.fallback);
    }

    if (resolved && resolved.type === 'answer') {
      if (isDemoMode()) {
        stepLog('Source', `evidence:${resolved.source}${resolved.synthesized ? ' (fallback)' : ''}`);
        stepLog('Match', String(resolved.matchTitle || '').slice(0, 60));
        stepLog('Answer', resolved.answer.slice(0, 100).replace(/\n/g, ' '));
        stepLog('Done', resolved.synthesized
          ? `success — deterministic answer from ${resolved.source} facts`
          : `success — Gemma reformulated ${resolved.source} facts`);
      }
      return res.json({ success: true, assistantMessage: resolved.answer });
    }
    if (isDemoMode()) {
      stepLog('Fallback', `no evidence answer — site page-list ${isListIntent(message) ? 'allowed' : 'BLOCKED'} → deterministic/AI handler`);
    }
  } catch { /* fall through to deterministic path */ }
  return next();
};

const handleAskRetrieval = (req, res, next) => {
  const agentMode = String(req.body?.mode || req.body?.agentMode || 'ask').toLowerCase();
  if (agentMode !== 'ask') return next();

  const message = String(req.body?.message || '').trim();
  if (!message) return next();

  // PRIORITY 0 — current-page question with usable siteContext.
  // Guard: site-wide questions ("on the site") must not be caught here — they route to siteIndex.
  const siteCtx = req.siteContext || null;
  if (isCurrentPageQuestion(message) && !isSiteWideQuestion(message) && siteContextHasUsefulContent(siteCtx)) {
    const answer = buildSiteContextAnswer(message, siteCtx);
    if (isDemoMode()) {
      stepLog('Route', 'ask_retrieval');
      stepLog('Source', 'site_context');
      stepLog('Match', 'Current page');
      const ctxLabel = siteCtx.title
        ? `title="${siteCtx.title.slice(0, 60)}"`
        : `url=${siteCtx.url.slice(0, 60)}`;
      stepLog('Evidence', `${ctxLabel} links=${siteCtx.stats?.links || 0} dl=${siteCtx.stats?.downloadLinks || 0}`);
      stepLog('Answer', (answer || '').slice(0, 100).replace(/\n/g, ' '));
      stepLog('Done', 'success — answer extracted');
    }
    return res.json({ success: true, assistantMessage: answer });
  }

  // PRIORITY 1 — siteIndex retrieval, gated by the arbitration decision (evidence
  // strength), NOT by middleware order or a fixed threshold. Site_index may answer only
  // when arbitration selected it as the strongest allowed source. When catalog (or
  // nothing) is stronger, siteIndexMatches stays empty so both the PRIORITY 1 block and
  // the second-chance block below are skipped, letting the catalog/AI handler run.
  const _policy = req._askArbitration ? req._askArbitration.fallbackPolicy : null;
  const _allowSite = _policy ? _policy.allowSiteIndexFallback : true; // no arbitration (resolver error) → preserve availability
  const siteIndex = getSiteIndex();
  const siteIndexMatches = _allowSite ? searchSiteIndex(message, siteIndex) : [];
  const SITE_INDEX_THRESHOLD = 0.35;
  if (siteIndexMatches.length > 0 && siteIndexMatches[0].score >= SITE_INDEX_THRESHOLD) {
    const answer = buildSiteIndexAnswer(message, siteIndexMatches);
    if (answer) {
      if (isDemoMode()) {
        const wantsDocuments = /\b(documents?|downloads?|forms?|formulaire|pdfs?|t[eé]l[eé]charger|files?|fichiers?)\b/i.test(message);
        let matchLabel, evidenceStr;
        if (wantsDocuments) {
          const docMatches = searchDocumentLinks(message, siteIndexMatches);
          if (docMatches.length > 0 && docMatches[0].score >= 0.6) {
            matchLabel = docMatches[0].dl.text.slice(0, 60);
            evidenceStr = `score=${docMatches[0].score.toFixed(2)} type=${docMatches[0].dl.fileType} from=${docMatches[0].page.url.replace(/^https?:\/\//, '').slice(0, 40)}`;
          }
        }
        if (!matchLabel) {
          const bestPage = getBestMatchPage(message, siteIndexMatches) || siteIndexMatches[0].page;
          matchLabel = getPageLabel(bestPage).slice(0, 60);
          evidenceStr = `score=${siteIndexMatches[0].score.toFixed(2)} pages=${siteIndexMatches.length} from=${bestPage.url.replace(/^https?:\/\//, '').slice(0, 40)}`;
        }
        stepLog('Route', 'ask_retrieval');
        stepLog('Source', 'site_index');
        stepLog('Match', matchLabel);
        stepLog('Evidence', evidenceStr);
        stepLog('Answer', answer.slice(0, 100).replace(/\n/g, ' '));
        stepLog('Done', 'success — answer extracted');
      }
      return res.json({ success: true, assistantMessage: answer });
    }
  }

  const { sourceType, confidence } = detectSourceType(message);
  req._askSourceType = sourceType;

  if (isDemoMode()) {
    stepLog('Route', 'ask_retrieval');
    stepLog('Source', sourceType);
    stepLog('Confidence', confidence.toFixed(2));
  }

  if (sourceType === SOURCE_TYPES.CONTACT_FACTS) {
    const answer = buildContactFactsAnswer(message);
    if (isDemoMode()) stepLog('Match', 'ATB contact facts (static)');
    return res.json({ success: true, assistantMessage: answer });
  }

  if (sourceType === SOURCE_TYPES.DOCUMENT_INDEX || sourceType === SOURCE_TYPES.WEBSITE_PAGE) {
    if (isDemoMode()) stepLog('Match', `redirect → Act mode (${sourceType})`);
    return res.json({
      success: true,
      assistantMessage:
        'Switch to **Act on site** mode so I can navigate to that page or document on the ATB website.',
    });
  }

  // Second-chance site-index lookup for source types that would otherwise fall to catalog/AI.
  // siteIndexMatches is already filtered to score >= 0.30 from the searchSiteIndex call above.
  // BRANCH_DIRECTORY, CATALOG_PRODUCT, and GENERAL questions about the ATB website should be
  // answered from site-index.json before escalating to Laragon resources or the AI service.
  const _SECOND_CHANCE_TYPES = new Set([
    SOURCE_TYPES.BRANCH_DIRECTORY,
    SOURCE_TYPES.CATALOG_PRODUCT,
    SOURCE_TYPES.GENERAL,
  ]);
  if (_SECOND_CHANCE_TYPES.has(sourceType) && siteIndexMatches.length > 0) {
    const secondChanceAnswer = buildSiteIndexAnswer(message, siteIndexMatches);
    if (secondChanceAnswer) {
      if (isDemoMode()) {
        const bestPage = getBestMatchPage(message, siteIndexMatches) || siteIndexMatches[0].page;
        stepLog('Source', `site_index (2nd chance — ${sourceType})`);
        stepLog('Match', getPageLabel(bestPage).slice(0, 60));
        stepLog('Evidence', `score=${siteIndexMatches[0].score.toFixed(2)} pages=${siteIndexMatches.length}`);
        stepLog('Answer', secondChanceAnswer.slice(0, 100).replace(/\n/g, ' '));
        stepLog('Done', 'success — answer extracted');
      }
      return res.json({ success: true, assistantMessage: secondChanceAnswer });
    }
  }

  return next();
};

// Start a queued job. Called by widget AFTER synchronous sessionStorage persist. Idempotent.
const handleBrowserAgentJobStart = (req, res) => {
  const { jobId } = req.params;
  if (!isDemoMode()) {
    console.log(`[START_HANDLER_REACHED] job=${String(jobId).slice(0, 8)}`);
  }
  const job = getBrowserAgentJob(jobId);
  if (!job) return res.status(404).json({ success: false, status: 'not_found' });
  if (job.status === 'failed') {
    return res.json({ success: false, status: 'browser_agent_error', message: job.error });
  }
  launchBrowserAgentJob(jobId);
  return res.json({ success: true, status: 'browser_agent_running' });
};

// Poll endpoint — queued + running both return browser_agent_running (widget keeps cycling).
const handleBrowserAgentJobStatus = (req, res) => {
  const job = getBrowserAgentJob(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, status: 'not_found' });
  if (job.status === 'queued' || job.status === 'running') {
    return res.json({ success: true, status: 'browser_agent_running' });
  }
  if (job.status === 'failed') {
    return res.json({
      success: false,
      status: 'browser_agent_error',
      message: job.error || 'The website search failed. Please try again.',
    });
  }
  return res.json({
    success: true,
    status: 'browser_agent_done',
    assistantMessage: job.finalAnswer || 'Done — I completed the search.',
  });
};

router.post('/chat', logWidgetRequestEntered, withTrace, withConversationContext, withIntentPreclassify, withRequestContext, withAgentPlan, handleBrowserTaskOrDelegate, handleAskEvidenceResolver, handleAskRetrieval, handleChatMessage);
router.post('/browser-agent/:jobId/start', handleBrowserAgentJobStart);
router.get('/browser-agent/:jobId', handleBrowserAgentJobStatus);

// Trace endpoint — returns live demo step lines for a given traceId.
// Used by the CLI test script to print the same trace the widget shows.
router.get('/trace/:traceId', (req, res) => {
  const { traceId } = req.params;
  if (!traceId || !/^[a-zA-Z0-9_-]+$/.test(traceId)) {
    return res.status(400).json({ error: 'invalid traceId' });
  }
  const data = getTrace(traceId);
  if (!data) return res.json({ traceId, lines: [], done: true });
  return res.json({ traceId, lines: data.lines, done: data.done });
});
// Dev-only: site index summary for validation.
router.get('/site-index/summary', (req, res) => {
  const index = getSiteIndex();
  if (!index) return res.json({ exists: false });
  return res.json({ exists: true, ...summarizeSiteIndex(index) });
});

router.post('/actions/cancel', cancelAgentAction);
router.post('/actions/confirm', confirmAgentAction);
router.post('/actions/execute', executeAgentAction);
router.post('/actions/prepare', prepareAgentAction);
router.post('/actions/verify-and-execute', verifyAndExecuteAgentAction);

router.get('/generated/:fileId/download', async (req, res) => {
  const { fileId } = req.params;

  if (!/^[a-f0-9]{32}$/.test(fileId)) {
    return res.status(400).json({ success: false, message: 'Invalid file ID' });
  }

  try {
    const fileInfo = await getGeneratedFile(fileId);

    if (!fileInfo) {
      return res.status(404).json({ success: false, message: 'File not found' });
    }

    const mimeTypes = {
      txt: 'text/plain',
      csv: 'text/csv',
      json: 'application/json',
    };

    const mime = mimeTypes[fileInfo.extension] || 'application/octet-stream';
    const safeFileName = path.basename(fileInfo.fileName).replace(/[^a-z0-9._-]/gi, '_');

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}"`);

    return res.sendFile(fileInfo.filePath);
  } catch {
    return res.status(500).json({ success: false, message: 'File download failed' });
  }
});

module.exports = router;
