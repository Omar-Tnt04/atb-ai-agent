'use strict';
/**
 * ASK EXACT-CONTEXT / UNIFIED EVIDENCE LAYER — optional exact page-text for Ask mode.
 * ------------------------------------------------------------------------------
 * Loads site-context/<domain>/ask-exact-context.json and treats ALL page text as
 * evidence CANDIDATES that are ranked by relevance — there is NO hardcoded list of
 * "allowed" page ids. A hub/list page (e.g. /nos-agences-en-tunisie) can supply exact
 * evidence exactly like a product page; noisy menu/footer chunks are pushed down by a
 * boilerplate penalty, not by id blocking.
 *
 * Never required: missing/invalid/empty file → selectExactEvidence returns [] and Ask
 * mode behaves as before (ask-context.json + catalog.json). Read-only.
 *
 * Ranking is generic (rankEvidenceCandidates): token/phrase overlap, url/title match,
 * current-page boost, per-kind source weighting tuned by broad INTENT, minus a
 * boilerplate penalty on exact chunks. Intent decides page-text vs document evidence:
 *   document_or_form_request → prefer document/form/catalog_resource
 *   page_information_request → prefer relevant exact_chunk + key_point
 *   comparison_request       → allow evidence from multiple blocks
 *   current_page_request     → strongly boost currentUrl-matching exact chunks
 */

const fs = require('fs');
const path = require('path');
const { targetDomain, tokenize, stemMatch, foldAccents } = require('./askContext.service');

const SITE_CONTEXT_DIR = path.join(__dirname, '../../..', 'site-context');

function askExactContextPath(domain = targetDomain()) {
  return path.join(SITE_CONTEXT_DIR, domain, 'ask-exact-context.json');
}

// ── load + cache ────────────────────────────────────────────────────────────────
const _mem = new Map();
const MEM_TTL_MS = 5 * 60 * 1000;

function loadAskExactContext(domain = targetDomain()) {
  const now = Date.now();
  const hit = _mem.get(domain);
  if (hit && (now - hit.at) < MEM_TTL_MS) return hit.data;
  let data = null;
  try {
    const file = askExactContextPath(domain);
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (parsed && Array.isArray(parsed.exactBlocks) && parsed.exactBlocks.length > 0) data = parsed;
    }
  } catch { data = null; }
  _mem.set(domain, { data, at: now });
  return data;
}
function clearAskExactContextCache() { _mem.clear(); }

// ── canonical URL ─────────────────────────────────────────────────────────────
function canonUrl(u) {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '')).toLowerCase();
  } catch {
    return String(u || '').toLowerCase().replace(/[#?].*$/, '').replace(/\/+$/, '');
  }
}

// ── broad intent detection (page-agnostic) ──────────────────────────────────────
const RE_DOCUMENT = /\b(t[eé]l[eé]charg\w*|download|ouvrir|open|pdf|document|formulaire|fichier|imprimer|remplir)\b/i;
const RE_COMPARE = /\b(diff[eé]rence|comparer|compare|versus|\bvs\b)\b|\bentre\b[\s\S]{0,40}\bet\b/i;
const RE_CURRENT = /\b(cette\s+page|sur\s+cette\s+page|\bici\b|ce\s+service|cette\s+liste|page\s+actuelle)\b/i;
const RE_PAGEINFO = /\b(donne[- ]?moi|explique\w*|c(?:'|’)?est\s+quoi|quels?\s+sont|quelles?\s+sont|o[uù]\s+(?:sont|se|est)|liste|horaires?|conditions?|d[eé]tails?|combien|comment|taux|adresse|coordonn[eé]es|contact)\b/i;

function detectAskIntent(query) {
  const q = String(query || '');
  const isComparison = RE_COMPARE.test(q);
  const isDocument = RE_DOCUMENT.test(q);
  const isCurrentPage = RE_CURRENT.test(q);
  const isPageInfo = !isDocument && RE_PAGEINFO.test(q); // document wording wins over page-info
  let intent = 'general_question';
  if (isComparison) intent = 'comparison_request';
  else if (isDocument) intent = 'document_or_form_request';
  else if (isCurrentPage) intent = 'current_page_request';
  else if (isPageInfo) intent = 'page_information_request';
  return { intent, isComparison, isDocument, isCurrentPage, isPageInfo };
}

// ── boilerplate fraction (global nav/menu/footer labels), phrase-based ──────────
// Phrase-based (not single tokens) so a word like "agence" that appears in real agency
// content is NOT penalized — only global-nav LABELS are.
const BOILERPLATE_PHRASES = [
  'espace particuliers', 'espace professionnels', 'espace entreprises', 'espace finance',
  'documents utiles', 'devenir client', 'nous contacter', 'trouver votre agence',
  'enquete de satisfaction', 'mentions legales', 'plan du site', 'assistance entreprises',
  'se connecter', 'prix atb', 'tarifs engagement qualite', 'conseils cartes bancaires',
  'mediateur de l atb', 'a propos', 'histoire de l atb', 'vision de l atb', 'newsletter',
  'recrutement', 'atbchallenge', 'devenez client',
];
// foldAccents strips diacritics but preserves case; lowercase here so the lowercase
// phrase/word lists actually match.
const foldLower = (s) => foldAccents(s).toLowerCase();

function boilerplateFraction(text) {
  const f = foldLower(text);
  if (!f) return 0;
  let covered = 0;
  for (const p of BOILERPLATE_PHRASES) {
    let i = f.indexOf(p);
    while (i !== -1) { covered += p.length; i = f.indexOf(p, i + p.length); }
  }
  return Math.min(1, covered / f.length);
}

// ── relevance helpers ───────────────────────────────────────────────────────────
function relevance(qTokens, text) {
  if (!qTokens.length) return 0;
  const toks = tokenize(text);
  if (!toks.length) return 0;
  const matched = new Set();
  for (const qt of qTokens) if (toks.some((t) => stemMatch(qt, t))) matched.add(qt);
  return matched.size / qTokens.length;
}
function phraseHits(query, text) {
  const words = foldLower(query).split(/\s+/).filter((w) => w.length >= 3);
  const f = foldLower(text);
  let h = 0;
  for (let i = 0; i < words.length - 1; i++) if (f.includes(`${words[i]} ${words[i + 1]}`)) h++;
  return h;
}

// Base per-kind weight, adjusted by intent. Generic — no page ids involved.
function intentWeight(kind, intent) {
  const base = { exact_chunk: 1.0, key_point: 0.9, rich_context: 0.7, document: 0.6, form: 0.6, catalog_resource: 0.6 }[kind] || 0.5;
  let adj = 0;
  if (intent.isDocument) {
    if (kind === 'document' || kind === 'form' || kind === 'catalog_resource') adj += 0.9;
    if (kind === 'exact_chunk' || kind === 'rich_context') adj -= 0.7;
  } else if (intent.isPageInfo || intent.isCurrentPage) {
    if (kind === 'exact_chunk') adj += 0.4;
    if (kind === 'key_point') adj += 0.3;
    if (kind === 'document' || kind === 'catalog_resource') adj -= 0.2;
  }
  if (intent.isCurrentPage && kind === 'exact_chunk') adj += 0.3;
  return base + adj;
}

/**
 * Rank a UNIFIED list of evidence candidates by relevance. Attaches score/relevance/
 * currentMatch/reasons and returns a new array sorted desc. Pure — no page ids.
 * @param candidates [{ sourceFile, sourceType, evidenceKind, id, url, title, text, metadata }]
 */
function rankEvidenceCandidates(query, candidates, { intent, currentUrl } = {}) {
  const it = intent || detectAskIntent(query);
  const qTokens = tokenize(query);
  const cu = currentUrl ? canonUrl(currentUrl) : null;
  const list = (candidates || []).map((c) => {
    const useful = (c.metadata && c.metadata.usefulForQuestionsAbout) || [];
    const matchText = [c.title, c.url, Array.isArray(useful) ? useful.join(' ') : '', c.text].filter(Boolean).join(' ');
    const rel = relevance(qTokens, matchText);
    const utRel = relevance(qTokens, `${c.title || ''} ${c.url || ''}`);
    const ph = phraseHits(query, c.text || '');
    const boiler = c.evidenceKind === 'exact_chunk' ? boilerplateFraction(c.text) : 0;
    const currentMatch = !!(cu && c.url && canonUrl(c.url) === cu);
    const iw = intentWeight(c.evidenceKind, it);
    const score = 2.0 * rel + 0.2 * ph + 0.4 * utRel + iw + (currentMatch ? 0.6 : 0) - (c.evidenceKind === 'exact_chunk' ? 1.5 * boiler : 0);
    const reasons = [
      `rel=${rel.toFixed(2)}`, `iw=${iw.toFixed(2)}`,
      ph ? `phrase=${ph}` : null, currentMatch ? 'currentPage' : null, boiler > 0.3 ? `boiler=${boiler.toFixed(2)}` : null,
    ].filter(Boolean);
    return { ...c, relevance: rel, currentMatch, boiler, score, reasons };
  });
  return list.sort((a, b) => b.score - a.score);
}

// ── candidate builders (one per source) ─────────────────────────────────────────
function buildExactCandidates(exactContext) {
  const out = [];
  const blocks = exactContext && Array.isArray(exactContext.exactBlocks) ? exactContext.exactBlocks : [];
  for (const b of blocks) {
    for (const ch of Array.isArray(b.exactChunks) ? b.exactChunks : []) {
      out.push({
        sourceFile: 'ask-exact-context.json', sourceType: 'exact', evidenceKind: 'exact_chunk',
        id: b.id || '', url: b.url || '', title: b.title || '', text: String(ch.text || ''),
        metadata: { language: b.language, usefulForQuestionsAbout: b.usefulForQuestionsAbout || [], chunkIndex: ch.chunkIndex },
      });
    }
  }
  return out;
}
function buildAskContextCandidates(askBlocks) {
  const out = [];
  for (const item of Array.isArray(askBlocks) ? askBlocks : []) {
    const b = item && item.block;
    if (!b) continue;
    const meta = { url: b.url || '', usefulForQuestionsAbout: b.usefulForQuestionsAbout || [] };
    if (b.richContext || b.promptText) {
      out.push({ sourceFile: 'ask-context.json', sourceType: 'ask-context', evidenceKind: 'rich_context', id: b.id || '', url: b.url || '', title: b.title || '', text: String(b.richContext || b.promptText || ''), metadata: meta });
    }
    for (const k of Array.isArray(b.keyPoints) ? b.keyPoints : []) {
      out.push({ sourceFile: 'ask-context.json', sourceType: 'ask-context', evidenceKind: 'key_point', id: b.id || '', url: b.url || '', title: k.point || b.title || '', text: `${k.point || ''} ${k.evidence || ''}`.trim(), metadata: meta });
    }
    for (const d of Array.isArray(b.documents) ? b.documents : []) {
      out.push({ sourceFile: 'ask-context.json', sourceType: 'ask-context', evidenceKind: 'document', id: b.id || '', url: d.url || d.href || b.url || '', title: d.title || d.text || 'document', text: `${d.title || d.text || ''} ${d.url || d.href || ''}`.trim(), metadata: meta });
    }
    for (const fm of Array.isArray(b.forms) ? b.forms : []) {
      out.push({ sourceFile: 'ask-context.json', sourceType: 'ask-context', evidenceKind: 'form', id: b.id || '', url: fm.url || fm.href || b.url || '', title: fm.title || fm.text || 'form', text: `${fm.title || fm.text || ''} ${fm.url || fm.href || ''}`.trim(), metadata: meta });
    }
  }
  return out;
}
function buildCatalogCandidates(catalogEntries) {
  return (Array.isArray(catalogEntries) ? catalogEntries : []).map((e) => ({
    sourceFile: 'catalog.json', sourceType: 'catalog', evidenceKind: 'catalog_resource',
    id: e.id || '', url: e.url || '', title: e.title || '', text: `${e.title || ''} ${e.description || ''} ${e.evidence || ''}`.trim(),
    metadata: { category: e.category },
  }));
}

/**
 * Select exact evidence for the query by ranking ALL exact chunks (no id gating).
 * Keeps only query-relevant (or current-page) chunks above a floor, grouped per block.
 * @returns [{ blockId, url, title, chunks: string[] }]
 */
function selectExactEvidence(exactContext, { message = '', currentUrl = null } = {}) {
  if (!exactContext || !Array.isArray(exactContext.exactBlocks) || exactContext.exactBlocks.length === 0) return [];
  const intent = detectAskIntent(message);
  const ranked = rankEvidenceCandidates(message, buildExactCandidates(exactContext), { intent, currentUrl });
  const FLOOR = intent.isDocument ? 2.0 : 0.6; // doc intent → exact rarely clears the bar
  const maxBlocks = intent.isComparison ? 5 : 3;
  const perBlock = 3;
  const byBlock = new Map();
  for (const c of ranked) {
    if (!(c.relevance > 0 || c.currentMatch)) continue; // must actually relate to the query
    if (c.score < FLOOR) continue;
    const key = c.id || canonUrl(c.url);
    if (!byBlock.has(key)) {
      if (byBlock.size >= maxBlocks) continue;
      byBlock.set(key, { blockId: c.id || '', url: c.url || '', title: c.title || '', chunks: [] });
    }
    const g = byBlock.get(key);
    if (g.chunks.length < perBlock) g.chunks.push(c.text);
  }
  return [...byBlock.values()].filter((g) => g.chunks.length);
}

/** Production entry: load + select. Returns [] on any absence (silent fallback). */
function buildExactEvidence({ domain = targetDomain(), message = '', currentUrl = null } = {}) {
  return selectExactEvidence(loadAskExactContext(domain), { message, currentUrl });
}

const _isAtbPageUrl = (u) => {
  try { const p = new URL(u); return (p.protocol === 'https:' || p.protocol === 'http:') && p.hostname.replace(/^www\./, '').endsWith('atb.tn'); }
  catch { return false; }
};

/**
 * Pick the ONE useful-link URL to show under an ASK answer, derived from the SELECTED
 * evidence (never from stale current-page state or a previous action). Ranks the same
 * unified candidates the answer used and applies intent-based source priority:
 *   document_or_form_request → top document/form/catalog URL
 *   otherwise               → top exact_chunk URL, then rich_context/key_point, then doc/catalog
 * currentUrl is only a last resort (no evidence URL at all). The current-page boost still
 * applies inside ranking, so a currentUrl that IS a selected evidence URL can win normally.
 * @returns { url, sourceFile, sourceType, id, title, reason } or null.
 */
function selectAskAnswerLink({ message = '', exactEvidence = [], askBlocks = [], catalogEntries = [], currentUrl = null } = {}) {
  const intent = detectAskIntent(message);
  const cands = [];
  for (const e of exactEvidence || []) {
    if (e && e.url) cands.push({ evidenceKind: 'exact_chunk', sourceFile: 'ask-exact-context.json', id: e.blockId || '', url: e.url, title: e.title || '', text: (e.chunks || []).join(' '), metadata: {} });
  }
  cands.push(...buildAskContextCandidates(askBlocks).filter((c) => c.url));
  cands.push(...buildCatalogCandidates(catalogEntries).filter((c) => c.url));

  const ranked = rankEvidenceCandidates(message, cands, { intent, currentUrl }).filter((c) => _isAtbPageUrl(c.url));
  const firstOf = (kinds) => ranked.find((c) => kinds.includes(c.evidenceKind));

  let chosen = null;
  let reason = '';
  if (intent.isDocument) {
    chosen = firstOf(['document', 'form', 'catalog_resource']) || ranked[0] || null;
    reason = chosen ? `document_intent_${chosen.evidenceKind}` : 'none';
  } else {
    chosen = firstOf(['exact_chunk'])
      || firstOf(['rich_context', 'key_point'])
      || firstOf(['document', 'catalog_resource', 'form'])
      || ranked[0] || null;
    reason = chosen ? `top_${chosen.evidenceKind}` : 'none';
  }

  if (!chosen) {
    // Last resort only: current page, and only if it is a real ATB page URL.
    if (currentUrl && _isAtbPageUrl(currentUrl)) return { url: currentUrl, sourceFile: 'current-page', sourceType: 'current_page', id: '', title: '', reason: 'fallback_current_url' };
    return null;
  }
  return { url: chosen.url, sourceFile: chosen.sourceFile || '', sourceType: chosen.evidenceKind, id: chosen.id || '', title: chosen.title || '', reason };
}

module.exports = {
  askExactContextPath,
  loadAskExactContext,
  clearAskExactContextCache,
  canonUrl,
  detectAskIntent,
  boilerplateFraction,
  rankEvidenceCandidates,
  buildExactCandidates,
  buildAskContextCandidates,
  buildCatalogCandidates,
  selectExactEvidence,
  buildExactEvidence,
  selectAskAnswerLink,
};
