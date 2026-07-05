'use strict';

// Builds a compact, structured context object from the current request state.
// Runs after withConversationContext and withIntentPreclassify; before handleBrowserTaskOrDelegate.
//
// Output is attached as req._requestContext and forwarded to the Python planner
// as requestContext. Does NOT change routing.

// ─── Retrieval hint derivation ────────────────────────────────────────────────
// Maps pre-classified intent type + mode to which retrieval sources are likely needed.
// These are hints for the planner — not routing instructions.

const _deriveRetrievalHints = (intentType, isActMode, confidence) => ({
  shouldUseCurrentPage:
    ['answer_current_page', 'summarize_page', 'scroll_or_highlight'].includes(intentType),
  shouldUseSiteIndex:
    !isActMode &&
    ['answer_from_site', 'find_document'].includes(intentType) &&
    confidence >= 0.6,
  shouldUseCatalog:
    !isActMode && (intentType === 'unclear' || confidence < 0.5),
  shouldUseDocuments:
    intentType === 'find_document',
  shouldUseBrowser:
    isActMode || ['complex_browser_task', 'open_page'].includes(intentType),
});

// ─── Context builder ──────────────────────────────────────────────────────────

/**
 * Assembles req._requestContext from the fields set by prior middleware.
 * Reads req.body.siteContext directly (not yet normalized by handleBrowserTaskOrDelegate).
 *
 * @param {import('express').Request} req
 * @returns {object}
 */
const buildRequestContext = (req) => {
  const message = String(req.body?.message || '').trim();
  const mode = String(req.body?.mode || req.body?.agentMode || 'ask').toLowerCase();
  const isActMode = mode === 'act';

  const intentClass = req._intentClass || null;
  const conversationContext = req._conversationContext || null;

  const intentType = intentClass?.type || 'unclear';
  const confidence = intentClass?.confidence || 0;

  // Raw siteContext — normalizeSiteContext() hasn't run yet at this point in the chain.
  const rawSiteCtx = req.body?.siteContext || null;
  const hasSiteCtx = Boolean(rawSiteCtx?.url);

  const currentPage = hasSiteCtx
    ? {
        url: String(rawSiteCtx.url || '').slice(0, 200),
        title: String(rawSiteCtx.title || '').slice(0, 100),
        language: String(rawSiteCtx.language || ''),
      }
    : null;

  const pageSignals = hasSiteCtx
    ? {
        headings: Number(rawSiteCtx.stats?.headings) || 0,
        visibleLinksCount: Number(rawSiteCtx.stats?.links) || 0,
        downloadLinksCount: Number(rawSiteCtx.stats?.downloadLinks) || 0,
        buttonsCount: Number(rawSiteCtx.stats?.buttons) || 0,
        formsCount: Number(rawSiteCtx.stats?.forms) || 0,
      }
    : null;

  return {
    message,
    mode,
    intentClass,
    conversationContext,
    currentPage,
    pageSignals,
    retrievalHints: _deriveRetrievalHints(intentType, isActMode, confidence),
    safetyHints: {
      isSensitiveAction: intentType === 'blocked_sensitive_action',
      allowedPublicAction: intentType !== 'blocked_sensitive_action',
    },
  };
};

// ─── Log summary ──────────────────────────────────────────────────────────────

const summarizeRequestContext = (ctx) => {
  const parts = [];

  if (ctx.intentClass) {
    parts.push(`intent=${ctx.intentClass.type}(${ctx.intentClass.confidence.toFixed(2)})`);
  }

  if (ctx.currentPage) {
    const label = (ctx.currentPage.title || ctx.currentPage.url || '').slice(0, 35);
    parts.push(`page="${label}"`);
  }

  if (ctx.pageSignals) {
    parts.push(`links=${ctx.pageSignals.visibleLinksCount} dl=${ctx.pageSignals.downloadLinksCount}`);
  }

  if (ctx.conversationContext?.priorTurns?.length) {
    parts.push(`turns=${ctx.conversationContext.priorTurns.length}`);
  }

  if (ctx.conversationContext?.lastIntent) {
    parts.push(`lastIntent=${ctx.conversationContext.lastIntent}`);
  }

  const h = ctx.retrievalHints || {};
  const active = [
    h.shouldUseCurrentPage && 'page',
    h.shouldUseSiteIndex && 'index',
    h.shouldUseCatalog && 'catalog',
    h.shouldUseDocuments && 'docs',
    h.shouldUseBrowser && 'browser',
  ].filter(Boolean);
  parts.push(`hints=[${active.join(',') || 'none'}]`);

  return parts.join(' ');
};

module.exports = { buildRequestContext, summarizeRequestContext };
