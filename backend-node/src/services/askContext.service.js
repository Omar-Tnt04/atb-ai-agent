'use strict';
/**
 * ASK-MODE CONTEXT RETRIEVAL — site-context/<domain>/ask-context.json
 * ------------------------------------------------------------------------------
 * This is the primary ask-mode knowledge source. It loads the manually authored
 * ask-context.json (produced from the Playwright capture package), retrieves the
 * most relevant contextBlocks for a user question with lightweight keyword
 * scoring (no vector DB), and builds a GROUNDED answer that uses ONLY the
 * selected blocks — never the full JSON, never invented facts.
 *
 * Flow: question → loadAskContext(domain) → retrieveBlocks() → buildGroundedAnswer()
 *
 * Domain-generic: the domain is derived from TARGET_URL (same convention as
 * siteIndex.service.js), and nothing here is hardcoded to a specific site.
 *
 * act mode is untouched: it keeps using site-index.json. context.json is not used.
 */

const fs = require('fs');
const path = require('path');

// ── Where ask-context.json lives (mirrors siteIndex.service.js layout) ─────────
const SITE_CONTEXT_DIR = path.join(__dirname, '../../..', 'site-context');

function targetDomain() {
  try {
    return new URL(process.env.TARGET_URL || 'https://atb.tn').hostname.replace(/^www\./, '');
  } catch {
    return 'atb.tn';
  }
}

function askContextPath(domain = targetDomain()) {
  return path.join(SITE_CONTEXT_DIR, domain, 'ask-context.json');
}

// Exact message required when neither the captured site context nor the catalog
// can answer the question. (Ask mode retrieves from ask-context.json + catalog.json.)
const NOT_ENOUGH_INFO =
  "I don’t have enough information in the captured site context or catalog to answer that.";

// ── In-memory cache (5-min TTL, keyed by domain) ───────────────────────────────
const _mem = new Map();
const MEM_TTL_MS = 5 * 60 * 1000;

/** Load and cache ask-context.json for a domain. Returns null when absent/invalid. */
function loadAskContext(domain = targetDomain()) {
  const now = Date.now();
  const hit = _mem.get(domain);
  if (hit && (now - hit.at) < MEM_TTL_MS) return hit.data;
  try {
    const file = askContextPath(domain);
    if (!fs.existsSync(file)) { _mem.set(domain, { data: null, at: now }); return null; }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const data = Array.isArray(parsed?.contextBlocks) ? parsed : null;
    _mem.set(domain, { data, at: now });
    return data;
  } catch {
    _mem.set(domain, { data: null, at: now });
    return null;
  }
}

function clearAskContextCache() { _mem.clear(); }

// ── Tokenizer (accent-folded, multilingual) ────────────────────────────────────
// Same approach as siteIndex.service.js: fold NFD diacritics so French matches
// regardless of accents; drop short/stop tokens. Generic, not per-word.
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'this', 'that', 'with', 'from', 'what', 'how', 'does', 'can',
  'you', 'have', 'has', 'will', 'its', 'more', 'but', 'not', 'all', 'any', 'about', 'which',
  'les', 'des', 'pour', 'dans', 'sur', 'une', 'est', 'qui', 'que', 'par', 'pas', 'avec',
  'cette', 'votre', 'notre', 'quel', 'quels', 'quelle', 'quelles', 'est-ce',
]);

function foldAccents(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function tokenize(text) {
  return foldAccents(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

// Prefix stem match for morphological variants ("credit" ↔ "credits", "carte" ↔ "cartes").
function stemMatch(a, b) {
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  if (min < 5) return false;
  return a.startsWith(b.slice(0, min)) || b.startsWith(a.slice(0, min));
}

// ── Retrieval ──────────────────────────────────────────────────────────────────
// Score each contextBlock against the query over its retrieval fields, weighted by
// how strong each field is as evidence of relevance.
const FIELD_WEIGHTS = {
  usefulForQuestionsAbout: 0.40, // curated "ask me about" hints — strongest signal
  keyPointPoint:          0.30,
  title:                  0.30,
  richContext:            0.15,
  promptText:             0.12,
  keyPointEvidence:       0.10,
};

/** Flatten a block's searchable text per field into token sets (memo-friendly). */
function blockFieldTokens(block) {
  const kps = Array.isArray(block.keyPoints) ? block.keyPoints : [];
  return {
    title: tokenize(block.title),
    usefulForQuestionsAbout: tokenize((block.usefulForQuestionsAbout || []).join(' ')),
    richContext: tokenize(block.richContext),
    promptText: tokenize(block.promptText),
    keyPointPoint: tokenize(kps.map((k) => k && k.point).filter(Boolean).join(' ')),
    keyPointEvidence: tokenize(kps.map((k) => k && k.evidence).filter(Boolean).join(' ')),
  };
}

/**
 * Retrieve the top relevant contextBlocks for a question.
 * Returns [{ block, score, hits }] sorted desc, filtered to score >= minScore.
 * Score is normalized by query token count so it is comparable across questions.
 */
function retrieveBlocks(question, askContext, { topK = 4, minScore = 0.18 } = {}) {
  if (!askContext || !Array.isArray(askContext.contextBlocks)) return [];
  const qTokens = tokenize(question);
  if (qTokens.length === 0) return [];

  const scored = [];
  for (const block of askContext.contextBlocks) {
    const fields = blockFieldTokens(block);
    let raw = 0;
    const matchedConcepts = new Set();
    for (const qt of qTokens) {
      // Count each query concept at most once, at its strongest matching field.
      let best = 0;
      for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
        const toks = fields[field] || [];
        if (toks.some((t) => stemMatch(qt, t)) && weight > best) best = weight;
      }
      if (best > 0) { raw += best; matchedConcepts.add(qt); }
    }
    if (matchedConcepts.size === 0) continue;
    // Normalize by query length so longer questions are not penalized.
    const score = raw / qTokens.length + matchedConcepts.size * 0.02;
    if (score >= minScore) scored.push({ block, score, hits: matchedConcepts.size });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// ── Grounded answer ─────────────────────────────────────────────────────────────
/**
 * Pick the keyPoints inside a block that actually relate to the query, so the
 * answer cites specific evidence rather than dumping the whole block.
 */
function relevantKeyPoints(question, block, limit = 4) {
  const qTokens = tokenize(question);
  const kps = Array.isArray(block.keyPoints) ? block.keyPoints : [];
  const scored = kps.map((kp) => {
    const toks = tokenize(`${kp && kp.point} ${kp && kp.evidence}`);
    let hits = 0;
    for (const qt of qTokens) if (toks.some((t) => stemMatch(qt, t))) hits++;
    return { kp, hits };
  });
  const relevant = scored.filter((s) => s.hits > 0).sort((a, b) => b.hits - a.hits);
  const picked = (relevant.length ? relevant : scored).slice(0, limit).map((s) => s.kp);
  return picked.filter((kp) => kp && (kp.point || kp.evidence));
}

/**
 * Build a grounded answer from the selected blocks ONLY.
 * Deterministic (no model call) so it is offline-safe and cannot hallucinate:
 * it surfaces the block summary, the matching keyPoints with their exact evidence,
 * and the source URL(s). This is the "answer only from selected context" guarantee.
 * Returns a string, or null if the selected blocks carry nothing usable.
 */
function buildGroundedAnswer(question, blocks) {
  if (!blocks || blocks.length === 0) return null;

  const primary = blocks[0].block;
  const kps = relevantKeyPoints(question, primary);
  const lines = [];

  const lead = String(primary.richContext || primary.promptText || '').replace(/\s+/g, ' ').trim();
  if (lead) lines.push(lead.length > 220 ? `${lead.slice(0, 217)}…` : lead);

  // Concise: 3–5 bullets, each evidence quote capped so a raw table can't dump verbatim.
  for (const kp of kps.slice(0, 5)) {
    if (kp.point && kp.evidence) {
      const ev = String(kp.evidence).replace(/\s+/g, ' ').trim();
      const quote = ev.length > 120 ? `${ev.slice(0, 117)}…` : ev;
      lines.push(`- ${kp.point} — “${quote}”`);
    } else if (kp.point) lines.push(`- ${kp.point}`);
  }

  // Sources: primary + any additional selected blocks (deduped).
  const sources = [];
  for (const { block } of blocks) {
    if (block.url && !sources.includes(block.url)) sources.push(block.url);
  }
  if (sources.length) lines.push(`Source: ${sources.slice(0, 3).join(' | ')}`);

  const answer = lines.filter(Boolean).join('\n').trim();
  return answer || null;
}

/** Load ask-context for a domain and return the top relevant blocks (or []). */
function retrieveAskContextBlocks(question, { domain } = {}) {
  const askContext = loadAskContext(domain);
  if (!askContext) return [];
  return retrieveBlocks(question, askContext);
}

/**
 * Top-level ask-context answerer (ask-context.json ONLY).
 * Kept for direct/unit use; the ask-mode middleware uses buildCombinedAnswer so
 * catalog.json evidence is considered too.
 */
function buildAskContextAnswer(question, { domain } = {}) {
  const blocks = retrieveAskContextBlocks(question, { domain });
  if (blocks.length === 0) return { answered: false, answer: NOT_ENOUGH_INFO, sources: [], blocks: [] };

  const answer = buildGroundedAnswer(question, blocks);
  if (!answer) return { answered: false, answer: NOT_ENOUGH_INFO, sources: [], blocks: [] };

  const sources = blocks.map(({ block }) => block.url).filter(Boolean);
  return { answered: true, answer, sources, blocks };
}

/**
 * Build ONE grounded answer from BOTH selected ask-context blocks AND selected
 * catalog entries. Only the pre-selected evidence is used (never the full files).
 * Each source is labeled: ask-context.json + page URL / catalog.json + id/category.
 *
 * @param {Array<{block,score}>} askBlocks      from retrieveBlocks / retrieveAskContextBlocks
 * @param {Array<{score, source, id, title, category, description, url, evidence}>} catalogEntries
 *        from catalogRetrieval.service.retrieveCatalogEntries
 * Returns { answered, answer, sources }.
 */
function buildCombinedAnswer(question, { askBlocks = [], catalogEntries = [], exactEvidence = [] } = {}) {
  const lines = [];
  const sources = [];

  // ── ask-exact-context.json evidence (highest priority, verbatim) ──────────
  if ((exactEvidence || []).length > 0) {
    for (const e of exactEvidence.slice(0, 3)) {
      const label = e.title || e.blockId || 'page';
      for (const c of (e.chunks || []).slice(0, 2)) {
        lines.push(`- ${String(c).slice(0, 300)}`);
      }
      lines.push(`  Source: ask-exact-context.json${e.url ? ` — ${e.url}` : ''}`);
      sources.push(`ask-exact-context.json:${e.url || label}`);
    }
  }

  // ── ask-context.json evidence ────────────────────────────────────────────
  if (askBlocks.length > 0) {
    if (lines.length) lines.push('');
    const web = buildGroundedAnswer(question, askBlocks);
    if (web) {
      // buildGroundedAnswer already appends its own "Source: <url>" line.
      lines.push(web.replace(/^Source:/m, 'Source: ask-context.json —'));
      for (const { block } of askBlocks) if (block.url) sources.push(`ask-context.json:${block.url}`);
    }
  }

  // ── catalog.json evidence ────────────────────────────────────────────────
  if (catalogEntries.length > 0) {
    if (lines.length) lines.push(''); // separate the two source sections
    lines.push('From the catalog:');
    for (const e of catalogEntries.slice(0, 4)) {
      const label = e.title || e.id || 'item';
      const detail = e.evidence || e.description || '';
      lines.push(detail ? `- ${label} — ${String(detail).slice(0, 200)}` : `- ${label}`);
      // Source: catalog.json + item/category/id when available.
      const tag = [e.id && `id=${e.id}`, e.category && `category=${e.category}`].filter(Boolean).join(', ');
      lines.push(`  Source: catalog.json${tag ? ` (${tag})` : ''}`);
      sources.push(`catalog.json:${e.id || label}`);
    }
  }

  const answer = lines.filter((l) => l !== undefined).join('\n').trim();
  if (!answer) return { answered: false, answer: NOT_ENOUGH_INFO, sources: [] };
  return { answered: true, answer, sources };
}

// ══════════════════════════════════════════════════════════════════════════════
// OPTIONAL LLM SYNTHESIS (qwen3:14b) — gated by ASK_USE_LLM_SYNTHESIS.
// Sends ONLY the already-selected ask-context blocks + catalog entries to the local
// model (never the full JSON files), instructs it to answer strictly from that
// evidence, then light-validates the output. On any failure/timeout/empty/unsupported
// fact → returns null so the caller falls back to the deterministic buildCombinedAnswer.
// ══════════════════════════════════════════════════════════════════════════════

const http = require('http');

const SYNTHESIS_SYSTEM =
  'You answer a banking website user strictly from the EVIDENCE provided. ' +
  'Use ONLY facts present in the evidence — never add outside knowledge, never guess numbers, ' +
  'emails, phone numbers, rates or dates. If the evidence does not cover the question, say so briefly. ' +
  // Formatting for a narrow chat widget (ChatGPT-style):
  'Format the answer for a narrow chat widget: one short intro sentence, then Markdown bullet ' +
  'points ("- ") whenever you list contact details, documents, cards, amounts, rates, conditions ' +
  'or steps. Put the important label of each bullet in **bold**, e.g. "- **Email**: x@y.com". ' +
  'Keep it compact — no long dense paragraphs. ' +
  'Do NOT put sources, URLs or citations in the answer body (they are shown separately). ' +
  'Do NOT copy internal context summaries or page headings such as "Complaints page", ' +
  '"Context summary" or similar — write a natural user-facing answer. ' +
  // Long lists (e.g. a full agency directory): summarize, do not dump.
  'If the evidence contains a long list (e.g. many agencies grouped by region), do NOT ' +
  'reproduce the whole list — confirm it exists, give a few grouped examples, and say the ' +
  'full list is available on the page. ' +
  'Return strict JSON only: {"answer":"..."}';

// Per-call language directive + localized style rules appended to the system prompt.
function _languageClause(responseLanguage) {
  if (responseLanguage === 'fr') {
    return ' The user wrote in French — répond en français. Utilise un format clair et compact : ' +
      'une courte phrase d\'introduction puis des puces Markdown ("- ") pour les coordonnées, ' +
      'documents, montants, taux, conditions ou étapes. Mets les libellés importants en **gras**. ' +
      'Ne mets pas les sources dans le corps de la réponse. Ne copie pas les résumés internes ' +
      '(ex. "Complaints page..."). Utilise uniquement les preuves fournies.';
  }
  if (responseLanguage === 'en') {
    return ' The user wrote in English — answer in English. Use a clear compact format: a short ' +
      'intro sentence then Markdown bullets ("- ") for contact details, documents, amounts, rates, ' +
      'conditions or steps, with **bold** labels. Keep sources out of the answer body.';
  }
  return ' Answer in the same language as the user question, using the compact bulleted format.';
}

// Compact evidence pack — the ONLY site/catalog data the model ever sees.
// exactEvidence (verbatim page chunks) is listed FIRST so the model treats it as the
// highest-priority ground truth for product/service/detail pages.
function buildEvidencePack(question, askBlocks, catalogEntries, exactEvidence = []) {
  const exact = (exactEvidence || []).slice(0, 3).map((e) => ({
    title: e.title || '', url: e.url || '',
    // Verbatim chunks, capped so the pack can't bloat and time qwen out.
    exactChunks: (e.chunks || []).slice(0, 3).map((c) => String(c || '').replace(/\s+/g, ' ').slice(0, 900)),
  }));
  const web = askBlocks.map(({ block }) => ({
    title: block.title || '',
    url: block.url || '',
    context: String(block.richContext || block.promptText || '').replace(/\s+/g, ' ').slice(0, 300),
    // Cap each keyPoint evidence so a big raw table (e.g. FX rates) can't bloat the pack
    // and time qwen out. 5 points is enough signal.
    keyPoints: (block.keyPoints || []).slice(0, 5).map((k) => ({
      point: k.point,
      evidence: String(k.evidence || '').replace(/\s+/g, ' ').slice(0, 160),
    })),
  }));
  const catalog = catalogEntries.slice(0, 4).map((e) => ({
    id: e.id, category: e.category, title: e.title,
    // Real file content (loaded by catalogRetrieval) up to ~1000 chars — the checklist etc.
    evidence: String(e.evidence || e.description || '').replace(/\s+/g, ' ').slice(0, 1000),
  }));
  return JSON.stringify({ question, exactEvidence: exact, askContextEvidence: web, catalogEvidence: catalog });
}

// The deterministic source lines (req 6). Appended by us regardless of the model,
// so sources are always present and correctly labeled.
function formatSourceLines(askBlocks, catalogEntries, exactEvidence = []) {
  const lines = [];
  const exactUrls = (exactEvidence || []).map((e) => e.url).filter(Boolean).slice(0, 3);
  if (exactUrls.length) lines.push(`Source: ask-exact-context.json — ${exactUrls.join(' | ')}`);
  const urls = askBlocks.map(({ block }) => block.url).filter(Boolean).slice(0, 3);
  if (urls.length) lines.push(`Source: ask-context.json — ${urls.join(' | ')}`);
  for (const e of catalogEntries.slice(0, 4)) {
    const tag = [e.id && `id=${e.id}`, e.category && `category=${e.category}`].filter(Boolean).join(', ');
    lines.push(`Source: catalog.json${tag ? ` (${tag})` : ''}`);
  }
  return lines;
}

// Thin Ollama client (mirrors askEvidenceResolver._defaultCallModel; ACT untouched).
function _callQwen(userContent, system = SYNTHESIS_SYSTEM) {
  const base = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = process.env.ASK_SYNTHESIS_MODEL || 'qwen3:14b';
  // qwen3:14b is a large model: allow generous default (cold load + ~25s generate).
  const timeoutMs = parseInt(process.env.ASK_SYNTHESIS_TIMEOUT_MS || '60000', 10);
  const body = JSON.stringify({
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }],
    // think:false disables qwen3 reasoning — required, else format:'json' returns
    // empty content (reasoning tokens consume the response). /no_think is a belt-and-braces.
    think: false,
    // keep_alive keeps qwen3:14b resident so it is not evicted between requests (cold reload ~25-30s).
    keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m',
    stream: false, format: 'json', options: { temperature: 0, num_predict: 400 },
  });
  return new Promise((resolve, reject) => {
    try {
      const u = new URL('/api/chat', base);
      const req = http.request({
        hostname: u.hostname, port: parseInt(u.port || '80', 10), path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => { try { resolve(String(JSON.parse(buf)?.message?.content || '')); } catch { reject(new Error('ollama parse failed')); } });
      });
      req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('ollama timeout')); });
      req.on('error', reject);
      req.write(body); req.end();
    } catch (e) { reject(e); }
  });
}

function _parseModelJson(raw) {
  const s = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^```(?:json)?/i, '').replace(/```$/, '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a === -1 || b < a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

// All evidence text the model was allowed to use (for the anti-hallucination guard).
function _evidenceCorpus(askBlocks, catalogEntries, exactEvidence = []) {
  const parts = [];
  // Exact chunks must be in the corpus or the anti-hallucination guard would reject
  // correct numbers taken from them (e.g. "80%", "200 000 DT").
  for (const e of exactEvidence || []) { parts.push(e.title); for (const c of e.chunks || []) parts.push(c); }
  for (const { block } of askBlocks) {
    parts.push(block.title, block.richContext, block.promptText);
    for (const k of block.keyPoints || []) parts.push(k.point, k.evidence);
  }
  for (const e of catalogEntries) parts.push(e.title, e.description, e.evidence, e.category, e.id);
  return parts.filter(Boolean).join(' ');
}

// Light guard: every email and every numeric/percent/currency token in the model's
// answer must appear in the evidence. Digits compared digits-only so phone/rate
// spacing differences don't false-negative. Returns true if the answer is supported.
function answerIsSupported(answer, corpus) {
  // Strip trailing sentence punctuation the greedy regex captures (e.g. an email at the
  // end of a sentence → "…@atb.com.tn." ). A real TLD never ends in punctuation, so this
  // is safe and prevents a supported email from being falsely rejected.
  const emails = (String(answer).match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [])
    .map((em) => em.replace(/[.,;:!?)\]}>'"]+$/, ''));
  for (const em of emails) if (!corpus.toLowerCase().includes(em.toLowerCase())) return false;

  const corpusDigits = corpus.replace(/\D+/g, ' ');
  // Numeric tokens with >=2 digits (rates, amounts, phones, years). Single digits are noise.
  const nums = String(answer).match(/\d[\d .,'’]*\d/g) || [];
  for (const n of nums) {
    const d = n.replace(/\D+/g, '');
    if (d.length < 2) continue;
    if (!corpusDigits.replace(/\s+/g, ' ').replace(/ /g, '').includes(d) &&
        !corpusDigits.includes(d)) return false;
  }
  return true;
}

function modelSaysNoEvidence(answer) {
  return /\b(?:does not include|do not have|don't have|not enough|insufficient|not provided|cannot determine|can't determine|doesn't say|no information)\b/i
    .test(String(answer || ''));
}

/**
 * Produce a synthesized natural-language answer from ONLY the selected evidence.
 * Returns a string (answer + source lines) on success, or null to signal fallback.
 * `callModel` is injectable for tests (defaults to the local qwen3 client).
 */
async function synthesizeAnswer(question, { askBlocks = [], catalogEntries = [], exactEvidence = [], callModel = _callQwen, diag = {}, responseLanguage } = {}) {
  diag.model = process.env.ASK_SYNTHESIS_MODEL || 'qwen3:14b';
  if (askBlocks.length === 0 && catalogEntries.length === 0 && exactEvidence.length === 0) {
    diag.called = false; diag.success = false; diag.failedReason = 'no_evidence';
    return null;
  }
  diag.exactBlocksUsed = exactEvidence.length;
  diag.exactChunksUsed = exactEvidence.reduce((n, e) => n + (e.chunks ? e.chunks.length : 0), 0);
  const pack = buildEvidencePack(question, askBlocks, catalogEntries, exactEvidence);
  diag.totalCharsSentToModel = pack.length;
  diag.called = true;
  const system = SYNTHESIS_SYSTEM + _languageClause(responseLanguage);
  let raw;
  const _qwenStart = Date.now();
  try {
    raw = await callModel(pack, system);
  } catch (e) {
    diag.qwenMs = Date.now() - _qwenStart;
    diag.success = false;
    diag.failedReason = /timeout/i.test(e && e.message) ? 'ollama_timeout' : 'ollama_unreachable';
    return null; // timeout / connection refused / parse error → deterministic fallback
  }
  diag.qwenMs = Date.now() - _qwenStart;
  const _valStart = Date.now();
  const parsed = _parseModelJson(raw);
  const modelAnswer = parsed && typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
  if (!modelAnswer) { diag.success = false; diag.failedReason = 'empty_model_response'; return null; }
  if (modelSaysNoEvidence(modelAnswer)) {
    diag.success = false;
    diag.noSupportedAnswer = true;
    diag.failedReason = 'model_said_no_evidence';
    return null;
  }

  // Anti-hallucination guard: unsupported numbers/emails → discard, fall back.
  if (!answerIsSupported(modelAnswer, _evidenceCorpus(askBlocks, catalogEntries, exactEvidence))) {
    diag.validationMs = Date.now() - _valStart;
    diag.success = false; diag.guardRejected = true; diag.failedReason = 'guard_rejected_unsupported_facts';
    return null;
  }
  diag.validationMs = Date.now() - _valStart;
  diag.success = true;

  // We always append the deterministic, correctly-labeled sources (req 6).
  const sourceLines = formatSourceLines(askBlocks, catalogEntries, exactEvidence);
  return [modelAnswer, sourceLines.length ? '' : null, ...sourceLines].filter((l) => l !== null).join('\n').trim();
}

/**
 * Ask-mode combined answerer WITH optional LLM synthesis.
 * - both sources empty → { answered:false } (caller falls through, non-regression)
 * - ASK_USE_LLM_SYNTHESIS=true → try qwen3 synthesis; on any failure, deterministic fallback
 * - otherwise → deterministic buildCombinedAnswer
 */
async function buildCombinedAnswerLLM(question, { askBlocks = [], catalogEntries = [], exactEvidence = [], callModel, diag = {}, responseLanguage } = {}) {
  const useLlm = /^(1|true|yes|on)$/i.test(String(process.env.ASK_USE_LLM_SYNTHESIS || ''));
  const requireLlm = /^(1|true|yes|on)$/i.test(String(process.env.ASK_REQUIRE_LLM_SYNTHESIS || ''));
  diag.enabled = useLlm;
  diag.required = requireLlm;
  diag.model = process.env.ASK_SYNTHESIS_MODEL || 'qwen3:14b';
  diag.called = false; diag.success = false; diag.guardRejected = false;
  diag.fallbackUsed = false; diag.failedReason = '';
  diag.exactBlocksUsed = (exactEvidence || []).length;

  if (askBlocks.length === 0 && catalogEntries.length === 0 && (exactEvidence || []).length === 0) {
    diag.finalPath = 'no_answer';
    return { answered: false, answer: NOT_ENOUGH_INFO, sources: [], synthesized: false };
  }
  if (useLlm) {
    const synthesized = await synthesizeAnswer(question, { askBlocks, catalogEntries, exactEvidence, callModel, diag, responseLanguage });
    if (synthesized) {
      diag.finalPath = 'qwen_synthesis';
      const sources = [
        ...(exactEvidence || []).map((e) => e.url).filter(Boolean).map((u) => `ask-exact-context.json:${u}`),
        ...askBlocks.map(({ block }) => block.url).filter(Boolean).map((u) => `ask-context.json:${u}`),
        ...catalogEntries.map((e) => `catalog.json:${e.id || e.title}`),
      ];
      return { answered: true, answer: synthesized, sources, synthesized: true };
    }
    // ASK_REQUIRE_LLM_SYNTHESIS (testing only, default false): surface WHY qwen failed
    // instead of silently masking it with the deterministic builder.
    if (requireLlm) {
      diag.finalPath = 'synthesis_required_failed';
      return {
        answered: true,
        synthesized: false,
        synthesisFailed: true,
        sources: [],
        answer: `⚠️ LLM synthesis was required (ASK_REQUIRE_LLM_SYNTHESIS=true) but failed: ${diag.failedReason || 'unknown'}. Deterministic fallback suppressed for diagnosis.`,
      };
    }
    if (diag.failedReason === 'model_said_no_evidence') {
      diag.finalPath = 'no_answer';
      return { answered: false, answer: NOT_ENOUGH_INFO, sources: [], synthesized: false };
    }
    diag.fallbackUsed = true; // fall through to deterministic on synthesis failure
  }
  const det = buildCombinedAnswer(question, { askBlocks, catalogEntries, exactEvidence });
  diag.finalPath = useLlm ? 'deterministic_fallback' : 'deterministic';
  return { ...det, synthesized: false };
}

module.exports = {
  NOT_ENOUGH_INFO,
  targetDomain,
  askContextPath,
  loadAskContext,
  clearAskContextCache,
  tokenize,
  stemMatch,
  foldAccents,
  retrieveBlocks,
  retrieveAskContextBlocks,
  buildGroundedAnswer,
  buildCombinedAnswer,
  buildCombinedAnswerLLM,
  synthesizeAnswer,
  answerIsSupported,
  modelSaysNoEvidence,
  buildAskContextAnswer,
};
