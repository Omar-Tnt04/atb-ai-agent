'use strict';
/**
 * requestRouting.service.js — deterministic message classifiers.
 *
 * Pure regex helpers that decide how a user message should be routed:
 *   - isBrowserAgentTask  → site navigation / document / form request (→ site index)
 *   - isLightweightPageTask → same-page inspect (highlight / scroll / list sections)
 *   - isBrowserTask        → generic "look at a web page" request (standalone demo)
 *   - _routingSignals      → signal breakdown for logging / tests
 *
 * No LLM, no browser-use, no I/O — classification only.
 */

// Credential / financial-transaction keywords — never a public-site nav request.
const TRANSACTION_RE =
  /\b(transfer|send\s+(money|funds)|pay\s+bill|book\s+(appointment|meeting)|cancel|submit|sign\s+in|login)\b/i;

const PERSONAL_RE =
  /\b(my\s+(account|balance|transaction|transfer|bill|card|statement|history|loan))\b/i;

const BROWSE_RE =
  /\b(find|search|look\s+for|explore|navigate|browse|scan|check\s+out|read|visit|inspect)\b/i;

const INFO_RE =
  /\b(what|how|where|which|tell\s+me|show\s+me|list|describe|explain|summarize)\b/i;

const PAGE_RE =
  /\b(page|site|website|demo|homepage|menu|section|feature|option|content|widget|service|product|offer|available|information|detail)\b/i;

// Lightweight same-page inspection — stays on pageControl even when a banking keyword appears.
const PAGE_INSPECT_RE =
  /\b(highlight|scroll\s+to|summari[sz]e|what(?:'?s| is| are)\s+(?:on\s+)?(?:this\s+)?(?:page|visible|here|shown)|what\s+sections?|what\s+links?|which\s+(?:sections?|links?)|list\s+(?:the\s+)?(?:sections?|links?|headings?|menu))\b/i;

// Navigation verbs (FR + EN) meaning "take me to this part of the site".
const SITE_NAV_RE =
  /\b(ouvre[rz]?|va\s+(?:sur|vers?|à|au|a\s+la)|aller\s+(?:sur|vers?|à|au)|acc[eé]der\s+[àa]|go\s+to|take\s+me\s+to|navigate\s+to|trouve[rz]?|trouver|navigue[rz]?|montre[\s-]moi\s+(?:la|le|les)|show\s+me\s+the|find\s+the|open\s+the|je\s+veux\s+(?:acc[eé]der|aller|trouver|voir\s+la|voir\s+le)|je\s+voudrais\s+(?:acc[eé]der|aller|trouver))(?!\w)/i;

// Website-section nouns that ALWAYS mean "navigate to this site section".
const SITE_TARGET_RE =
  /\b(simulateur|simulations?|simuler|simulate|simulator|simul[ae]r\s+(?:un|un\s+)?(?:cr[eé]dit|pr[eê]t|mortgage|loan)|devenir\s+(?:client|membre|atb)|become\s+(?:a\s+)?(?:customer|client|member)|nous\s+contacter|contactez?(?:[-\s]+(?:atb|nous|us))?|contact\s+(?:us|page|atb)|atb\s+connect|espace\s+(?:client|personnel)|online\s+banking|e[\s-]?banking)\b/i;

// Explicit reference to an uploaded or visible document → resource analysis, not nav.
const EXPLICIT_FILE_REF_RE =
  /\b(this\s+(?:document|pdf|file|image|statement|receipt|invoice|bill|photo|scan|notice|relev[eé])|ce(?:tte)?\s+(?:document|image|fichier|relev[eé]|photo|facture|re[cç]u|capture|attestation|notice)|uploaded|que\s+dit\s+ce(?:tte)?\s+|lis\s+(?:cette?|ce)\s+|analyser?\s+(?:ce(?:tte)?|this|le\s+(?:document|fichier|relev[eé]))|extract\s+(?:the\s+)?(?:amount|date|number|info|reference|solde|limit)\s+(?:from|in)\s+this|summarize\s+this)\b/i;

// Serious public-website intents — form / document / navigation / onboarding / agency.
const FORM_DOC_NAV_RE =
  /\b(form|formulaires?|document|documents|dossier|fichier|pdf|t[ée]l[ée]charger|download|export|request|demande|apply|application|onboard|registration|become\s+(?:an?\s+)?(?:atb\s+)?(?:customer|client|member)|devenir\s+(?:client|membre)|open\s+(?:an?\s+)?account|ouvrir\s+(?:un\s+)?compte|credit\s+card|debit\s+card|bank\s+card|carte\s+bancaire|complaint|r[ée]clamation|plainte|problem|probl[èe]me|support|agency|agence|branch|locator|atm|distributeur|online\s+banking|e-?banking|espace\s+client|official)\b/i;

function isBrowserTask(message) {
  const text = String(message || '').toLowerCase();
  if (!text) return false;
  if (TRANSACTION_RE.test(text)) return false;
  if (PERSONAL_RE.test(text)) return false;
  if (BROWSE_RE.test(text)) return true;
  if (INFO_RE.test(text) && PAGE_RE.test(text)) return true;
  return false;
}

function isLightweightPageTask(message) {
  return PAGE_INSPECT_RE.test(String(message || ''));
}

function isBrowserAgentTask(message, { goals = [] } = {}) {
  const text = String(message || '').trim();
  if (!text) return false;
  if (isLightweightPageTask(text)) return false;
  if (TRANSACTION_RE.test(text)) return false;
  if (PERSONAL_RE.test(text)) return false;
  if (EXPLICIT_FILE_REF_RE.test(text)) return false;
  if (Array.isArray(goals) && goals.length > 0) return true;
  if (SITE_TARGET_RE.test(text)) return true;
  return FORM_DOC_NAV_RE.test(text) || SITE_NAV_RE.test(text);
}

function _routingSignals(text) {
  return {
    isLightweight:  isLightweightPageTask(text),
    isTransaction:  TRANSACTION_RE.test(text),
    isPersonal:     PERSONAL_RE.test(text),
    isExplicitFile: EXPLICIT_FILE_REF_RE.test(text),
    isSiteTarget:   SITE_TARGET_RE.test(text),
    isFormDocNav:   FORM_DOC_NAV_RE.test(text),
    isSiteNav:      SITE_NAV_RE.test(text),
  };
}

module.exports = {
  isBrowserTask,
  isBrowserAgentTask,
  isLightweightPageTask,
  _routingSignals,
};
