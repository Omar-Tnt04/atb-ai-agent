'use strict';

// Deterministic intent pre-classifier for widget /chat requests.
// Produces a single { type, target, actionRequired, confidence, reason } object.
// Does NOT change routing — only sets req._intentClass for later observation and future use.
//
// Priority order (first match wins):
//   1. blocked_sensitive_action
//   2. scroll_or_highlight
//   3. summarize_page
//   4. answer_current_page
//   5. find_document
//   6. complex_browser_task
//   7. open_page
//   8. answer_from_site
//   9. unclear

// ─── Patterns ────────────────────────────────────────────────────────────────
// All patterns are case-insensitive. French + English supported.

// 1 — Credential / financial-transaction keywords. Aligned with TRANSACTION_RE in requestRouting.service.js.
const SENSITIVE_RE =
  /\b(login|log[\s-]?in|sign[\s-]?in|connexion|se\s+connecter|mot\s+de\s+passe|password|virement|wire\s+transfer|transfer\s+(?:money|funds)|pay\s+(?:a\s+)?bill|envoyer\s+(?:de\s+l.argent|des?\s+fonds)|code[\s-]?otp|otp\b|pin[\s-]?code|code[\s-]?pin)\b/i;

// 2 — Lightweight same-page inspection: scroll, highlight, list sections/links.
// Mirrors the narrow part of PAGE_INSPECT_RE in requestRouting.service.js.
// Intentionally excludes "summarize" (→ summarize_page) and "what's on this page" (→ answer_current_page).
const SCROLL_HIGHLIGHT_RE =
  /\b(scroll\s+to\b|highlight\b|what\s+(?:sections?|links?|headings?)\s+(?:are\s+)?(?:on\s+(?:this\s+)?page|visible|here|shown)|which\s+(?:sections?|links?|headings?)\s+(?:are\s+)?(?:on\s+(?:this\s+)?page|visible|here)|list\s+(?:the\s+)?(?:sections?|links?|headings?|menu(?:\s+items?)?))\b/i;

// 3 — Summarize the current page.
const SUMMARIZE_PAGE_RE =
  /\b(summari[sz]e\s+(?:this\s+)?page|give\s+(?:me\s+)?a\s+summary|what(?:'?s|\s+is)\s+(?:the\s+)?main\s+(?:content|info|point|topic)|r[eé]sum[eé][rz]?\s+(?:cette\s+)?page|r[eé]cap(?:ituler)?|r[eé]sum[eé]\s+de\s+(la\s+)?page)\b/i;

// 4 — Question about the currently open page.
// Mirrors CURRENT_PAGE_PATTERNS in siteContext.service.js.
const CURRENT_PAGE_RE =
  /\b(this|current|active)\s+page\b|\bwhat\s+page\s+(?:am\s+i\s+(?:on|looking\s+at)|is\s+this)\b|\bwhat(?:'?s|\s+is)\s+(?:on|visible|showing|displayed).{0,30}\b(?:page|screen)\b|\bwhat\s+information\s+(?:is\s+)?(?:visible|on\s+this)\b|\bwhat\s+links?\s+(?:are\s+)?(?:visible|available|on(?:\s+this(?:\s+page)?)?)\b|\bwhat\s+documents?\s+(?:are\s+)?(?:visible|available|on(?:\s+this(?:\s+page)?)?)\b|\bwhat\s+(?:do\s+i\s+see|can\s+i\s+see)\s+(?:here|on\s+this)\b|\bcette\s+page\b|\bpage\s+actuelle\b|\bvisible\s+sur\s+(?:cette|la)\s+page\b|\bsur\s+(?:cette|la)\s+page\b|\bquels?\s+liens?\s+(?:sont\s+)?(?:visibles?|disponibles?)\b|\bquelle\s+(?:est\s+cette\s+)?page\b/i;

// 5a — Find / retrieve a document or form.
// Requires an explicit document-retrieval term (not just "documents" as a noun).
const FIND_DOC_RE =
  /\b(formulaires?|form[s]?\b|pdf\b|t[eé]l[eé]charg(?:er|ement|ez)|download\b|dossier\b|fichier\b|attestation\b|certificat\b|relev[eé]\b|contrat\b|notice\b|fiche\b|brochure\b|demande\s+(?:de|relative\s+[àa]|pour)|request\s+(?:form|for)\b|apply\s+for\b|how\s+to\s+get\b)\b/i;

// 5b — Guard: "what documents do I need" is a content question, not a retrieval request.
const REQUIRED_DOCS_QUESTION_RE =
  /\bdocuments?\b.{0,80}\b(?:need|needed|require|required|necessary|do\s+i\s+need|must\s+i)\b|\b(?:need|needed|require|required|necessary)\b.{0,80}\bdocuments?\b/i;

// 5c — Specificity boost: presence of a concrete ATB product name raises confidence.
const SPECIFIC_DOC_RE =
  /\b(carte\s+bancaire|credit\s+card|debit\s+card|bank\s+card|pr[eê]t\b|loan\b|cr[eé]dit\b|compte\b|account\b|abonnement\b|subscription\b|relev[eé]\b|statement\b|ch[eé]quier|chequebook|checkbook|messenger|atbnet|virement\b|transfer\b|remboursement|inscription|registration|remplacement|replacement)\b/i;

// 6 — Complex browser task: simulator, registration, form-fill.
// Aligned with SITE_TARGET_RE + FORM_DOC_NAV_RE in requestRouting.service.js.
const COMPLEX_BROWSER_RE =
  /\b(simulateur|simul(?:er|ation)|simulate|simulator|remplir\b|fill\s+out|fill\s+in|soumettre\b|s.inscrire\b|register\b|cr[eé]er\s+un\s+compte|open\s+an?\s+account|ouvrir\s+un\s+compte|devenir\s+(?:client|membre)|become\s+(?:a\s+)?(?:client|member|customer)|onboard(?:ing)?\b|s.abonner\b|subscribe\b|application\s+for\b|calculateur|calculer\s+(?:un|mon)|loan\s+simulator|mortgage\s+simulator)\b/i;

// 7 — Navigation to a page / section of the site.
// Aligned with SITE_NAV_RE in requestRouting.service.js.
const OPEN_PAGE_RE =
  /\b(go\s+to\b|navigate\s+to\b|take\s+me\s+to\b|open\s+(?:the\s+)?(?:page|section|site|website)\b|aller\s+(?:sur|vers?|[àa]|au)\b|va\s+(?:sur|vers?|[àa]|au)\b|ouvre[rz]?\b|acc[eé]der\s+[àa]|montre[\s-]moi\s+(?:la|le|les)\s+page|je\s+veux\s+(?:acc[eé]der|aller|voir\s+(?:la|le))|je\s+voudrais\s+(?:acc[eé]der|aller|trouver)|navigue[rz]?\s+vers?)\b/i;

// 8 — Site-level information question (hours, rates, branches, contact).
const SITE_ANSWER_RE =
  /\b(what\s+(?:services?|products?|offers?|rates?|fees?|conditions?|hours?|branches?)\b|opening\s+hours?\b|horaires?\b|agences?\b|tarif(?:ication)?\b|taux\b|frais\b|adresses?\b|t[eé]l[eé]phone\b|e[\s-]?mail\b|nous\s+contacter\b|contactez?\s+(?:atb|nous)\b|how\s+(?:much|many|long|do\s+i)\b|est[\s-]ce\s+que\s+atb|qu.est[\s-]ce\s+que\b|does\s+atb\s+offer\b|what\s+does\s+atb\b)\b/i;


// ─── Target extraction ────────────────────────────────────────────────────────

const _STOP = new Set([
  'le','la','les','un','une','des','du','de','d','the','a','an','of','for',
  'in','on','at','to','by','with','and','or','but','je','me','my','mon','ma',
  'mes','sur','dans','pour','avec','et','ou','est','cette','ce','ces','atb',
  'i','you','we','votre','vos','nos','notre','leur','leurs','que','qui',
  'what','how','where','when','which','is','are','do','does','can','could',
]);

const _extractTarget = (text, type) => {
  const raw = String(text || '').trim();

  if (type === 'find_document') {
    const m =
      raw.match(/(?:formulaire|form)\s+(?:de\s+|pour\s+|d.une?\s+)?(.{3,50}?)(?:\s*[?,.!]|$)/i) ||
      raw.match(/(?:demande|request|apply\s+for)\s+(?:de\s+|pour\s+|un[e]?\s+|la\s+|le\s+)?(.{3,50}?)(?:\s*[?,.!]|$)/i) ||
      raw.match(/(?:t[eé]l[eé]charger|download)\s+(?:le\s+|la\s+|les?\s+|un[e]?\s+)?(.{3,50}?)(?:\s*[?,.!]|$)/i) ||
      raw.match(/(?:document|dossier|fiche|notice|guide|brochure)\s+(?:de\s+|du\s+|pour\s+|d.une?\s+)?(.{3,50}?)(?:\s*[?,.!]|$)/i);
    if (m?.[1]) return m[1].replace(/[?.,!]+$/, '').trim().slice(0, 60);
  }

  if (type === 'open_page' || type === 'complex_browser_task') {
    const m =
      raw.match(/(?:go\s+to|navigate\s+to|take\s+me\s+to|open\s+(?:the\s+)?)\s+(.{3,60}?)(?:\s*[?,.!]|$)/i) ||
      raw.match(/(?:aller\s+(?:sur|[àa]|au)|ouvre[rz]?\s+|acc[eé]der\s+[àa]|montre[\s-]moi\s+(?:la|le|les))\s+(.{3,60}?)(?:\s*[?,.!]|$)/i);
    if (m?.[1]) return m[1].replace(/[?.,!]+$/, '').trim().slice(0, 60);
  }

  // Generic: first 3 non-stop content words
  const words = raw.replace(/[?.,!:;]+/g, ' ').split(/\s+/).filter(Boolean);
  const content = words.filter((w) => w.length > 2 && !_STOP.has(w.toLowerCase()));
  return content.slice(0, 3).join(' ').slice(0, 60) || raw.slice(0, 60);
};


// ─── Main classifier ─────────────────────────────────────────────────────────

/**
 * Classifies a widget message into one of 9 intent types.
 * Pure function — no I/O, no side effects.
 *
 * @param {string} message
 * @param {{ siteContextUrl?: string }} [opts]
 * @returns {{ type: string, target: string, actionRequired: boolean, confidence: number, reason: string }}
 */
const classifyIntent = (message, { siteContextUrl = '' } = {}) => {
  if (!message || typeof message !== 'string' || !message.trim()) {
    return {
      type: 'unclear',
      target: '',
      actionRequired: false,
      confidence: 0.0,
      reason: 'Empty message.',
    };
  }

  const t = String(message).toLowerCase().replace(/\s+/g, ' ').trim();

  // 1 — Blocked sensitive action
  if (SENSITIVE_RE.test(t)) {
    return {
      type: 'blocked_sensitive_action',
      target: _extractTarget(message, 'blocked_sensitive_action'),
      actionRequired: false,
      confidence: 0.92,
      reason: 'Credential or financial-transaction keyword detected.',
    };
  }

  // 2 — Scroll / highlight
  if (SCROLL_HIGHLIGHT_RE.test(t)) {
    return {
      type: 'scroll_or_highlight',
      target: _extractTarget(message, 'scroll_or_highlight'),
      actionRequired: false,
      confidence: 0.87,
      reason: 'Scroll, highlight, or list-sections keyword detected.',
    };
  }

  // 3 — Summarize page
  if (SUMMARIZE_PAGE_RE.test(t)) {
    return {
      type: 'summarize_page',
      target: siteContextUrl || '',
      actionRequired: false,
      confidence: 0.88,
      reason: 'Page summarize verb detected.',
    };
  }

  // 4 — Answer from current page context
  if (CURRENT_PAGE_RE.test(t)) {
    return {
      type: 'answer_current_page',
      target: siteContextUrl || '',
      actionRequired: false,
      confidence: siteContextUrl ? 0.90 : 0.72,
      reason: siteContextUrl
        ? 'Current-page reference with site context available.'
        : 'Current-page reference; no site context in this request.',
    };
  }

  // 5 — Find / retrieve a document or form
  //     Guard: "what documents do I need" is a content question, not a retrieval.
  if (FIND_DOC_RE.test(t) && !REQUIRED_DOCS_QUESTION_RE.test(t)) {
    const specific = SPECIFIC_DOC_RE.test(t);
    return {
      type: 'find_document',
      target: _extractTarget(message, 'find_document'),
      actionRequired: true,
      confidence: specific ? 0.88 : 0.72,
      reason: specific
        ? 'Document/form keyword with specific ATB product context.'
        : 'Generic document/form retrieval keyword detected.',
    };
  }

  // 6 — Complex browser task (simulator, registration, form-fill)
  if (COMPLEX_BROWSER_RE.test(t)) {
    return {
      type: 'complex_browser_task',
      target: _extractTarget(message, 'complex_browser_task'),
      actionRequired: true,
      confidence: 0.85,
      reason: 'Multi-step browser interaction keyword detected.',
    };
  }

  // 7 — Navigate to a page
  if (OPEN_PAGE_RE.test(t)) {
    return {
      type: 'open_page',
      target: _extractTarget(message, 'open_page'),
      actionRequired: true,
      confidence: 0.82,
      reason: 'Site navigation verb detected.',
    };
  }

  // 8 — Site-level information question
  if (SITE_ANSWER_RE.test(t)) {
    return {
      type: 'answer_from_site',
      target: _extractTarget(message, 'answer_from_site'),
      actionRequired: false,
      confidence: 0.74,
      reason: 'Site-level information query detected.',
    };
  }

  // 9 — Unclear: falls through to existing catalog/AI routing
  return {
    type: 'unclear',
    target: _extractTarget(message, 'unclear'),
    actionRequired: false,
    confidence: 0.30,
    reason: 'No strong pattern matched; existing routing will handle.',
  };
};

module.exports = { classifyIntent };
