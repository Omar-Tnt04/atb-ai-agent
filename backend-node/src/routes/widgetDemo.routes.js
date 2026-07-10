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
const { isDemoMode, stepLog, simpleStep, runWithTrace } = require('../utils/demoLogger');
const { createTrace, getTrace, markTraceDone } = require('../services/traceBuffer.service');
const { SOURCE_TYPES, detectSourceType, buildContactFactsAnswer } = require('../services/askRetrieval.service');
const { retrieveAskContextBlocks, buildCombinedAnswerLLM, NOT_ENOUGH_INFO } = require('../services/askContext.service');
const { retrieveCatalogEntries } = require('../services/catalogRetrieval.service');
const { normalizeQuery } = require('../services/queryNormalization.service');
const { semanticSearchAsk } = require('../services/semanticRetrieval.service');
const { prepareUserRequest } = require('../services/requestPreparation.service');
const { semanticSearchNavigation } = require('../services/semanticNavigation.service');
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

// TRUTHFUL PER-REQUEST TIMING — first middleware. Stamps a short requestId, records
// phase durations (only phases that actually ran are printed — no faked/unused phases),
// and on response emits a compact Timing block + names the real bottleneck.
// Sub-times from services: embeddingMs (prepared.embedMs), qwenSynthesisMs / answerValidationMs
// (synthesis diag). Pure instrumentation — never changes routing or answer content.
const withTiming = (req, res, next) => {
  const t = { start: Date.now(), last: Date.now(), id: Math.random().toString(36).slice(2, 8), phases: {} };
  req._timing = t;
  req._mark = (name) => { const now = Date.now(); t.phases[name] = now - t.last; t.last = now; };
  const origJson = res.json.bind(res);
  res.json = (body) => {
    const totalMs = Date.now() - t.start;
    const p = req._preparedRequest;
    if (p && typeof p.embedMs === 'number') t.phases.embeddingMs = p.embedMs;
    const d = req._synthDiag || {};
    if (typeof d.qwenMs === 'number') t.phases.qwenSynthesisMs = d.qwenMs;
    if (typeof d.validationMs === 'number') t.phases.validationMs = d.validationMs;
    const entries = Object.entries(t.phases);
    const top = entries.slice().sort((a, b) => b[1] - a[1])[0];
    const bottleneck = top ? `${top[0]}(${top[1]}ms)` : 'n/a';
    const finalRoute = req._finalRoute || '(none)';
    const msg = String(req.body?.message || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    // Surface the key ASK metrics in a fixed, readable order; append any other phases after.
    const NAMED = ['embeddingMs', 'semanticRetrievalMs', 'catalogRetrievalMs', 'qwenSynthesisMs', 'validationMs'];
    const namedStr = NAMED.filter((k) => typeof t.phases[k] === 'number').map((k) => `${k}=${t.phases[k]}`).join(' ');
    const restStr = entries.filter(([k]) => !NAMED.includes(k)).map(([k, v]) => `${k}=${v}`).join(' ');
    const line =
      `RequestId=${t.id} User="${msg}" totalMs=${totalMs} finalRoute=${finalRoute} ` +
      `bottleneck=${bottleneck}` + (namedStr ? ` ${namedStr}` : '') + (restStr ? ` ${restStr}` : '');
    if (isDemoMode()) stepLog('Timing', line);
    else console.log(`[TIMING] ${line}`);
    return origJson(body);
  };
  return next();
};

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
    // Legacy deterministic pre-classifier — kept for observation, does NOT drive routing.
    const targetStr = target ? ` target="${target.slice(0, 40)}"` : '';
    stepLog('LegacyPreRouting', `${type}${targetStr}`);
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
    // Legacy deterministic planner — observation only, does NOT drive routing.
    stepLog('LegacyPlan', `executor=${executorType} route=${selectedRoute}`);
  } else {
    console.log(`[AGENT_PLAN] executor=${executorType} route=${selectedRoute} confidence=${confidence.toFixed(2)}`);
  }
  return next();
};

// REQUEST PREPARATION — runs once for BOTH ASK and ACT, before the mode branch.
// Normalizes the message once and computes ONE bge-m3 embedding (when
// REQUEST_PREPARE_EMBEDDING=true) that ASK retrieval and ACT navigation both reuse.
// Never blocks the request on failure — embeddingOk:false lets callers fall back.
const withRequestPreparation = async (req, res, next) => {
  const message = String(req.body?.message || '').trim();
  const agentMode = String(req.body?.mode || req.body?.agentMode || 'ask').toLowerCase();
  // Everything before this point = legacy pre-routing (preclassify/context/plan middlewares).
  if (req._mark) req._mark('preRoutingMs');
  try {
    req._preparedRequest = message ? await prepareUserRequest({ message, modeHint: agentMode }) : null;
  } catch {
    req._preparedRequest = null;
  }
  if (req._mark) req._mark('requestPreparationMs');
  // Expose per project convention (both req.agentContext and res.locals).
  req.agentContext = { ...(req.agentContext || {}), preparedRequest: req._preparedRequest };
  res.locals.preparedRequest = req._preparedRequest;

  const p = req._preparedRequest;
  if (p) {
    const line =
      `normalizedText="${p.normalizedText.slice(0, 60)}" detectedLanguage=${p.detectedLanguage} ` +
      `responseLanguage=${p.responseLanguage} embeddingModel=${p.embeddingModel} embeddingOk=${p.embeddingOk} ` +
      `embeddingMs=${p.embedMs}`;
    if (isDemoMode()) stepLog('PreparedRequest', line);
    else console.log(`[PREPARED_REQUEST] ${line}`);
    // Compact simple-mode line (no-op unless DEMO_TRACE_MODE=simple).
    simpleStep('PREP', `lang=${p.responseLanguage} embedding=${p.embeddingModel} embeddingMs=${p.embedMs}`);
  }
  return next();
};

// ASK DEBUG TRACE — initializes req._askTrace for every ask-mode request and, when
// debug is enabled (body.debug:true OR env ASK_DEBUG_TRACE=true), wraps res.json once so
// the assembled trace is attached as `debugTrace` on whatever answer is returned.
// Pure instrumentation: no effect on routing or answer content, off by default.
const _askDebugEnabled = (req) =>
  req.body?.debug === true || /^(1|true|yes|on)$/i.test(String(process.env.ASK_DEBUG_TRACE || ''));

const withAskDebugTrace = (req, res, next) => {
  const agentMode = String(req.body?.mode || req.body?.agentMode || 'ask').toLowerCase();
  if (agentMode !== 'ask') return next();
  req._askTrace = {
    mode: 'ask',
    question: String(req.body?.message || '').trim(),
    requestPreparation: {
      normalizedText: '', detectedLanguage: '', responseLanguage: '',
      embeddingModel: '', embeddingOk: false, embeddingComputedOnce: false,
    },
    queryNormalization: { originalQuestion: '', normalizedQuestion: '', detectedLanguage: '', responseLanguage: '' },
    semanticRetrieval: {
      enabled: false, model: '', indexPath: '', indexLoaded: false, indexBuilt: false,
      chunkCount: 0, topMatches: [], fallbackUsed: false, failedReason: '', reusedPreparedEmbedding: false,
    },
    actionDeflection: { triggered: false, reason: '', matchedPattern: '' },
    retrieval: {
      askContext: { loaded: false, matches: [] },
      catalog: { loaded: false, matches: [] },
    },
    selectedEvidence: { askContextCount: 0, catalogCount: 0, totalCharsSentToModel: 0 },
    synthesis: {
      enabled: false, required: false, model: process.env.ASK_SYNTHESIS_MODEL || 'qwen3:14b',
      called: false, success: false, failedReason: '', guardRejected: false, fallbackUsed: false,
    },
    finalPath: 'no_answer',
    responseType: 'error',
  };
  if (_askDebugEnabled(req)) {
    const orig = res.json.bind(res);
    res.json = (body) => {
      if (body && typeof body === 'object' && req._askTrace) body.debugTrace = req._askTrace;
      return orig(body);
    };
  }
  return next();
};

// Pure imperative site-action commands → deflect to Act. Anchored at the message start
// (optionally after "please") so an informational question that merely CONTAINS a verb
// like "find" or a noun like "document/form/account" is NOT deflected.
const _ASK_PURE_ACTION_RE =
  /^(?:please\s+)?(?:open|click|navigate\s+to|go\s+to|scroll\s+to|take\s+me\s+to|download|highlight|show\s+me\s+on\s+the\s+page)\b/i;
// Informational intent ANYWHERE in the message keeps it in Ask mode.
const _ASK_INFORMATIONAL_RE =
  /\b(?:what|which|who|where|when|why|how|is|are|does|do|can\s+i|tell\s+me\s+about|list|available|located|need(?:ed)?)\b/i;

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
    // Compact simple-mode entry line (no-op unless DEMO_TRACE_MODE=simple).
    simpleStep(isAskMode ? 'ASK' : 'ACT', `"${message.slice(0, 80).replace(/"/g, "'")}"`);
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

  // Compact simple-mode ACT trace (no-op unless DEMO_TRACE_MODE=simple). Emits the
  // [NAVIGATE] + [DONE] pair at each ACT dispatch point.
  const _actTrace = (route, action, extra = '') => {
    simpleStep('NAVIGATE', `route=${route}${extra ? ` ${extra}` : ''}`);
    const _t = req._timing ? Date.now() - req._timing.start : 0;
    simpleStep('DONE', `success totalMs=${_t} action=${action}`);
  };

  // ASK MODE — skip all browser routing; deflect ONLY a pure imperative command
  // (e.g. "Download the form for me"), never an informational question that merely
  // mentions find/document/form/account.
  if (isAskMode) {
    if (_ASK_PURE_ACTION_RE.test(message) && !_ASK_INFORMATIONAL_RE.test(message)) {
      if (req._askTrace) {
        const m = message.match(_ASK_PURE_ACTION_RE);
        req._askTrace.actionDeflection = {
          triggered: true,
          reason: 'pure imperative site-action command (no informational clause)',
          matchedPattern: m ? m[0] : '',
        };
        req._askTrace.finalPath = 'act_deflection';
        req._askTrace.responseType = 'deflection';
      }
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
        _actTrace('site_index', 'open_document', `target=document score=${_preDecision.confidence.toFixed(2)}`);
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
    simpleStep('DONE', `success totalMs=${req._timing ? Date.now() - req._timing.start : 0} action=page_control`);
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

  // PRIORITY 1.5 — semantic navigation (gated by ACT_USE_SEMANTIC_NAVIGATION).
  // Reuses the prepared bge-m3 embedding against the site-navigation index to pick a
  // page/document target. Confident → build the visible browser job directly. Otherwise
  // fall through to the existing site-index keyword decision (emergency fallback only).
  if (/^(1|true|yes|on)$/i.test(String(process.env.ACT_USE_SEMANTIC_NAVIGATION || ''))) {
    const _prep = req._preparedRequest || null;
    const _navStart = Date.now();
    const nav = await semanticSearchNavigation({
      normalizedQuestion: _prep ? _prep.normalizedText : message,
      queryEmbedding: _prep && _prep.embeddingOk ? _prep.embedding : null,
      topK: parseInt(process.env.ACT_SEMANTIC_TOP_K || '5', 10),
      minScore: parseFloat(process.env.ACT_SEMANTIC_MIN_SCORE || '0.45'),
    });
    const _navMs = Date.now() - _navStart;
    const top = nav.topMatch;
    const navLine =
      `enabled=true reusedPreparedEmbedding=${nav.reusedEmbedding} ok=${nav.ok} confident=${nav.confident} chunks=${nav.chunkCount} ` +
      `top=${top ? `${top.sourceType}:${String(top.title || '').slice(0, 40)}~final=${top.finalScore}(sem=${top.semanticScore}+lex=${top.lexicalBoost}) [${(top.boostReasons || []).join(',')}]` : '(none)'} fail=${nav.failedReason || '-'}`;
    if (isDemoMode()) stepLog('ACTSemanticNav', navLine);
    else console.log(`[ACT_SEMANTIC_NAV] ${navLine}`);

    if (nav.ok && nav.confident && top && (top.sourceType === 'page' || top.sourceType === 'document') && top.url) {
      const isDoc = top.sourceType === 'document';
      const cdpOk = await checkCdpReachable();
      if (!cdpOk) {
        if (isDemoMode()) stepLog('Done', 'Chrome not connected — returning direct link');
        return res.json({
          success: true,
          assistantMessage:
            `I can't drive the browser right now — Chrome is not connected for visible control.\n` +
            `Direct link: ${top.url}`,
        });
      }
      req._isBrowserJob = true;
      if (isDemoMode()) {
        stepLog('Route', `semantic navigation (${top.sourceType})`);
        stepLog('FallbackPolicy', 'semanticPrimary=true fallbackUsed=false fallbackType=none');
      } else {
        console.log(`[ACT_FALLBACK] semanticPrimary=true fallbackUsed=false fallbackType=none`);
      }
      _actTrace('semantic_navigation', isDoc ? 'open_document' : 'open_page', `target=${top.sourceType} score=${top.finalScore} retrievalMs=${_navMs}`);
      const jobId = isDoc
        ? createDocFastPathJob({ title: top.title, pageUrl: top.sourcePageUrl || null, docUrl: top.url, traceId: req.traceId })
        : createPageFastPathJob({ title: top.title, pageUrl: top.url, traceId: req.traceId });
      return res.json({ success: true, status: 'browser_agent_queued', jobId });
    }
    const _fbReason = nav.ok ? 'low_confidence' : nav.failedReason;
    if (isDemoMode()) stepLog('FallbackPolicy', `semanticPrimary=true fallbackUsed=true fallbackReason=${_fbReason} fallbackType=keyword`);
    else console.log(`[ACT_FALLBACK] semanticPrimary=true fallbackUsed=true reason=${_fbReason} type=keyword`);
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
    // Compact simple-mode trace for the keyword site-index dispatch (no-op unless simple).
    const _actLabel = (action.type === 'navigate' || action.type === 'navigate_then_click') ? 'open_page' : 'open_document';
    _actTrace('site_index', _actLabel, `target=${action.type} score=${decision.confidence.toFixed(2)}`);
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
      simpleStep('DONE', `success totalMs=${req._timing ? Date.now() - req._timing.start : 0} action=answer`);
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

// ASK PRIORITY 0 — combined retrieval aggregator over BOTH ask-mode knowledge
// sources, kept separate: ask-context.json (public website/page context) and
// catalog.json (Laragon structured business data). It retrieves relevant evidence
// from EACH, combines the two result sets, and builds ONE grounded answer from
// only the selected snippets (never the full files), labeling each source. It does
// NOT answer early from ask-context alone — catalog is always given a chance.
// When neither source is relevant it falls through (next()) so the existing ask
// pipeline still runs. Does not touch act mode or site-index.json.
const handleAskContextRetrieval = async (req, res, next) => {
  const agentMode = String(req.body?.mode || req.body?.agentMode || 'ask').toLowerCase();
  if (agentMode !== 'ask') return next();
  const message = String(req.body?.message || '').trim();
  if (!message) return next();

  try {
    // Reuse the once-computed prepared request (normalize + embedding). Fall back to a
    // local normalize only if the preparation middleware did not run.
    const prep = req._preparedRequest || null;
    const norm = prep
      ? {
          originalQuestion: prep.originalText, normalizedQuestion: prep.normalizedText,
          detectedLanguage: prep.detectedLanguage, responseLanguage: prep.responseLanguage,
        }
      : normalizeQuery(message);

    // Retrieval: semantic-first (bge-m3) when enabled, else keyword. Semantic never
    // throws — on any failure/empty we fall back to keyword retrieval.
    let askBlocks = [];
    let catalogEntries = [];
    const sem = {
      enabled: false, model: '', indexPath: '', indexLoaded: false, indexBuilt: false,
      chunkCount: 0, topMatches: [], fallbackUsed: false, failedReason: '', reusedPreparedEmbedding: false,
    };
    const _semStart = Date.now();
    const useSemantic = /^(1|true|yes|on)$/i.test(String(process.env.ASK_USE_SEMANTIC_RETRIEVAL || ''));
    if (useSemantic) {
      sem.enabled = true;
      const r = await semanticSearchAsk({
        originalQuestion: message,
        normalizedQuestion: norm.normalizedQuestion,
        queryEmbedding: prep && prep.embeddingOk ? prep.embedding : null,
        topK: parseInt(process.env.ASK_SEMANTIC_TOP_K || '6', 10),
        minScore: parseFloat(process.env.ASK_SEMANTIC_MIN_SCORE || '0.45'),
      });
      sem.model = r.model; sem.indexPath = r.indexPath;
      sem.indexLoaded = r.indexLoaded; sem.indexBuilt = r.indexBuilt; sem.chunkCount = r.chunkCount;
      sem.reusedPreparedEmbedding = !!r.reusedEmbedding;
      if (r.ok && r.chunks.length > 0) {
        for (const c of r.chunks) {
          if (c.sourceType === 'ask-context' && c.metadata && c.metadata.block) {
            askBlocks.push({ block: c.metadata.block, score: c.score });
          } else if (c.sourceType === 'catalog' && c.metadata && c.metadata.evidence) {
            catalogEntries.push({ ...c.metadata.evidence, score: c.score });
          }
        }
        sem.topMatches = r.chunks.map((c) => ({
          sourceType: c.sourceType, sourceId: c.sourceId, title: c.title,
          score: c.score, url: c.url, category: c.category,
        }));
      } else {
        sem.fallbackUsed = true;
        sem.failedReason = r.failedReason || 'no_relevant_chunks';
      }
    }
    if (!useSemantic || sem.fallbackUsed) {
      [askBlocks, catalogEntries] = await Promise.all([
        Promise.resolve(retrieveAskContextBlocks(message)),
        retrieveCatalogEntries(message),
      ]);
    }
    const _retrievalMs = Date.now() - _semStart;
    if (req._timing) {
      req._timing.phases[sem.enabled && !sem.fallbackUsed ? 'semanticRetrievalMs' : 'catalogRetrievalMs'] = _retrievalMs;
    }

    // LLM synthesis when ASK_USE_LLM_SYNTHESIS=true (sends only selected evidence to
    // qwen3:14b, answering in responseLanguage), else deterministic. Fallback automatic.
    const _synthDiag = {};
    req._synthDiag = _synthDiag; // exposed to withTiming for qwenSynthesisMs / answerValidationMs
    const result = await buildCombinedAnswerLLM(message, {
      askBlocks, catalogEntries, diag: _synthDiag, responseLanguage: norm.responseLanguage,
    });

    if (req._askTrace) {
      if (prep) {
        req._askTrace.requestPreparation = {
          normalizedText: prep.normalizedText,
          detectedLanguage: prep.detectedLanguage,
          responseLanguage: prep.responseLanguage,
          embeddingModel: prep.embeddingModel,
          embeddingOk: prep.embeddingOk,
          embeddingComputedOnce: true,
        };
      }
      req._askTrace.queryNormalization = {
        originalQuestion: norm.originalQuestion,
        normalizedQuestion: norm.normalizedQuestion,
        detectedLanguage: norm.detectedLanguage,
        responseLanguage: norm.responseLanguage,
      };
      req._askTrace.semanticRetrieval = sem;
    }

    if (req._askTrace) {
      const t = req._askTrace;
      t.retrieval.askContext = {
        loaded: true,
        matches: askBlocks.map(({ block, score }) => ({
          id: block.id || block.url || '', url: block.url || '',
          score: Number(score.toFixed(3)),
          matchedFields: ['promptText', 'keyPoints', 'usefulForQuestionsAbout'],
        })),
      };
      t.retrieval.catalog = {
        loaded: true,
        matches: catalogEntries.map((e) => ({
          id: e.id || e.title || '', category: e.category || '',
          score: Number(e.score.toFixed(3)),
          matchedFields: ['title', 'description', 'exampleQueries'],
          contentLoaded: !!e.contentLoaded,
          contentSource: e.contentSource || null,
        })),
      };
      t.selectedEvidence = {
        askContextCount: askBlocks.length,
        catalogCount: catalogEntries.length,
        totalCharsSentToModel: _synthDiag.totalCharsSentToModel || 0,
      };
      t.synthesis = {
        enabled: !!_synthDiag.enabled, required: !!_synthDiag.required,
        model: _synthDiag.model || (process.env.ASK_SYNTHESIS_MODEL || 'qwen3:14b'),
        called: !!_synthDiag.called, success: !!_synthDiag.success,
        failedReason: _synthDiag.failedReason || '', guardRejected: !!_synthDiag.guardRejected,
        fallbackUsed: !!_synthDiag.fallbackUsed,
      };
      if (result.answered) {
        t.finalPath = _synthDiag.finalPath || 'deterministic';
        t.responseType = result.synthesisFailed ? 'error' : 'answer';
      } else {
        // P0 did not answer — the request falls through to the legacy ask pipeline.
        t.finalPath = 'old_ask_pipeline';
        t.responseType = 'fallback';
      }
    }
    if (result.answered) {
      req._finalRoute = sem.enabled && !sem.fallbackUsed ? 'semantic_retrieval' : 'ask_context+catalog';
      if (isDemoMode()) {
        const _routeLabel = sem.enabled && !sem.fallbackUsed ? 'semantic_retrieval' : 'ask_context+catalog';
        stepLog('Route', `${_routeLabel} retrievalMs=${_retrievalMs}`);
        const synthesisMode = result.synthesized ? 'qwen_synthesis' : 'deterministic';
        const _qwenMs = typeof _synthDiag.qwenMs === 'number' ? _synthDiag.qwenMs : 0;
        stepLog('Synthesis', `${synthesisMode} qwenSynthesisMs=${_qwenMs}`);
        // Compact simple-mode lines (no-op unless DEMO_TRACE_MODE=simple).
        const _top =
          (askBlocks[0] && (askBlocks[0].block.id || askBlocks[0].block.url)) ||
          (catalogEntries[0] && (catalogEntries[0].id || catalogEntries[0].title)) ||
          (sem.topMatches[0] && sem.topMatches[0].sourceId) || '(none)';
        simpleStep('RETRIEVE', `source=ask-context+catalog route=${_routeLabel} retrievalMs=${_retrievalMs} top=${_top}`);
        simpleStep('GENERATE', `model=${result.synthesized ? _synthDiag.model : 'deterministic'} qwenMs=${_qwenMs} evidence=${askBlocks.length + catalogEntries.length}`);
        stepLog('SynthesisDiag', `qwenCalled=${!!_synthDiag.called} success=${!!_synthDiag.success} semanticEnabled=${!!sem.enabled} evidence=${askBlocks.length + catalogEntries.length} lang=${norm.responseLanguage}`);
        if (!result.synthesized && _synthDiag.enabled) {
          stepLog('DeterministicReason', _synthDiag.failedReason || (_synthDiag.guardRejected ? 'guard_rejected' : 'unknown'));
        }
        stepLog('AskBlocks', askBlocks.map(({ block, score }) => `${block.id || block.url}~${score.toFixed(2)}`).join(' | ').slice(0, 120) || '(none)');
        stepLog('CatalogHits', catalogEntries.map((e) => `${e.id || e.title}~${e.score.toFixed(2)}`).join(' | ').slice(0, 120) || '(none)');
        stepLog('Sources', result.sources.slice(0, 4).join(' | ').slice(0, 140) || '(none)');
        stepLog('Answer', result.answer.slice(0, 100).replace(/\n/g, ' '));
        const _embMs = req._preparedRequest && typeof req._preparedRequest.embedMs === 'number' ? req._preparedRequest.embedMs : 0;
        const _totalMs = req._timing ? Date.now() - req._timing.start : 0;
        const _bneck = [['embedding', _embMs], ['retrieval', _retrievalMs], ['qwenSynthesis', _qwenMs]]
          .sort((a, b) => b[1] - a[1])[0];
        stepLog('Done', `success totalMs=${_totalMs} bottleneck=${_bneck[0]} — ${result.synthesized ? 'qwen3 synthesis' : 'deterministic'} answer from ask-context + catalog evidence`);
        const _bneckName = { qwenSynthesis: _synthDiag.model || 'qwen3:14b', embedding: 'bge-m3', retrieval: 'retrieval' };
        simpleStep('DONE', `success totalMs=${_totalMs} bottleneck=${_bneckName[_bneck[0]] || _bneck[0]}`);
      }
      return res.json({ success: true, assistantMessage: result.answer });
    }
    if (isDemoMode()) stepLog('AskContext', 'no ask-context/catalog match — fall through to ask pipeline');
  } catch { /* fall through to the rest of the ask pipeline */ }
  return next();
};

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

// Domain signal — a question worth handing to the legacy resource controller.
// Absent (e.g. "explain quantum chromodynamics") → clean not-enough-info instead of
// falling into the document-search pipeline.
const _ASK_BANKING_SIGNAL_RE =
  /\b(atb|account|compte|card|carte|loan|credit|cr[eé]dit|pr[eê]t|transfer|virement|bill|facture|fee|frais|rate|taux|exchange|change|devise|branch|agence|atm|iban|rib|connect|banking|bancaire|deposit|savings|epargne|insurance|assurance|document|form|formulaire|statement|releve|checkbook|cheque|sme|business|entreprise|payment|invoice|receipt|dinar|tnd)\b/i;

// ASK TERMINAL GUARD — last stop before the legacy document-search controller.
// When P0/P1/P2 all found nothing AND the question carries no banking/resource signal,
// return the deterministic not-enough-info message instead of the old pipeline.
const handleAskTerminalGuard = (req, res, next) => {
  const agentMode = String(req.body?.mode || req.body?.agentMode || 'ask').toLowerCase();
  if (agentMode !== 'ask') return next();
  const message = String(req.body?.message || '').trim();
  if (!message) return next();

  if (_ASK_BANKING_SIGNAL_RE.test(message)) return next(); // has signal → legacy resource handler

  if (req._askTrace) {
    req._askTrace.finalPath = 'no_answer';
    req._askTrace.responseType = 'fallback';
  }
  if (isDemoMode()) {
    stepLog('Route', 'ask_terminal_guard');
    stepLog('Done', 'no ask-context/catalog/site match + no banking signal → not-enough-info');
  }
  return res.json({ success: true, assistantMessage: NOT_ENOUGH_INFO });
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

router.post('/chat', withTiming, logWidgetRequestEntered, withTrace, withConversationContext, withIntentPreclassify, withRequestContext, withAgentPlan, withRequestPreparation, withAskDebugTrace, handleBrowserTaskOrDelegate, handleAskContextRetrieval, handleAskEvidenceResolver, handleAskRetrieval, handleAskTerminalGuard, handleChatMessage);
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
