'use strict';
/**
 * ASK-mode Selected Page Evidence Resolver.
 *
 * Flow: question → gather candidates (site-index pages + catalog resources +
 * optional current page) → resolve each into an evidence snippet (silent, backend
 * only) → send evidence pack to Gemma → Gemma answers ONLY from evidence → validate.
 *
 * Never uses visible Chrome/CDP and never triggers browser_agent_* jobs — pure
 * retrieval + a single silent model call. ACT mode is untouched.
 */
const http = require('http');
let axios; try { axios = require('axios'); } catch { axios = null; }

const { searchSiteIndex } = require('./siteIndex.service');
// resourceCatalog is lazy-required: it throws at load unless Laragon env is set, and
// catalog evidence is optional — ASK still answers from site-index without it.

const MIN_CONFIDENCE = 0.35;
const MAX_SITE = 4;      // top site-index pages to include as evidence
const MAX_CATALOG = 3;   // top catalog resources
const SNIPPET_MAX = 1500; // page textPreviews are capped at 1500 already
const WEAK_SNIPPET = 120; // below this we try a silent backend fetch

// ── Cross-source arbitration (evidence strength, not middleware order) ──────────
// Each retriever uses a different raw score scale, so we normalize every source to a
// common 0–1 confidence using ONLY that source's own acceptance floor + internal
// margin — never by comparing raw scores across sources. Floors mirror the real
// retriever config (calibration knobs, not example gates):
const SITE_FLOOR = 0.30;                                             // searchSiteIndex minScore
const CATALOG_FLOOR = Number(process.env.SEMANTIC_RESOURCE_MIN_SCORE) || 12; // SEMANTIC_RESOURCE_MIN_SCORE
const CURRENT_PAGE_BASE = 0.45;   // situational; only wins when site+catalog are weak
const SOURCE_FLOOR = { site_index: SITE_FLOOR, catalog: CATALOG_FLOOR, current_page: 0 };
const MIN_SOURCE_CONF = 0.35;     // below this, a source is not a confident winner
const PRIOR_BONUS = 0.08;         // detectSourceType nudge — never decisive alone
const STRENGTH_W = 0.6, MARGIN_W = 0.4;

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// detectSourceType → the source it softly favours (soft prior only, not a gate).
function _priorSource(question) {
  try {
    const { detectSourceType, SOURCE_TYPES } = require('./askRetrieval.service');
    const t = detectSourceType(question).sourceType;
    if (t === SOURCE_TYPES.CATALOG_PRODUCT || t === SOURCE_TYPES.BRANCH_DIRECTORY) return 'catalog';
    if (t === SOURCE_TYPES.WEBSITE_PAGE || t === SOURCE_TYPES.DOCUMENT_INDEX || t === SOURCE_TYPES.CONTACT_FACTS) return 'site_index';
  } catch { /* classifier optional */ }
  return null;
}

// Map one source's candidates to a 0–1 confidence from top strength (above its own
// floor) + internal margin (top vs 2nd). Scale-free across sources.
function _sourceConfidence(source, cands, prior) {
  if (!cands || cands.length === 0) return 0;
  if (source === 'current_page') return prior === 'site_index' ? CURRENT_PAGE_BASE + PRIOR_BONUS : CURRENT_PAGE_BASE;
  const scores = cands.map((c) => Number(c.score) || 0).sort((a, b) => b - a);
  const top = scores[0];
  const floor = SOURCE_FLOOR[source] ?? 0;
  const strength = clamp01((top - floor) / Math.max(top, floor, 1e-9));
  const margin = scores.length >= 2 ? clamp01((top - scores[1]) / Math.max(top, 1e-9)) : strength;
  let conf = STRENGTH_W * strength + MARGIN_W * margin;
  if (prior === source) conf += PRIOR_BONUS;
  return clamp01(conf);
}

// Single generic arbiter: compares normalized per-source confidence and decides which
// source may answer. Output shape is stable and logged/carried on req.
function arbitrateSources(question, candidates, { prior = _priorSource(question) } = {}) {
  const bySource = { site_index: [], catalog: [], current_page: [] };
  for (const c of candidates) if (bySource[c.source]) bySource[c.source].push(c);

  const sourceConfidence = {
    site_index:   _sourceConfidence('site_index', bySource.site_index, prior),
    catalog:      _sourceConfidence('catalog', bySource.catalog, prior),
    current_page: _sourceConfidence('current_page', bySource.current_page, prior),
  };
  for (const c of candidates) c.confidence = sourceConfidence[c.source] ?? 0; // for the pack

  const [topSource, topConf] = Object.entries(sourceConfidence).sort((a, b) => b[1] - a[1])[0];
  const selectedSource = topConf >= MIN_SOURCE_CONF ? topSource : 'none';

  return {
    selectedSource,
    selectedCandidates: selectedSource === 'none' ? [] : bySource[selectedSource],
    sourceConfidence,
    fallbackPolicy: {
      allowSiteIndexFallback: selectedSource === 'site_index',
      allowCatalogFallback: selectedSource === 'catalog',
      reason: selectedSource === 'none'
        ? `no source ≥ ${MIN_SOURCE_CONF} (site=${sourceConfidence.site_index.toFixed(2)} catalog=${sourceConfidence.catalog.toFixed(2)} page=${sourceConfidence.current_page.toFixed(2)})`
        : `${selectedSource} strongest ${topConf.toFixed(2)} (site=${sourceConfidence.site_index.toFixed(2)} catalog=${sourceConfidence.catalog.toFixed(2)}); prior=${prior || 'none'}`,
    },
  };
}

const ASK_RESOLVER_VERSION = 'ask-hybrid-v5';

// Soft scope hint (NOT a hard gate): steers Gemma + validation + fallback, never
// overrides evidence. Generic — driven by ownership ("my …") vs org-level wording.
function classifyScope(question) {
  const q = _FOLD(question);
  if (/\b(my|mine|mon|ma|mes|who am i|qui suis)\b/.test(q)) return 'private_catalog_info';
  if (!/^what is\b/.test(q) && /\b(open|download|navigate|go to|pay|transfer|book|show me the page)\b/.test(q)) return 'action_request';
  // Procedures, security guidance, and service-at-a-branch lookups are curated
  // catalog knowledge even when the wording does not contain "my".
  if (/\b(how|comment)\b.*\b(activate|activation|setup|register|enrol|enable)\b/.test(q)
      || /\b(otp|security|secure|safety|safe|share|credential|password)\b/.test(q)
      || /\b(which|quelle?)\b.*\b(branch|agence)\b.*\b(handle|provide|service|support)\b/.test(q)) {
    return 'private_catalog_info';
  }
  if (/\b(atb|bank|banque)\b/.test(q)
      || /\b(website|site|public|service|services|product|products|credit|credits|offer|offre)\b/.test(q)) {
    return 'public_site_info';
  }
  if (/\b(opening hours?|business hours?|horaires?|recruitment|recrutement|survey|questionnaire|page)\b/.test(q)) {
    return 'public_site_info';
  }
  return 'ambiguous';
}

// User explicitly wants a list of pages/links → page-list answers are OK for them.
const isListIntent = (question) => /\b(list|pages|links|navigation|show all|liste|liens|sitemap)\b/i.test(question);

// Normalized key to collapse duplicate crawl/boilerplate pages before packing.
const _siteDedupeKey = (page) => {
  const path = _pathOf(page.url || '').replace(/\.(?:php|html?)$/i, '');
  const leaf = path.split('/').filter(Boolean).pop() || '';
  return _FOLD(`${page.title || ''} ${leaf}`).replace(/[^a-z0-9]+/g, ' ').trim();
};

// ── 1. Candidate gathering ─────────────────────────────────────────────────────
// Returns unified candidates: {source,type,title,url,path,score,snippet,_record}
async function gatherCandidates(question, { siteIndex, siteCtx, debug } = {}) {
  const out = [];

  // current page (optional) — highest trust when the answer is literally on-screen.
  if (siteCtx && (siteCtx.text || siteCtx.textPreview) && String(siteCtx.text || siteCtx.textPreview).trim().length > WEAK_SNIPPET) {
    out.push({
      source: 'current_page', type: 'page',
      title: siteCtx.title || 'Current page', url: siteCtx.url || '', path: _pathOf(siteCtx.url),
      score: 0.5, snippet: String(siteCtx.text || siteCtx.textPreview).slice(0, SNIPPET_MAX), _record: siteCtx,
    });
  }

  // Dedupe near-identical boilerplate pages so a distinctive page is not buried by
  // crawl duplicates (which otherwise flatten the margin used for confidence).
  const seenSite = new Set();
  let siteCount = 0;
  for (const { page, score } of searchSiteIndex(question, siteIndex).slice(0, MAX_SITE * 3)) {
    const key = _siteDedupeKey(page);
    if (key && seenSite.has(key)) continue;
    seenSite.add(key);
    out.push({
      source: 'site_index', type: 'page',
      title: page.title || _pathOf(page.url), url: page.url || '', path: _pathOf(page.url),
      score, snippet: '', _record: page,
    });
    if (++siteCount >= MAX_SITE) break;
  }

  try {
    const { findMatchingResources } = require('./resourceCatalog.service');
    const cat = await findMatchingResources(question, { limit: MAX_CATALOG });
    for (const r of cat) {
      out.push({
        source: 'catalog', type: 'resource',
        title: r.metadata?.title || r.fileName || 'resource', url: r.url || '', path: '',
        score: r.score, snippet: '', _record: r,
      });
    }
  } catch { /* catalog unavailable — site-index evidence still stands */ }

  if (debug) {
    const brief = (s) => out.filter((c) => c.source === s)
      .map((c) => `${c.title.slice(0, 40)}(${Number(c.score).toFixed(2)})`);
    debug.siteTop = brief('site_index');
    debug.catalogTop = brief('catalog');
  }

  return out;
}

// ── 2/3. Evidence resolution (silent) ──────────────────────────────────────────
async function resolveEvidence(candidate) {
  if (candidate.source === 'current_page') return candidate; // already carries text

  if (candidate.source === 'catalog') {
    const m = candidate._record.metadata || {};
    // Strip routing/meta sentences ("Use it when…", "should be selected…") so the
    // evidence Gemma sees is the factual data, not query-echoing routing text.
    // The description is the approved semantic/factual source. resourceType and
    // keyFields are internal catalog metadata and must never enter answer facts.
    const cleaned = _stripMetaWithCount(m.description);
    candidate.snippet = cleaned.text.slice(0, SNIPPET_MAX);
    candidate.metaFactsRemoved = cleaned.removed;
    return candidate;
  }

  // site_index page: prefer indexed textPreview; silently fetch if weak/missing.
  let text = String(candidate._record.textPreview || '');
  if (text.trim().length < WEAK_SNIPPET && candidate.url && axios) {
    const fetched = await _fetchAndStrip(candidate.url);
    if (fetched && fetched.length > text.length) text = fetched;
  }
  // ponytail: axios+strip is the only silent fetch. Headless Playwright fallback is
  // NOT wired (not a backend dep) — add it here if JS-rendered pages ever need it.
  candidate.snippet = _pageBodyFromHeadings(candidate._record, text).slice(0, SNIPPET_MAX);
  return candidate;
}

// Crawled previews frequently start with a large global header and only later repeat
// the page's own heading. Anchor at the last query-relevant page heading so extraction
// starts at page content rather than at the first navigation occurrence.
function _pageBodyFromHeadings(page, text) {
  const raw = String(text || '');
  const headings = (Array.isArray(page?.headings) ? page.headings : [])
    .map((h) => String(h?.text || h || '').trim())
    .filter((h) => _contentTokens(h).length > 0 && !/^(les autres|services?|produits?|cr[eé]dits?)$/i.test(h));
  let bestAt = -1;
  for (const heading of headings) {
    const at = raw.toLocaleLowerCase().lastIndexOf(heading.toLocaleLowerCase());
    if (at > bestAt) bestAt = at;
  }
  return bestAt >= 0 ? raw.slice(bestAt) : raw;
}

async function _fetchAndStrip(url) {
  try {
    const { data } = await axios.get(url, { timeout: 6000, maxContentLength: 2_000_000,
      headers: { 'User-Agent': 'Mozilla/5.0 ATB-ASK-bot' } });
    return String(data)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ').trim();
  } catch { return ''; }
}

// ── 5. REFORMULATE: Gemma turns extracted facts into a clean answer ─────────────
const REFORMULATE_SYSTEM = `You rewrite already-extracted facts into a direct answer to the user's question.
Return ONLY valid JSON, no markdown, matching exactly:
{"answer":"...","usedFacts":[<0-based indices of answerFacts>],"confidence":0.0}
Rules:
- Answer the user's exact question, concisely (<= 3 sentences), in the user's language.
- Use ONLY the provided answerFacts / supportingFacts. Never invent or add outside knowledge.
- Do NOT dump raw records or restate every field.
- Do NOT expose internal field names (e.g. receiptId, customerId, primaryBranch) unless the user explicitly asked for them.
- Do NOT copy menu / sidebar / navigation text.
- Never say "I found X" or name the resource as the answer.
- Mention the source briefly only if it helps.
- Format: wrap the single most important value or conclusion in Markdown **bold** (e.g. "The rate is **1 EUR = 3.378 TND**."). Bold only the key fact, never whole sentences.
- If the facts do not answer the question, set "answer" to a short statement that the available information does not cover it and "usedFacts" to [].
- "usedFacts" lists the indices of answerFacts you actually used; it must be non-empty when you give a real answer.`;

function _formatReformulate(payload) {
  return JSON.stringify({
    question: payload.question,
    sourceType: payload.sourceType,
    answerFacts: payload.answerFacts,
    supportingFacts: payload.supportingFacts,
    sourceTitle: payload.sourceTitle,
    sourceUrl: payload.sourceUrl,
  });
}

// Default model call — own thin Ollama client (ACT's _callOllama truncates to 500 chars).
// ponytail: ~25 lines duplicated to keep ACT file untouched.
function _defaultCallModel(userContent, system = REFORMULATE_SYSTEM) {
  const base  = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = process.env.INTENT_MODEL || process.env.OLLAMA_MODEL || 'gemma4:e4b';
  const timeoutMs = parseInt(process.env.ASK_TIMEOUT_MS || '15000', 10);
  const body = JSON.stringify({
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }],
    stream: false, format: 'json', options: { temperature: 0, num_predict: 320 },
  });
  return new Promise((resolve, reject) => {
    try {
      const u = new URL('/api/chat', base);
      const req = http.request({ hostname: u.hostname, port: parseInt(u.port || '80', 10),
        path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => { let buf = ''; res.on('data', (c) => { buf += c; });
        res.on('end', () => { try { resolve(String(JSON.parse(buf)?.message?.content || '')); }
          catch { reject(new Error('ollama parse failed')); } }); });
      req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('ollama timeout')); });
      req.on('error', reject); req.write(body); req.end();
    } catch (e) { reject(e); }
  });
}

function _parseJson(raw) {
  const s = String(raw || '').replace(/^```(?:json)?/i, '').replace(/```$/, '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a === -1 || b < a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

async function askReformulate(payload, callModel = _defaultCallModel) {
  if (!payload.answerFacts.length) return null;
  const raw = await callModel(_formatReformulate(payload), REFORMULATE_SYSTEM);
  return _parseJson(raw);
}

// ── Generic catalog-evidence synthesis (fallback when Gemma abstains) ───────────
// Pulls the query-most-relevant segment(s) out of a catalog resource's evidence
// snippet (description + metadata). Generic: no hardcoded resource or field names —
// works for any resource whose description contains the requested fact.
// Fold accents AND split camelCase (primaryBranch → primary branch) so packed
// metadata keys match spaced query words.
const _FOLD = (s) => String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const _QSTOP = new Set([
  'what', 'which', 'who', 'where', 'when', 'how', 'why', 'the', 'of', 'for', 'is', 'are', 'a', 'an',
  'to', 'my', 'your', 'and', 'or', 'me', 'do', 'does', 'can', 'with', 'about',
  'quel', 'quelle', 'quels', 'quelles', 'est', 'sont', 'du', 'de', 'la', 'le', 'les', 'des', 'un', 'une',
  'mon', 'ma', 'mes', 'pour', 'dans', 'sur', 'qui', 'que', 'quoi', 'ou',
]);
const _contentTokens = (s) => _FOLD(s).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
  .filter((t) => t.length >= 3 && !_QSTOP.has(t));
// Routing/meta sentences describe WHEN to use a resource — they never carry the answer.
const _META_SEG = /\buse it when\b|\b(?:the|a) user asks\b|\bif the user asks\b|\bthis resource is\b|\bshould\b|\bquestions such as\b|\bnatural questions\b|\bfor [^.]{0,45}questions\b|\bservice-based questions\b|\bcan support\b|\bexecution must\b|\bthe backend must\b/i;
function _stripMetaWithCount(text) {
  const segments = String(text || '').split(/(?<=[.!?;])\s+|\n+/).filter(Boolean);
  const kept = segments.filter((s) => !_META_SEG.test(s));
  return { text: kept.join(' ').trim(), removed: segments.length - kept.length };
}
const _stripMeta = (text) => _stripMetaWithCount(text).text;

// Generic query-focused segment scorer: the description/body segment most relevant to
// the question, preferring data-bearing segments (digits). No hardcoded fields/names.
// ── 2. EXTRACT: raw evidence → small structured answer payload ───────────────────
// Break evidence into ATOMIC facts (sentences, then "key value" enumeration items and
// "Label: value" pairs), drop nav/menu + routing boilerplate, keep only query-relevant
// facts (IDF-weighted). Fully generic — no hardcoded labels/fields/resource names.

// A menu/nav run: many words, mostly capitalised items, no value markers (digit/":"/"=").
function _looksNav(fact) {
  const words = fact.split(/\s+/).filter(Boolean);
  if (words.length < 6) return false;
  if (/[:=]|\d/.test(fact)) return false;                     // has a value → not pure nav
  const capish = words.filter((w) => /^[A-ZÀ-Ÿ]/.test(w)).length;
  return capish / words.length > 0.55;                         // mostly Title-Case menu items
}

// ── Site-chrome filtering (site_index facts only) ───────────────────────────────
// Global nav/menu/footer phrases repeated on every crawled page. Deployment config
// (calibration knob per site), matched on accent-folded text — NOT per-question logic.
// Accent-tolerant: matched against RAW page text (é/ê kept), so accented letters are
// spelled as classes.
const SITE_CHROME_RE = new RegExp([
  'assistance entreprises', 'espace particuliers', 'espace professionnels', 'espace entreprises',
  'espace finance', 'trouver votre agence', 'nous contacter', '\\br[eé]clamations?\\b',
  'atbchallenge', 'prix atb mustapha azouz', '\\btmm(?:\\s*\\([^)]*\\))?\\s*(?:=\\s*[0-9.,]+\\s*%)?',
  'devenir client', 'documents utiles', 'la banque au quotidien', 'nos comptes', 'nos cartes',
  'nos packs', '\\brecrutement\\b', 'enqu[eê]te de satisfaction', 'copyright', 'tous droits', 'mentions l[eé]gales', 'plan du site',
  'suivez[- ]nous', '\\brecherche\\b', 'footer', '[\\u0600-\\u06ff]{3,}',
].join('|'), 'i');

// Descriptive prose markers (FR/EN) — a segment explaining something, not naming menu
// items. Also satisfied by a high function-word ratio (real sentences are full of
// de/la/et/…; menu runs are Title-Case item lists).
const DESCRIPTIVE_RE = /permet|destin[ée]|offre|propose|solution|service|avantage|condition|disponible|certifi|garanti|b[ée]n[ée]ficie|gratuit|s[ée]curis|instantan|allows?|offers?|provides?|available|designed/i;
function _isDescriptive(fact) {
  if (DESCRIPTIVE_RE.test(fact)) return true;
  const words = String(fact).split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  const fn = words.filter((w) => /^[a-zà-ÿ]{1,3}$/.test(w)).length;
  return fn / words.length >= 0.25;
}

// Category/menu list: many sibling Title-Case items, no values, no descriptive prose.
function _looksCategoryList(fact) {
  if (/[\d:=]/.test(fact)) return false;                      // carries a value → data, not a menu
  const words = String(fact).split(/\s+/).filter(Boolean);
  if (words.length < 6) return false;
  const cap = words.filter((w) => /^[A-ZÀ-Ÿ]/.test(w)).length;
  return cap / words.length >= 0.6;
}

// Does the user actually want an enumeration? List intent, or a category noun within
// a couple of words of what/which ("what credit products…"), NOT any later product-name
// mention ("what does ATB say about Crédit X" is not an enumeration request).
function _wantsEnumeration(question) {
  return isListIntent(question)
    || /\b(what|which|quels?|quelles?)\s+(?:[\w'’-]+\s+){0,2}(products?|produits?|services?|offres?|offers?|options?|types?|cr[ée]dits|cartes?|cards?|packs?)\b/i.test(question);
}

// Scrub chrome phrases OUT of a fact (site previews are often one giant unpunctuated
// blob mixing content and menu text — whole-fact dropping alone cannot catch it).
const SITE_CHROME_G = new RegExp(SITE_CHROME_RE.source, 'gi');
const _scrubChrome = (text) => String(text || '').replace(SITE_CHROME_G, ' ').replace(/\s+/g, ' ').trim();

// Filter site_index facts: drop cross-page repeats, scrub chrome phrases, drop what
// remains too thin, and reject category/menu lists (unless the user asked for a list).
// Descriptive prose always survives untouched — it's page content even when it
// mentions a chrome phrase (e.g. a paragraph about the satisfaction survey).
function filterSiteFacts(facts, { siteSnippets = [], listOk = false } = {}) {
  const foldedSnips = siteSnippets.map((s) => _FOLD(s));
  let removedChrome = 0, rejectedLists = 0;
  const kept = [];
  const demoted = new Set();   // repeated-but-descriptive facts: usable, ranked last
  for (const fact of facts) {
    // Scrub chrome phrases out of EVERY fact (site previews mix menu + content in one
    // unpunctuated blob; whole-fact rules alone cannot separate them).
    const scrubbed = _scrubChrome(fact);
    if (scrubbed !== fact) {
      removedChrome += 1;
      if (_contentTokens(scrubbed).length < 4) continue;       // nothing but chrome
    }
    const key = _FOLD(fact).slice(0, 60);
    const repeats = key.length >= 20 ? foldedSnips.filter((s) => s.includes(key)).length : 1;
    if (_isDescriptive(scrubbed)) {
      // Descriptive prose is content — but when repeated across pages it's a shared
      // promo/sidebar: keep it usable, demoted below page-unique facts.
      if (repeats >= 2 && scrubbed.length > 220) { removedChrome += 1; continue; }
      if (repeats >= 2) demoted.add(scrubbed);
      kept.push(scrubbed);
      continue;
    }
    if (repeats >= 2) {
      // Repeated non-prose is chrome — EXCEPT a category list when the user asked for
      // an enumeration: the site-wide product/service menu IS the answer then.
      if (listOk && _looksCategoryList(scrubbed)) { demoted.add(scrubbed); kept.push(scrubbed); continue; }
      removedChrome += 1; continue;
    }
    if (!listOk && _looksCategoryList(scrubbed)) { rejectedLists += 1; continue; }
    kept.push(scrubbed);
  }
  return { kept, removedChrome, rejectedLists, demoted };
}

// Split text into atomic facts.
function _atomicFacts(text) {
  const out = [];
  const segs = String(text || '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segs) {
    if (_META_SEG.test(seg)) continue;
    if (/[:：]/.test(seg)) {
      // "Label : value" pairs — value runs until the next "Label :" or end.
      const re = /([A-Za-zÀ-ÿ][\w'’\- ]{1,30})\s*[:：]\s*([^:：]+?)(?=\s+[A-Za-zÀ-ÿ][\w'’\- ]{1,30}\s*[:：]|$)/g;
      let m, matched = false;
      while ((m = re.exec(seg)) !== null) { matched = true; out.push(`${m[1].trim()}: ${m[2].trim()}`); }
      if (matched) continue;
    }
    if ((seg.match(/,/g) || []).length >= 2) {
      // "key value, key value, …" enumeration → atomic items.
      out.push(seg); // preserve row/entity context in addition to atomic fields
      for (const part of seg.split(/\s*;\s*|\s*,\s*/)) { const p = part.trim(); if (p.length > 1) out.push(p); }
      continue;
    }
    out.push(seg);
  }
  return out.map((f) => f.replace(/^[\s.,;:]+|[\s.,;:]+$/g, '')).filter((f) => f.length > 1 && !_looksNav(f));
}

const FACT_INTENTS = Object.freeze({
  amount_limit: {
    question: /\b(amount|how much|limit|balance|fee|payment|minimum payment|montant|limite|solde|frais|paiement)\b/,
    fact: /\b(amount|limit|balance|fee|payment|montant|limite|solde|frais|paiement)\b|\b(?:tnd|eur|usd)\b/,
  },
  status: {
    question: /\b(status|state|completed|complete|paid|ready|pending|active|scheduled|statut|[ée]tat|termin[ée]|pay[ée]|pr[êe]t|en attente)\b/,
    fact: /\b(status|state|pending|completed|paid|ready|active|scheduled|preparation|confirmation|statut|[ée]tat|en attente)\b/,
  },
  date_deadline: {
    question: /\b(when|date|deadline|due|expiry|expires|quand|[ée]ch[ée]ance|expire)\b/,
    fact: /\b(date|deadline|due|expiry|expires|execution|[ée]ch[ée]ance|expire)\b|\b20\d{2}-\d{2}-\d{2}\b/,
  },
  contact: {
    question: /\b(phone|telephone|mobile number|email|e-mail|contact|t[ée]l[ée]phone|courriel)\b/,
    fact: /\b(phone|telephone|mobile number|email|e-mail|contact|t[ée]l[ée]phone|courriel)\b|\+\d{3}/,
  },
  page_location: {
    question: /\b(page|survey|questionnaire|recruitment|recrutement)\b.*\b(where|find|o[uù])\b|\b(where|find|o[uù])\b.*\b(page|survey|questionnaire|recruitment|recrutement)\b/,
    fact: /\b(page|survey|questionnaire|recruitment|recrutement|satisfaction)\b/,
  },
  branch_location: {
    question: /\b(branch|location|located|where|address|agence|emplacement|adresse|o[uù])\b/,
    fact: /\b(branch|location|located|address|agence|emplacement|adresse)\b/,
  },
  rate_exchange: {
    question: /\b(rate|exchange|currency|forex|taux|change|devise)\b/,
    fact: /\b(rate|exchange|currency|forex|taux|change|devise)\b|\b[a-z]{3}\s*=\s*[0-9]/,
  },
  progress: {
    question: /\b(progress|percentage|percent|goal|objectif|progression|pourcentage)\b|%/,
    fact: /\b(progress|percentage|percent|goal|saved|target|objectif|progression|pourcentage)\b|%/,
  },
  identity_profile: {
    question: /\b(who am i|my identity|my profile|profile name|name on|identity|profile|qui suis|identit[ée]|profil|nom)\b/,
    fact: /\b(full name|name|identity|profile|customer|client|nom|identit[ée]|profil)\b/,
  },
  activation_howto: {
    question: /\b(activate|activation|setup|register|enrol|how do|steps?|process|activer|inscrire|[ée]tapes?|proc[ée]dure|comment)\b/,
    fact: /\b(activate|activation|setup|register|identity|password|login|steps?|process|activer|inscrire|[ée]tapes?|proc[ée]dure)\b/,
  },
  requirements: {
    question: /\b(required|requirements?|documents?|checklist|needed|requis|documents?|pi[èe]ces?|n[ée]cessaire)\b/,
    fact: /\b(required|requirements?|documents?|registration|certificate|proof|cin|passport|requis|pi[èe]ces?|certificat|justificatif)\b/,
  },
  safety_security: {
    question: /\b(safe|safety|security|secure|share|otp|warning|recommend|s[ée]curit[ée]|partager|avertissement|recommand)\b/,
    fact: /\b(never share|safe|safety|security|secure|otp|warning|recommend|avoid|report|s[ée]curit[ée]|partager|avertissement|recommand)\b/,
  },
  hours: {
    question: /\b(opening hours?|business hours?|hours?|horaires?|ouvert|ferme)\b/,
    fact: /\b(hours?|horaires?|ouvert|ferme|lundi|vendredi)\b|\b\d{1,2}h\d{2}\b|\b\d{1,2}:\d{2}\b/,
  },
});

function detectFactIntent(question) {
  const q = _FOLD(question);
  if (FACT_INTENTS.date_deadline.question.test(q)) return 'date_deadline';
  for (const [name, rule] of Object.entries(FACT_INTENTS)) if (rule.question.test(q)) return name;
  return 'general';
}

function _factIntentScore(intent, fact) {
  if (!intent || intent === 'general') return 0;
  const f = _FOLD(fact);
  if (!FACT_INTENTS[intent]?.fact.test(f)) return 0;
  let score = 3;
  if (intent === 'identity_profile' && /\bfull name\b/.test(f)) score += 2;
  if (intent === 'activation_howto' && /\bsteps?|process|procedure|etapes?\b/.test(f)) score += 2;
  if (intent === 'status' && /^(?:and )?status\b/.test(f)) score += 1;
  return score;
}

// IDF-weighted relevance of a fact list to the question. Returns sorted [{fact,score}].
function _scoreFacts(question, facts, ctxToks = null, excludeToks = null) {
  let qToks = new Set(_contentTokens(question));
  // Site-identity tokens (org name etc.) match everything on the site — they carry no
  // signal about WHICH fact answers the question.
  if (excludeToks && excludeToks.size) qToks = new Set([...qToks].filter((t) => !excludeToks.has(t)));
  if (facts.length === 0) return [];
  const factIntent = detectFactIntent(question);
  const factToks = facts.map((f) => new Set(_contentTokens(f)));
  const df = new Map();
  for (const ft of factToks) for (const t of ft) if (qToks.has(t)) df.set(t, (df.get(t) || 0) + 1);
  const weight = (t) => 1 - (df.get(t) || 0) / (facts.length + 1);
  return facts.map((fact, i) => {
    // Max-weight dominant: one rare (high-IDF) query token match must beat several
    // ubiquitous ones — the requested field label outranks org-name mentions.
    const ws = [...qToks].filter((t) => factToks[i].has(t)).map(weight).sort((a, b) => b - a);
    let s = ws.length ? ws[0] + 0.5 * ws.slice(1).reduce((a, b) => a + b, 0) : 0;
    s += _factIntentScore(factIntent, fact);
    if ((fact.match(/,/g) || []).length >= 2
        && !(factIntent === 'branch_location' && fact.includes(';'))) s -= 1.25;
    if (s > 0 && /[\d=]|:/.test(fact)) s += 0.25;             // amplify RELEVANT value-bearing facts only
    // Page-specific boost — only when the fact matches a query token BEYOND the page's
    // own title/path terms (otherwise every sidebar mentioning the page name wins).
    if (s > 0 && ctxToks
        && [...factToks[i]].some((t) => ctxToks.has(t))
        && [...qToks].some((t) => factToks[i].has(t) && !ctxToks.has(t))) s += 0.25;
    return { fact, score: s };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
}

// Focus an over-long fact (unpunctuated site blob) to a window around the first
// query-token match, so extracted facts stay small and on-topic.
function _focus(question, fact, radius = 90) {
  if (fact.length <= 160) return fact;
  const folded = _FOLD(fact);
  let at = -1;
  for (const t of _contentTokens(question).reverse()) {
    const i = folded.indexOf(t);
    if (i >= 0) { at = i; break; }
  }
  if (at < 0) return fact.slice(0, 160).trim();
  let start = fact.lastIndexOf(' ', Math.max(0, at - radius)); if (start < 0) start = 0;
  let end = fact.indexOf(' ', at + radius); if (end < 0) end = fact.length;
  return (start > 0 ? '… ' : '') + fact.slice(start, end).trim() + (end < fact.length ? ' …' : '');
}

// Build the structured answer payload from ONE selected candidate.
function extractAnswerPayload(question, candidate, sourceConfidence = {}, opts = {}) {
  let facts = _atomicFacts(candidate.snippet || '');
  const factIntent = detectFactIntent(question);
  const hadRawFacts = facts.length > 0;
  let filter = null;
  let ctxToks = null;
  let demoted = null;
  const listOk = opts.listOk !== undefined ? opts.listOk : _wantsEnumeration(question);
  if (candidate.source === 'site_index') {
    const r = filterSiteFacts(facts, {
      siteSnippets: opts.siteSnippets || [],
      listOk,
    });
    facts = r.kept;
    demoted = r.demoted;
    filter = { removedChrome: r.removedChrome, rejectedLists: r.rejectedLists, kept: r.kept.length };
    // Page-specific preference: facts near the page title / URL-path terms score higher.
    ctxToks = new Set(_contentTokens(`${candidate.title || ''} ${candidate.path || ''}`));
    if (factIntent === 'page_location' && candidate.title) facts.unshift(candidate.title);
  }
  const identityToks = candidate.source === 'site_index'
    ? (opts.identityToks || siteIdentityToks(opts.siteTitles || []))
    : null;
  const scored = _scoreFacts(question, facts, ctxToks, identityToks);
  // Enumeration questions: the list fact IS the answer — outrank value-noise (header
  // tickers carry digits and would otherwise win on the value bonus).
  if (candidate.source === 'site_index' && listOk) {
    for (const x of scored) if (_looksCategoryList(x.fact)) x.score += 0.5;
    scored.sort((a, b) => b.score - a.score);
  }
  // Relevance floor uses the PRE-demotion score: a demoted promo that is the only real
  // match must still count as relevant evidence.
  const rawTop = scored.length ? scored[0].score : 0;
  // Cross-page-repeated (promo/sidebar) facts rank below page-unique ones.
  if (demoted && demoted.size) {
    for (const x of scored) if (demoted.has(x.fact)) x.score *= 0.35;
    scored.sort((a, b) => b.score - a.score);
  }
  const answerFacts = scored.slice(0, 6).map((x) => _focus(question, x.fact));
  const chosen = new Set(answerFacts);
  const supportingFacts = facts.filter((f) => /[\d=]|:/.test(f) && !chosen.has(f)).slice(0, 3);
  return {
    question, answerFacts, supportingFacts,
    sourceType: candidate.source,
    sourceTitle: candidate.title || '',
    sourceUrl: candidate.url || '',
    confidence: Number(sourceConfidence[candidate.source] || 0),
    _topScore: rawTop,
    _allFacts: facts,
    _intent: factIntent,
    _factRankScores: scored.slice(0, 8).map((x) => ({ fact: _focus(question, x.fact), score: Number(x.score.toFixed(3)) })),
    _hadRawFacts: hadRawFacts,
    _filter: filter,
  };
}

// Site-identity tokens: tokens present in EVERY (non-error) retrieved page title — the
// org name / brand words. They match every page so they carry no per-fact signal.
// Topic words shared by only SOME titles (the retrieval working) survive.
function siteIdentityToks(rawTitles) {
  const titles = (rawTitles || []).filter((t) => t && t.trim() && !/(^|\s)(404|50\d|error)(\s|$)|not found/i.test(t));
  if (titles.length < 2) return null;
  const counts = new Map();
  for (const t of titles) for (const tok of new Set(_contentTokens(t))) counts.set(tok, (counts.get(tok) || 0) + 1);
  return new Set([...counts.entries()].filter(([, c]) => c >= titles.length).map(([t]) => t));
}

// Pick the single best candidate to extract from: highest fact-relevance, with the
// scope acting only as a soft multiplier (not a gate).
function _selectEvidence(question, candidates, scope, sourceConfidence, identityToks = null) {
  // Catalog retrieval already ranked complete resources. Preserve that selected
  // resource identity and only rank facts inside it; isolated fact overlap in a
  // lower resource must not replace the top resource.
  if (candidates[0]?.source === 'catalog') return candidates[0];
  const pref = { site_index: 1, catalog: 1, current_page: 1 };
  if (scope === 'public_site_info') { pref.site_index = 1.15; pref.current_page = 1.1; }
  else if (scope === 'private_catalog_info') pref.catalog = 1.15;
  let best = null, bestScore = 0;
  for (const c of candidates) {
    if ((sourceConfidence[c.source] || 0) <= 0) continue;
    // Same identity-token exclusion as final scoring, so selection and extraction
    // agree on what counts as a topical match for site pages.
    const excl = c.source === 'site_index' ? identityToks : null;
    let facts = _atomicFacts(c.snippet || '');
    if (c.source === 'site_index') {
      facts = filterSiteFacts(facts, {
        siteSnippets: candidates.filter((x) => x.source === 'site_index').map((x) => x.snippet || ''),
        listOk: _wantsEnumeration(question),
      }).kept;
      if (detectFactIntent(question) === 'page_location' && c.title) facts.unshift(c.title);
    }
    const scored = _scoreFacts(question, facts, null, excl);
    if (scored.length === 0) continue;
    const retrievalSupport = c.source === 'site_index' ? Math.min(Number(c.score) || 0, 3) * 0.5 : 0;
    const s = scored[0].score * (pref[c.source] || 1) + retrievalSupport;
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return best;
}

function _evidenceSourceForScope(scope, arbitration, candidates) {
  const has = (source) => candidates.some((c) => c.source === source);
  if (scope === 'private_catalog_info' && has('catalog')) return 'catalog';
  if (scope === 'public_site_info') return has('site_index') ? 'site_index' : 'site_index_missing';
  if (arbitration.selectedSource !== 'none' && has(arbitration.selectedSource)) return arbitration.selectedSource;
  return 'none';
}

// ── 4. Validate Gemma's reformulation ───────────────────────────────────────────
const _answerLooksVague = (a) => /^\s*(i (?:have )?found|here('?s| is)|voici|j'?ai trouv[eé])\b/i.test(String(a || '').trim());
const _looksLikePageList = (a) => (String(a).match(/^\s*[-*]\s.*\(\/?\S*\)\s*$/gm) || []).length >= 2;
// Raw-dump: many comma-separated fragments carrying identifier-like values
// (digits/underscore/camelCase), or several camelCase field names. A plain list
// ("Alpha, Beta, Gamma") has no such value tokens, so it is NOT flagged.
function _looksLikeRawDump(a) {
  const s = String(a);
  const camel = (s.match(/[a-z][A-Z]/g) || []).length;
  const idFrags = s.split(',').filter((p) => /[0-9_]|[a-z][A-Z]/.test(p)).length;
  return camel >= 3 || idFrags >= 3;
}

function validateReformulation(gemma, payload, question) {
  if (!gemma || typeof gemma !== 'object') return { ok: false, reason: 'no model output' };
  const answer = String(gemma.answer || '').trim();
  const used = Array.isArray(gemma.usedFacts) ? gemma.usedFacts.filter((n) => Number.isInteger(n) && n >= 0 && n < payload.answerFacts.length) : [];
  const confidence = Number(gemma.confidence);
  if (!answer) return { ok: false, reason: 'empty answer' };
  if (used.length === 0) return { ok: false, reason: 'no usedFacts' };
  if (!(confidence >= MIN_CONFIDENCE)) return { ok: false, reason: `low confidence ${confidence}` };
  if (_answerLooksVague(answer)) return { ok: false, reason: 'vague ("I found X")' };
  if (_looksLikeRawDump(answer)) return { ok: false, reason: 'raw record dump' };
  if (_looksLikePageList(answer) && !isListIntent(question)) return { ok: false, reason: 'page-list for non-list question' };
  // Value answers must highlight the key value — reject unformatted dumps so the
  // deterministic fallback (which bolds) takes over.
  if (/\d/.test(answer) && !answer.includes('**')) return { ok: false, reason: 'unformatted value answer' };
  // Supported: answer shares a content token with the facts it claims to use.
  const usedToks = new Set(used.flatMap((i) => _contentTokens(payload.answerFacts[i])));
  if (!_contentTokens(answer).some((t) => usedToks.has(t))) return { ok: false, reason: 'answer not supported by used facts' };
  return { ok: true, answer, confidence, usedFacts: used };
}

// ── 5. Deterministic fallback (Gemma unavailable) ────────────────────────────────
// ONE clean bolded fact — never a raw dump, never internal IDs, never a menu list,
// never "I found X". Returns null when no fact is presentable (caller decides
// insufficient-evidence vs pass-through).
const FIELD_PREFIX_RE = /^(?:it contains\s+|the image visible fields are\s+|the visible fields are\s+|and\s+)/i;
const FIELD_LABEL_RE = /^(full name|profile name|primary branch|nearest branch|requested branch|support phone|phone|email|available limit|current limit|minimum payment|payment due date|due date|estimated ready date|request date|exchange rate|rate|progress|goal name|saved amount|required documents?|optional documents?|status|activation steps?|steps?|amount|fee|balance|date)\s*[:=-]?\s+(.+)$/i;

function _fieldValue(raw) {
  const text = String(raw || '').replace(/^[…\s]+|[…\s]+$/g, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2').replace(FIELD_PREFIX_RE, '').replace(/\.+$/, '').trim();
  const m = text.match(FIELD_LABEL_RE);
  return m ? { label: _FOLD(m[1]).trim(), value: m[2].trim(), text } : { label: '', value: text, text };
}

function _findValue(payload, labelRe) {
  for (const fact of [...(payload.answerFacts || []), ...(payload.supportingFacts || []), ...(payload._allFacts || [])]) {
    const parsed = _fieldValue(fact);
    if (labelRe.test(parsed.label)) return parsed.value;
  }
  return '';
}

function _branchFromMatchingRow(question, raw) {
  const ranked = _scoreFacts(question, String(raw || '').split(/\s*;\s*/));
  for (const { fact } of ranked) {
    const m = fact.replace(/^[…\s]+/, '').match(/(?:^|\band\s+)([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÿ0-9 .'’-]{0,35}?)\s+located at\b/);
    if (m) return m[1].trim();
  }
  return '';
}

function _presentableFact(payload) {
  const listOk = _wantsEnumeration(payload.question || '');
  for (const raw of payload.answerFacts || []) {
    const parsed = _fieldValue(raw);
    if (!parsed.value || /\b\w+_\w+\b/.test(parsed.value)) continue;
    if (/\b(?:id|identifier)\b/i.test(parsed.label) && !/\b(id|identifier)\b/i.test(payload.question || '')) continue;
    if (!listOk && _looksCategoryList(parsed.value)) continue;
    return { raw: String(raw), ...parsed };
  }
  return null;
}

function deterministicAnswer(payload) {
  const picked = _presentableFact(payload);
  if (!picked) return null;
  const q = _FOLD(payload.question || '');
  const intent = payload._intent || detectFactIntent(payload.question || '');
  let value = picked.value.replace(/^the\s+(?:security advice|advice)\s+table\s+says\s+/i, '').trim();

  if (intent === 'identity_profile') return `The name on your bank profile is **${value}**.`;
  if (intent === 'contact') {
    if (/email/.test(picked.label)) return `The email address is **${value}**.`;
    return `The phone number is **${value}**.`;
  }
  if (intent === 'page_location') return `The relevant page is **${value}**.`;
  if (intent === 'branch_location') {
    const branch = _branchFromMatchingRow(payload.question, picked.raw) || value;
    if (/\b(primary|principale?)\b/.test(q)) return `Your primary branch is **${branch}**.`;
    const service = String(payload.question || '').match(/\b(?:handles?|provides?|for)\s+(.+?)(?:\?|$)/i)?.[1]?.trim();
    return service
      ? `The branch that handles ${service} is **${branch}**.`
      : `The matching branch is **${branch}**.`;
  }
  if (intent === 'status') {
    const status = picked.label === 'status' ? value : (_findValue(payload, /^status$/) || value);
    if (/\b(is|was|has)\b.*\b(completed|complete|paid|ready)\b/.test(q)) {
      const positive = /^(completed|complete|paid|ready|confirmed|delivered)\b/i.test(status);
      return `${positive ? 'Yes' : 'No'}. The status is **${status}**.`;
    }
    const readyDate = _findValue(payload, /estimated ready date|due date/);
    const branch = _findValue(payload, /requested branch|primary branch/);
    const details = [readyDate && `estimated for ${readyDate}`, branch && `at ${branch}`].filter(Boolean).join(' ');
    return `The status is **${status}**${details ? `, ${details}` : ''}.`;
  }
  if (intent === 'date_deadline') {
    const date = (value.match(/\b20\d{2}-\d{2}-\d{2}\b/) || [value])[0];
    const payment = _findValue(payload, /minimum payment/);
    return payment
      ? `The payment is due on **${date}**, with a minimum payment of ${payment}.`
      : `The relevant date is **${date}**.`;
  }
  if (intent === 'amount_limit') {
    if (/available/.test(picked.label) || /\bavailable\b/.test(q)) return `Your available limit is **${value}**.`;
    if (/minimum payment/.test(picked.label)) return `The minimum payment is **${value}**.`;
    if (/fee/.test(picked.label)) return `The fee is **${value}**.`;
    if (/balance/.test(picked.label)) return `The balance is **${value}**.`;
    return `The amount is **${value}**.`;
  }
  if (intent === 'rate_exchange') return `The exchange rate is **${value}**.`;
  if (intent === 'progress') {
    const pct = (value.match(/\b\d+(?:[.,]\d+)?%/) || [value])[0];
    const goal = _findValue(payload, /goal name/);
    const saved = _findValue(payload, /saved amount/);
    const savedText = saved ? `, with ${saved} saved` : '';
    return goal ? `Your ${goal} savings goal is **${pct} complete**${savedText}.` : `Your savings goal is **${pct} complete**${savedText}.`;
  }
  if (intent === 'activation_howto') {
    value = value.replace(/^the activation steps are\s*:?\s*/i, '');
    return `To activate the service, follow these steps: **${value}**.`;
  }
  if (intent === 'requirements') {
    const items = (payload.answerFacts || []).map(_fieldValue)
      .filter((x) => !x.value.includes(',') && (/required documents?/.test(x.label)
        || /\b(registration|certificate|proof|cin|passport|certificat|justificatif)\b/i.test(_FOLD(x.value))))
      .map((x) => x.value).filter((x, i, all) => x && all.indexOf(x) === i).slice(0, 4);
    return items.length ? `The required documents include **${items.join(', ')}**.` : `The requirements are **${value}**.`;
  }
  if (intent === 'safety_security') {
    if (/never share\s+(?:your\s+)?otp/i.test(value)) {
      const reason = value.match(/\bbecause\b.+/i)?.[0] || '';
      return `**Never share your OTP**${reason ? ` ${reason}` : ''}.`;
    }
    return `The security guidance is **${value}**.`;
  }
  if (intent === 'hours') return `The stated opening hours are **${value}**.`;

  const body = value.length > 240 ? `${value.slice(0, 237).trim()}…` : value;
  return `**${body}**.`;
}

// Clean insufficient-evidence answer — used when a site page was selected but every
// extracted fact was chrome/menu noise. Never output the noisy text itself.
function insufficientEvidenceAnswer(sourceTitle) {
  const t = String(sourceTitle || '').trim().slice(0, 60);
  return t
    ? 'I found the relevant ATB page, but the indexed text does not contain enough specific detail to answer clearly.'
    : 'The indexed ATB site does not contain enough specific detail to answer clearly.';
}

// ── Orchestrator: RETRIEVE → EXTRACT → REFORMULATE → VALIDATE ────────────────────
function _siteFactQuality(payload) {
  if (!payload.answerFacts.length) return { sufficient: false, reason: 'no answer facts after chrome filtering' };
  const intent = payload._intent || detectFactIntent(payload.question || '');
  const listOk = _wantsEnumeration(payload.question || '');
  const qToks = new Set(_contentTokens(payload.question || '').filter((t) => t !== 'atb' && t !== 'bank'));
  const definitional = /^\s*(?:what is|what does|who is|qu(?:'|e)est|c['’]est quoi)\b/i.test(payload.question || '');
  for (const fact of payload.answerFacts) {
    const foldedFact = _FOLD(fact);
    const titleRuns = (fact.match(/\bATB\s+[A-Z][A-Za-z-]+/g) || []).length;
    const repeatedTopic = [...qToks].some((t) => t.length >= 5
      && (foldedFact.match(new RegExp(`\\b${t}\\b`, 'g')) || []).length >= 3);
    const siblingRun = definitional && (titleRuns >= 2
      || repeatedTopic
      || fact.trim().length < 60
      || (titleRuns >= 1 && fact.length > 80 && /^[A-ZÀ-ÖØ-Þ]/.test(fact)));
    if (/\p{Script=Arabic}/u.test(fact) || titleRuns >= 3 || siblingRun) continue;
    if (listOk) {
      const specific = [...qToks].filter((t) => !/^(services?|products?|offer|offers)$/.test(t));
      const positions = specific.map((t) => foldedFact.indexOf(t)).filter((i) => i >= 0);
      const firstTopic = positions.length ? Math.min(...positions) : -1;
      if (firstTopic > fact.length * 0.45 && fact.slice(0, firstTopic).trim().split(/\s+/).length >= 5) continue;
    }
    if (!listOk && (_looksNav(fact) || _looksCategoryList(fact))) continue;
    if (_factIntentScore(intent, fact) > 0) return { sufficient: true, reason: `direct ${intent} fact` };
    const fToks = new Set(_contentTokens(fact));
    const overlap = [...qToks].filter((t) => fToks.has(t));
    if (overlap.length >= 1 && (_isDescriptive(fact) || /[\d:=]/.test(fact) || (listOk && _looksCategoryList(fact)))) {
      return { sufficient: true, reason: `direct topic overlap: ${overlap.slice(0, 3).join(',')}` };
    }
  }
  return { sufficient: false, reason: 'facts are navigation, repeated chrome, or do not directly answer the question' };
}

async function resolveAskAnswer(question, { siteIndex, siteCtx, callModel, debug } = {}) {
  const scope = classifyScope(question);
  const candidates = await gatherCandidates(question, { siteIndex, siteCtx, debug });
  const arbitration = arbitrateSources(question, candidates);
  const sourceConfidence = arbitration.sourceConfidence;
  const evidenceSource = _evidenceSourceForScope(scope, arbitration, candidates);
  if (debug) {
    debug.version = ASK_RESOLVER_VERSION; debug.scope = scope; debug.sourceConfidence = sourceConfidence;
    debug.selectedSource = evidenceSource; debug.sourceReason = arbitration.fallbackPolicy.reason;
  }
  if (candidates.length === 0) { if (debug) debug.answeredSource = 'none'; return null; }

  await Promise.all(candidates.map(resolveEvidence));

  if (evidenceSource === 'site_index_missing') {
    if (debug) {
      debug.answeredSource = 'site_index(fallback)';
      debug.siteFactQuality = 'insufficient: no relevant indexed ATB page';
      debug.fallback = 'insufficient_evidence: no site candidate';
    }
    return {
      type: 'answer', answer: insufficientEvidenceAnswer(''), confidence: MIN_CONFIDENCE,
      source: 'site_index', matchTitle: '', matchUrl: '', evidenceCount: candidates.length,
      usedFacts: [], synthesized: true,
    };
  }

  // EXTRACT — select the best evidence and pull a small structured fact payload.
  const siteCands = candidates.filter((c) => c.source === 'site_index');
  const identityToks = siteIdentityToks(siteCands.map((c) => c.title || ''));
  const eligible = evidenceSource === 'none' ? candidates : candidates.filter((c) => c.source === evidenceSource);
  const selected = _selectEvidence(question, eligible, scope, sourceConfidence, identityToks);
  if (!selected) {
    if (evidenceSource === 'site_index') {
      if (debug) {
        debug.answeredSource = 'site_index(fallback)';
        debug.siteFactQuality = 'insufficient: no relevant facts after chrome filtering';
        debug.fallback = 'insufficient_evidence: no selectable site fact';
      }
      return {
        type: 'answer', answer: insufficientEvidenceAnswer(eligible[0]?.title || ''), confidence: MIN_CONFIDENCE,
        source: 'site_index', matchTitle: eligible[0]?.title || '', matchUrl: eligible[0]?.url || '',
        evidenceCount: candidates.length, usedFacts: [], synthesized: true,
      };
    }
    if (debug) { debug.answeredSource = 'none'; debug.validation = 'no relevant facts'; }
    return null;
  }
  const payload = extractAnswerPayload(question, selected, sourceConfidence, {
    siteSnippets: siteCands.map((c) => c.snippet || ''),
    identityToks,
  });
  if (debug) {
    debug.answerFacts = payload.answerFacts; debug.supportingFacts = payload.supportingFacts;
    debug.extractSource = payload.sourceType; debug.siteFactFilter = payload._filter;
    debug.selectedResource = payload.sourceTitle;
    debug.selectedFact = payload.answerFacts[0] || '';
    debug.factIntent = payload._intent;
    debug.factRankScores = payload._factRankScores;
    debug.metaFactsRemoved = selected.metaFactsRemoved || 0;
  }

  const finish = (answer, synthesized, usedFacts, confidence) => {
    if (debug) { debug.answeredSource = `${payload.sourceType}${synthesized ? '(fallback)' : ''}`; }
    return {
      type: 'answer', answer, confidence, source: payload.sourceType,
      matchTitle: payload.sourceTitle, matchUrl: payload.sourceUrl,
      evidenceCount: candidates.length, usedFacts, synthesized,
    };
  };

  // Site page selected but extraction found only chrome/menu noise, or the best fact
  // barely matches the question (ubiquitous-token noise like the org name / header
  // ticker) → clean insufficient-evidence answer, never noisy text, never old handler.
  // ponytail: 0.5 floor tuned on the real crawl; raise if headers still leak through.
  const SITE_FACT_MIN = 0.5;
  const siteQuality = payload.sourceType === 'site_index'
    ? _siteFactQuality(payload)
    : { sufficient: true, reason: 'catalog fact' };
  if (debug && payload.sourceType === 'site_index') {
    debug.siteFactQuality = `${siteQuality.sufficient ? 'sufficient' : 'insufficient'}: ${siteQuality.reason}`;
    debug.siteNoiseRejected = (payload._filter?.removedChrome || 0) + (payload._filter?.rejectedLists || 0);
  }
  const siteWeak = payload.sourceType === 'site_index'
    && (!siteQuality.sufficient || payload.answerFacts.length === 0 || payload._topScore < SITE_FACT_MIN);
  if (siteWeak) {
    if (debug) debug.fallback = `insufficient_evidence: ${siteQuality.reason}`;
    return finish(insufficientEvidenceAnswer(payload.sourceTitle), true, [], payload.confidence || MIN_CONFIDENCE);
  }
  if (payload.answerFacts.length === 0) {
    if (debug) debug.answeredSource = 'none';
    return null;
  }

  // REFORMULATE — always send the extracted facts to Gemma.
  let gemma = null;
  try { gemma = await askReformulate(payload, callModel); } catch { gemma = null; }
  const decision = validateReformulation(gemma, payload, question);
  if (debug) {
    debug.gemma = gemma ? { usedFacts: gemma.usedFacts, confidence: gemma.confidence } : null;
    debug.validation = decision.ok ? 'accepted' : `rejected: ${decision.reason}`;
  }
  if (decision.ok) return finish(decision.answer, false, decision.usedFacts, decision.confidence);

  // FALLBACK — clean deterministic sentence from the extracted facts.
  const det = deterministicAnswer(payload);
  if (det) {
    if (debug) debug.fallback = `selected fact 0 (${payload._intent}): ${String(payload.answerFacts[0] || '').slice(0, 80)}`;
    return finish(det, true, [0], payload.confidence || MIN_CONFIDENCE);
  }
  // Site page selected but no presentable fact → honest insufficient-evidence answer,
  // never noisy chrome text.
  if (payload.sourceType === 'site_index') {
    if (debug) debug.fallback = 'insufficient_evidence';
    return finish(insufficientEvidenceAnswer(payload.sourceTitle), true, [], payload.confidence || MIN_CONFIDENCE);
  }
  if (debug) debug.answeredSource = 'none';
  return null;
}

function _pathOf(url) { try { return new URL(url).pathname; } catch { return ''; } }

module.exports = {
  gatherCandidates, resolveEvidence, arbitrateSources, classifyScope, isListIntent,
  extractAnswerPayload, askReformulate, validateReformulation, deterministicAnswer, resolveAskAnswer,
  detectFactIntent,
  filterSiteFacts, insufficientEvidenceAnswer,
  REFORMULATE_SYSTEM, ASK_RESOLVER_VERSION, MIN_CONFIDENCE, MIN_SOURCE_CONF,
};
