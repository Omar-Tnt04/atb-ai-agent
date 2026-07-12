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
 * SINGLE SOURCE OF TRUTH (buildAskEvidencePack):
 *   candidates (exact chunks + ask-context blocks + catalog entries)
 *     → ONE ranking pass (rankEvidenceCandidates)
 *     → ONE selected evidence pack (selectEvidencePack)  ← the only thing synthesis sees
 *     → the useful link (selectAskAnswerLink) chosen FROM THAT PACK, never re-ranked from
 *       the raw candidate universe. Answer grounding and link selection cannot diverge.
 *
 * Ranking is generic (rankEvidenceCandidates): rarity-weighted (idf) token overlap so
 * brand/common tokens ("atb", "banque", "service") barely count, an IDENTITY score (title/
 * id/URL slug/usefulForQuestionsAbout — what a page IS, vs what its nav merely mentions),
 * phrase hits, current-page boost, per-kind source weighting tuned by broad INTENT, minus a
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
// Query tokens are weighted by RARITY (idf) over the candidate set, so brand/common
// tokens ("atb", "banque", "service", "client") — which appear in nearly every page,
// menu and footer — carry almost no discriminative weight, while a rare token
// ("connect", "mobilink", "renov") dominates. Fully generic: no entity is named here.
function idfWeights(qTokens, docTokenSets) {
  const N = docTokenSets.length || 1;
  const w = new Map();
  for (const qt of qTokens) {
    let df = 0;
    for (const toks of docTokenSets) if (toks.some((t) => stemMatch(qt, t))) df++;
    w.set(qt, Math.log(1 + N / (1 + df)));
  }
  return w;
}

/** Rarity-weighted share of the query covered by `toks`. 0..1. */
function weightedRelevance(qTokens, weights, toks) {
  let total = 0;
  let got = 0;
  for (const qt of qTokens) {
    const wt = weights.get(qt) || 0;
    total += wt;
    if (toks.some((t) => stemMatch(qt, t))) got += wt;
  }
  return total > 0 ? got / total : 0;
}

// Accent-folded, separator-free form: "services-banque-atbconnect" → "servicesbanqueatbconnect".
// Lets a query token match inside a slug/id that no tokenizer would ever split ("atbconnect").
const compact = (s) => foldLower(s).replace(/[^a-z0-9]+/g, '');

// The IDENTITY of a candidate: what it *is* (title, id, URL slug, curated hints) as
// opposed to what its page text merely *mentions*. A global nav menu on the Crédit Start
// page mentions "ATB Connect"; only the ATB Connect page is *identified* by it.
function identityText(c) {
  const useful = (c.metadata && c.metadata.usefulForQuestionsAbout) || [];
  return [c.title, c.id, c.url, Array.isArray(useful) ? useful.join(' ') : useful].filter(Boolean).join(' ');
}

/** Rarity-weighted share of the query present in the candidate's identity fields. 0..1. */
function identityRelevance(qTokens, weights, idText) {
  const toks = tokenize(idText);
  const flat = compact(idText);
  let total = 0;
  let got = 0;
  for (const qt of qTokens) {
    const wt = weights.get(qt) || 0;
    total += wt;
    if (toks.some((t) => stemMatch(qt, t)) || (qt.length >= 4 && flat.includes(qt))) got += wt;
  }
  return total > 0 ? got / total : 0;
}

/** 1 when an adjacent query phrase appears in the identity ("atb connect" → …atbconnect). */
function identityPhraseHit(qTokens, idText) {
  const flat = compact(idText);
  for (let i = 0; i < qTokens.length - 1; i++) if (flat.includes(qTokens[i] + qTokens[i + 1])) return 1;
  return 0;
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
  const list = (candidates || []);

  // Per-candidate searchable surfaces, computed once (identity + full text).
  const prepared = list.map((c) => {
    const idText = identityText(c);
    const useful = (c.metadata && c.metadata.usefulForQuestionsAbout) || [];
    const matchText = [c.title, c.url, Array.isArray(useful) ? useful.join(' ') : useful, c.text].filter(Boolean).join(' ');
    return { c, idText, textToks: tokenize(matchText) };
  });
  // idf over the candidate universe being ranked → generic common-token damping.
  const weights = idfWeights(qTokens, prepared.map((p) => p.textToks));

  const scored = prepared.map(({ c, idText, textToks }) => {
    const rel = weightedRelevance(qTokens, weights, textToks);
    const idRel = identityRelevance(qTokens, weights, idText);
    const idPhrase = identityPhraseHit(qTokens, idText);
    const ph = phraseHits(query, c.text || '');
    const boiler = c.evidenceKind === 'exact_chunk' ? boilerplateFraction(c.text) : 0;
    const currentMatch = !!(cu && c.url && canonUrl(c.url) === cu);
    const iw = intentWeight(c.evidenceKind, it);
    // Identity outweighs mere text mention: a page that IS the subject beats a page that
    // only links to it from its nav menu (the Crédit Start vs ATB Connect failure).
    const score = 1.2 * rel + 1.6 * idRel + 0.8 * idPhrase + 0.2 * ph + iw
      + (currentMatch ? 0.6 : 0)
      - (c.evidenceKind === 'exact_chunk' ? 1.5 * boiler : 0);
    const reasons = [
      `rel=${rel.toFixed(2)}`, `id=${idRel.toFixed(2)}`, idPhrase ? 'idPhrase' : null, `iw=${iw.toFixed(2)}`,
      ph ? `phrase=${ph}` : null, currentMatch ? 'currentPage' : null, boiler > 0.3 ? `boiler=${boiler.toFixed(2)}` : null,
    ].filter(Boolean);
    return { ...c, relevance: rel, identityRelevance: idRel, currentMatch, boiler, score, reasons };
  });
  return scored.sort((a, b) => b.score - a.score);
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

// ── SINGLE SOURCE OF TRUTH: one ranked list → one selected evidence pack ────────
/**
 * Select the FINAL evidence pack from ONE ranked unified candidate list.
 * Exact chunks are gated (relevance/floor/per-block caps); ask-context blocks and catalog
 * entries were already selected by their own retrievers and are therefore always part of
 * the pack (synthesis receives them whole) — they just keep their rank here.
 * @returns selectedEvidence: [{ sourceFile, evidenceKind, id, url, title, text, score, reasons }]
 *          in rank order — the ONLY list the answer AND the link may come from.
 */
function selectEvidencePack(ranked, intent) {
  const FLOOR = intent.isDocument ? 2.0 : 0.6; // doc intent → exact rarely clears the bar
  const maxBlocks = intent.isComparison ? 5 : 3;
  const perBlock = 3;
  const chunkCount = new Map();
  const out = [];
  for (const c of ranked) {
    if (c.evidenceKind !== 'exact_chunk') { out.push(c); continue; }
    if (!(c.relevance > 0 || c.currentMatch)) continue; // must actually relate to the query
    if (c.score < FLOOR) continue;
    const key = c.id || canonUrl(c.url);
    if (!chunkCount.has(key)) {
      if (chunkCount.size >= maxBlocks) continue;
      chunkCount.set(key, 0);
    }
    if (chunkCount.get(key) >= perBlock) continue;
    chunkCount.set(key, chunkCount.get(key) + 1);
    out.push(c);
  }
  return out;
}

/** Group the pack's exact chunks into the per-block shape synthesis consumes. */
function groupExactEvidence(selectedEvidence) {
  const byBlock = new Map();
  for (const c of selectedEvidence) {
    if (c.evidenceKind !== 'exact_chunk') continue;
    const key = c.id || canonUrl(c.url);
    if (!byBlock.has(key)) byBlock.set(key, { blockId: c.id || '', url: c.url || '', title: c.title || '', chunks: [] });
    byBlock.get(key).chunks.push(c.text);
  }
  return [...byBlock.values()].filter((g) => g.chunks.length);
}

const _isAtbPageUrl = (u) => {
  try { const p = new URL(u); return (p.protocol === 'https:' || p.protocol === 'http:') && p.hostname.replace(/^www\./, '').endsWith('atb.tn'); }
  catch { return false; }
};

/**
 * Pick the ONE useful-link URL shown under an ASK answer — STRICTLY from the already
 * selected evidence pack. It does NOT re-rank the raw candidate universe: a candidate the
 * answer never saw can never supply the link (that divergence was the Crédit Start bug).
 *   document_or_form_request → top selected document/form/catalog URL
 *   comparison_request       → top selected page, or none when no page clearly dominates
 *   otherwise                → top selected exact_chunk, then rich_context/key_point, then doc/catalog
 * currentUrl is a last resort only (no selected evidence carries a valid ATB URL).
 * @returns { url, sourceFile, sourceType, id, title, score, reason, derivedFrom } | null
 */
function selectAskAnswerLink({ message = '', selectedEvidence = [], intent = null, currentUrl = null } = {}) {
  const it = intent || detectAskIntent(message);
  const pool = (selectedEvidence || []).filter((c) => c.url && _isAtbPageUrl(c.url)); // pack order = rank order
  const firstOf = (kinds) => pool.find((c) => kinds.includes(c.evidenceKind));

  let chosen = null;
  let reason = '';
  if (it.isDocument) {
    chosen = firstOf(['document', 'form', 'catalog_resource']) || pool[0] || null;
    reason = chosen ? `document_intent_${chosen.evidenceKind}` : 'none';
  } else if (it.isComparison) {
    // Comparison: only offer a link when ONE page clearly dominates the others.
    const pages = pool.filter((c) => c.evidenceKind !== 'document' && c.evidenceKind !== 'form');
    const top = pages[0];
    const rival = pages.find((c) => top && canonUrl(c.url) !== canonUrl(top.url));
    if (top && (!rival || top.score - rival.score >= 0.25)) { chosen = top; reason = 'comparison_dominant_page'; }
    else return null; // no single page dominates → no single link
  } else {
    chosen = firstOf(['exact_chunk'])
      || firstOf(['rich_context', 'key_point'])
      || firstOf(['document', 'catalog_resource', 'form'])
      || pool[0] || null;
    reason = chosen ? `top_${chosen.evidenceKind}` : 'none';
  }

  if (!chosen) {
    // Last resort only: current page, and only if it is a real ATB page URL.
    if (currentUrl && _isAtbPageUrl(currentUrl)) {
      return { url: currentUrl, sourceFile: 'current-page', sourceType: 'current_page', id: '', title: '', score: 0, reason: 'fallback_current_url', derivedFrom: 'current_url' };
    }
    return null;
  }
  return {
    url: chosen.url, sourceFile: chosen.sourceFile || '', sourceType: chosen.evidenceKind,
    id: chosen.id || '', title: chosen.title || '', score: Number((chosen.score || 0).toFixed(3)),
    reason, derivedFrom: 'selected_evidence',
  };
}

/**
 * PRODUCTION ENTRY — the single retrieval→selection→link flow for ASK.
 * 1. one unified candidate list (exact chunks + ask-context blocks + catalog entries)
 * 2. one ranking pass
 * 3. one selected evidence pack (what synthesis is allowed to use)
 * 4. the useful link, chosen from that same pack — never re-ranked independently
 * @returns { selectedEvidence, exactEvidence, askLink, intent }
 */
function buildAskEvidencePack({
  domain = targetDomain(), message = '', currentUrl = null,
  askBlocks = [], catalogEntries = [], exactContext,
} = {}) {
  const intent = detectAskIntent(message);
  const ctx = exactContext !== undefined ? exactContext : loadAskExactContext(domain);
  const candidates = [
    ...buildExactCandidates(ctx),
    ...buildAskContextCandidates(askBlocks),
    ...buildCatalogCandidates(catalogEntries),
  ];
  const ranked = rankEvidenceCandidates(message, candidates, { intent, currentUrl });
  const selectedEvidence = selectEvidencePack(ranked, intent);
  return {
    selectedEvidence,
    exactEvidence: groupExactEvidence(selectedEvidence),
    askLink: selectAskAnswerLink({ message, selectedEvidence, intent, currentUrl }),
    intent,
  };
}

/** Exact-only view of the pack (kept for callers/tests that only need page chunks). */
function selectExactEvidence(exactContext, { message = '', currentUrl = null } = {}) {
  return buildAskEvidencePack({ exactContext, message, currentUrl }).exactEvidence;
}

/** Production exact-evidence entry: load + select. Returns [] on any absence. */
function buildExactEvidence({ domain = targetDomain(), message = '', currentUrl = null } = {}) {
  return buildAskEvidencePack({ domain, message, currentUrl }).exactEvidence;
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
  selectEvidencePack,
  groupExactEvidence,
  buildAskEvidencePack,
  selectExactEvidence,
  buildExactEvidence,
  selectAskAnswerLink,
};
