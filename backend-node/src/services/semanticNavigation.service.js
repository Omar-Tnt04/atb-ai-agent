'use strict';
/**
 * ACT SEMANTIC NAVIGATION — bge-m3 embeddings over site-index.json.
 * ------------------------------------------------------------------------------
 * Selects a page / document target for ACT mode from the SAME prepared query
 * embedding that ASK uses. Builds a navigation index (pages + documents + document
 * actions) and cosine-searches it. Cache lives OUTSIDE site-context:
 *   <SEMANTIC_INDEX_BASE_DIR>/<domain>/site-navigation-index.json
 *
 * Reuses embed()/cosine() from semanticRetrieval so the query vector and the chunk
 * vectors always share one model. Never throws — ok:false → caller uses the existing
 * site-index keyword/navigation fallback. Reads site-index.json only (schema unchanged).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { getSiteIndex } = require('./siteIndex.service');
const { embed, cosine, semanticIndexBaseDir } = require('./semanticRetrieval.service');
const { cleanText, foldAccents } = require('./queryNormalization.service');

// ── Generic lexical helpers (no banking glossary, no per-question rules) ─────────
const normText = (s) => foldAccents(cleanText(s || ''));

// Generic stopwords (FR+EN function words + a couple of navigation verbs that carry no
// target meaning). Content tokens only survive for overlap/filename matching.
const STOP = new Set([
  'de', 'la', 'le', 'les', 'des', 'du', 'un', 'une', 'pour', 'aux', 'au', 'sur', 'en', 'et',
  'the', 'of', 'to', 'and', 'for', 'my', 'me', 'je', 'veux', 'avec', 'dans', 'par', 'page',
  'ouvre', 'ouvrir', 'open', 'va', 'aller', 'go', 'navigate', 'acceder', 'visiter',
  'telecharge', 'telecharger', 'download', 'ouvrez', 'montre', 'montrer', 'show',
]);

const toTokens = (s) => normText(s).split(/\s+/).filter((t) => t.length >= 3 && !STOP.has(t));

const urlSlug = (u) => {
  try {
    const p = new URL(u);
    return normText((p.pathname.split('/').filter(Boolean).pop() || '').replace(/\.[a-z0-9]+$/, '').replace(/[-_]+/g, ' '));
  } catch { return ''; }
};

// Intent detection (generic verbs/nouns, folded).
const DOC_INTENT_RE = /\b(telecharge|telecharger|download|formulaire|document|documents|pdf|fichier|dossier|charte|liste)\b/;
const PAGE_INTENT_RE = /\b(ouvre|ouvrir|open|navigate|aller|acceder|visiter|va)\b/;
const GENERIC_TITLE_RE = /arab tunisian bank/;
// Crawl-captured dead pages — never a valid ACT navigation target.
const DEAD_PAGE_RE = /\b404\b|page not found|not found|erreur 404|error 404/;
// Endpoint-ish page slugs (form POST targets etc.) — prefer the clean public path.
const FORM_PATH_RE = /\b(form|post|submit|send|ajax|api)\b/;

function targetDomain() {
  try { return new URL(process.env.TARGET_URL || 'https://atb.tn').hostname.replace(/^www\./, ''); }
  catch { return 'atb.tn'; }
}

const SITE_CONTEXT_DIR = path.join(__dirname, '../../..', 'site-context');
const siteIndexFile = (domain) => path.join(SITE_CONTEXT_DIR, domain, 'site-index.json');
const navIndexPath = (domain) => path.join(semanticIndexBaseDir(), domain, 'site-navigation-index.json');
const EMBED_MODEL = () => process.env.ACT_EMBEDDING_MODEL || process.env.ASK_EMBEDDING_MODEL || 'bge-m3';
const CHUNK_TEXT_CAP = 600;

function fileHash(file) {
  try { return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex'); }
  catch { return null; }
}

// ── Chunk building from site-index.json (read-only, no schema change) ────────────
function buildNavChunks(domain) {
  const index = getSiteIndex();
  if (!index) return [];
  const chunks = [];
  const seenPage = new Set();

  for (const page of index.pages || []) {
    if (!page || !page.url || seenPage.has(page.url)) continue;
    seenPage.add(page.url);
    const text = [page.title, page.description, page.textPreview]
      .filter(Boolean).join('. ').replace(/\s+/g, ' ').trim().slice(0, CHUNK_TEXT_CAP);
    if (!text) continue;
    chunks.push({
      id: `page:${page.url}`, sourceType: 'page', title: page.title || page.path || page.url,
      url: page.url, sourcePageUrl: null, text,
      metadata: { path: page.path || '' },
    });
  }

  for (const doc of index.uniqueDocuments || []) {
    if (!doc || !doc.documentUrl) continue;
    const text = [doc.linkText, doc.filename].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const dSlug = urlSlug(doc.documentUrl);
    chunks.push({
      id: `doc:${doc.documentUrl}`, sourceType: 'document',
      title: doc.linkText || doc.filename || doc.documentUrl, url: doc.documentUrl,
      sourcePageUrl: (doc.sourcePages && doc.sourcePages[0]) || null,
      linkText: doc.linkText || '', filename: doc.filename || '',
      normalizedSearchText: normText([doc.linkText, doc.filename, dSlug].filter(Boolean).join(' ')),
      text: text || doc.filename || doc.documentUrl,
      metadata: { filename: doc.filename || '', occurrencesCount: doc.occurrencesCount || 0 },
    });
  }

  for (const act of index.uniqueDocumentActions || []) {
    if (!act || !act.linkText) continue;
    chunks.push({
      id: `docaction:${act.linkText}`, sourceType: 'document-action', title: act.linkText,
      url: null, sourcePageUrl: (act.sourcePages && act.sourcePages[0]) || null,
      text: String(act.linkText).replace(/\s+/g, ' ').trim(),
      metadata: { occurrencesCount: act.occurrencesCount || 0 },
    });
  }

  return chunks.filter((c) => c.text);
}

// Embed in batches so a few-thousand-chunk site index doesn't hit one giant Ollama call.
async function embedBatched(texts, batchSize = 64) {
  const out = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const vecs = await embed(texts.slice(i, i + batchSize));
    for (const v of vecs) out.push(v);
  }
  return out;
}

async function buildNavIndex(domain = targetDomain()) {
  const chunks = buildNavChunks(domain);
  if (chunks.length === 0) throw new Error('no navigation chunks to index');
  const vectors = await embedBatched(chunks.map((c) => c.text));
  const stored = chunks.map((c, i) => ({
    id: c.id, sourceType: c.sourceType, title: c.title, url: c.url,
    sourcePageUrl: c.sourcePageUrl, textPreview: c.text.slice(0, 200),
    metadata: c.metadata, embedding: vectors[i],
  }));
  const index = {
    meta: { domain, model: EMBED_MODEL(), builtAt: new Date().toISOString(), sourceHash: fileHash(siteIndexFile(domain)) },
    chunks: stored,
  };
  const file = navIndexPath(domain);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(index));
  return index;
}

let _mem = null; // { domain, index }

async function ensureNavIndex(domain = targetDomain()) {
  const want = fileHash(siteIndexFile(domain));
  const model = EMBED_MODEL();
  if (_mem && _mem.domain === domain && _mem.index.meta.model === model && _mem.index.meta.sourceHash === want) {
    return { index: _mem.index, built: false };
  }
  const file = navIndexPath(domain);
  if (fs.existsSync(file)) {
    try {
      const disk = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (disk.meta && disk.meta.model === model && disk.meta.sourceHash === want) {
        _mem = { domain, index: disk };
        return { index: disk, built: false };
      }
    } catch { /* corrupt → rebuild */ }
  }
  const index = await buildNavIndex(domain);
  _mem = { domain, index };
  return { index, built: true };
}

/**
 * Semantic navigation search. Reuses the prepared query embedding.
 * @returns {{ok, matches, topMatch, failedReason, indexPath, indexBuilt, chunkCount,
 *            reusedEmbedding, model, debug}}
 */
async function semanticSearchNavigation({
  domain = targetDomain(), normalizedQuestion = '', queryEmbedding = null, topK, minScore,
} = {}) {
  const k = topK || parseInt(process.env.ACT_SEMANTIC_TOP_K || '5', 10);
  const floor = minScore != null ? minScore : parseFloat(process.env.ACT_SEMANTIC_MIN_SCORE || '0.45');
  const result = {
    ok: false, matches: [], topMatch: null, confident: false, failedReason: '', indexPath: navIndexPath(domain),
    indexBuilt: false, chunkCount: 0, reusedEmbedding: false, model: EMBED_MODEL(), debug: {},
  };

  let index;
  try {
    const r = await ensureNavIndex(domain);
    index = r.index; result.indexBuilt = r.built; result.chunkCount = index.chunks.length;
  } catch (e) {
    result.failedReason = `nav_index_build_failed: ${e.message}`;
    return result;
  }

  let qvec = Array.isArray(queryEmbedding) && queryEmbedding.length ? queryEmbedding : null;
  if (qvec) {
    result.reusedEmbedding = true;
  } else {
    try { [qvec] = await embed(normalizedQuestion); }
    catch (e) { result.failedReason = /timeout/i.test(e.message) ? 'embed_timeout' : 'embed_failed'; return result; }
  }

  // ── Query analysis (needed for both pooling and rerank) ────────────────────────
  const qNorm = normText(normalizedQuestion);
  const qTokens = [...new Set(toTokens(normalizedQuestion))];
  const qWords = qNorm.split(/\s+/).filter(Boolean);
  const qContentOrdered = qWords.filter((w) => w.length >= 3 && !STOP.has(w)); // order preserved
  const qPhrases = []; // contiguous 2..4-grams, longest first
  for (let n = 4; n >= 2; n -= 1) {
    for (let i = 0; i + n <= qWords.length; i += 1) qPhrases.push(qWords.slice(i, i + n).join(' '));
  }
  const qConcats = []; // content-token concatenations, e.g. atb+pay → "atbpay"
  for (let n = 3; n >= 2; n -= 1) {
    for (let i = 0; i + n <= qContentOrdered.length; i += 1) {
      const cc = qContentOrdered.slice(i, i + n).join('');
      if (cc.length >= 5) qConcats.push(cc);
    }
  }

  // ── Stage 1: candidate pool = top-cosine ∪ lexical-prefilter ────────────────────
  // Pure cosine buries NAMED targets when the query term is generic (e.g. "atb"), so we
  // union the top-cosine pool with any chunk whose OWN slug/filename lexically matches the
  // query — guaranteeing named pages/documents are always reranked.
  const allScored = index.chunks.map((c) => ({ c, sem: cosine(qvec, c.embedding) }));
  const topCos = [...allScored].sort((a, b) => b.sem - a.sem).slice(0, 60);
  const lexHits = allScored.filter(({ c }) => {
    const slugRaw = urlSlug(c.url).replace(/\s+/g, '');
    const fn = normText((c.metadata && c.metadata.filename) || '');
    if (qConcats.some((cc) => slugRaw.includes(cc))) return true;
    return qContentOrdered.filter((t) => fn.includes(t) || slugRaw.includes(t)).length >= 2;
  });
  const seenId = new Set();
  const pool = [];
  for (const s of [...topCos, ...lexHits]) {
    if (!seenId.has(s.c.id)) { seenId.add(s.c.id); pool.push(s); }
  }

  // ── Stage 2: hybrid rerank (semantic + generic lexical) ────────────────────────
  const docIntent = DOC_INTENT_RE.test(qNorm);
  const pageIntent = !docIntent && PAGE_INTENT_RE.test(qNorm);

  const reranked = pool.map(({ c, sem }) => {
    const filenameNorm = normText((c.metadata && c.metadata.filename) || '');
    // Match the candidate's OWN url slug only — NOT its source page slug (otherwise every
    // document linked from documents_utiles.php inherits "documents utiles").
    const ownSlug = urlSlug(c.url);
    const ownSlugRaw = ownSlug.replace(/\s+/g, '');
    const titleNorm = normText(c.title);
    const fullNorm = normText([c.title, (c.metadata && c.metadata.filename) || '', ownSlug, c.textPreview].filter(Boolean).join(' '));
    const candTokens = new Set(toTokens(`${c.title} ${(c.metadata && c.metadata.filename) || ''} ${ownSlug}`));

    const reasons = [];
    let boost = 0;

    // 1. Exact phrase (longest query n-gram present). Strong when it hits title/filename.
    let phraseHit = '';
    for (const ph of qPhrases) { if (ph.length >= 6 && fullNorm.includes(ph)) { phraseHit = ph; break; } }
    if (phraseHit) {
      const where = titleNorm.includes(phraseHit) ? 'title' : filenameNorm.includes(phraseHit) ? 'filename' : 'text';
      boost += where === 'text' ? 0.25 : 0.55;
      reasons.push(`exact_phrase:${where}:${phraseHit}`);
    }

    // 1b. URL-slug match — the candidate's own slug IS (part of) the named target.
    // Handles spaced ("documents utiles") and concatenated ("atbpay" from atb+pay) forms.
    let slugHit = '';
    for (const ph of qPhrases) {
      const raw = ph.replace(/\s+/g, '');
      if (raw.length >= 5 && ownSlugRaw.includes(raw)) { slugHit = ph; break; }
    }
    if (!slugHit) {
      for (let n = 3; n >= 2 && !slugHit; n -= 1) {
        for (let i = 0; i + n <= qContentOrdered.length; i += 1) {
          const cc = qContentOrdered.slice(i, i + n).join('');
          if (cc.length >= 5 && ownSlugRaw.includes(cc)) { slugHit = qContentOrdered.slice(i, i + n).join(' '); break; }
        }
      }
    }
    if (slugHit) { boost += 0.5; reasons.push(`slug_match:${slugHit}`); }

    // 2. Token overlap (query content tokens found in title/filename/slug).
    const overlap = qTokens.filter((t) => candTokens.has(t));
    if (qTokens.length) {
      boost += (overlap.length / qTokens.length) * 0.30;
      if (overlap.length) reasons.push(`token_overlap:${overlap.join(',')}`);
    }

    // 3. Filename / own-slug tokens (precise — the file/page itself names the target).
    const fnTokens = qTokens.filter((t) => filenameNorm.includes(t) || ownSlug.includes(t));
    if (fnTokens.length) {
      boost += Math.min(fnTokens.length * 0.15, 0.5);
      reasons.push(`filename_tokens:${fnTokens.join(',')}`);
    }

    // 4/5. Document vs page intent.
    if (docIntent && (c.sourceType === 'document' || c.sourceType === 'document-action')) {
      boost += 0.20; reasons.push('document_intent');
    } else if (pageIntent && c.sourceType === 'page') {
      boost += 0.20; reasons.push('page_intent');
    } else if (docIntent && c.sourceType === 'page') {
      boost -= 0.08; // mild wrong-type nudge; strong lexical still wins
    }

    // 6. Generic page penalty — weak-title homepage-style pages with no real match.
    if (c.sourceType === 'page' && GENERIC_TITLE_RE.test(titleNorm)
        && !phraseHit && fnTokens.length === 0 && overlap.length <= 1) {
      boost -= 0.30; reasons.push('generic_page_penalty');
    }

    // 7. Clean-path preference: exact slug == query; penalize form/post endpoints; and a
    // mild depth tiebreak so the canonical shallow path wins near-ties (e.g. prefer
    // /documents_utiles.php over /ar/documents_utiles.php). Generic — no language coupling.
    if (c.sourceType === 'page') {
      const slugTokens = ownSlug.split(/\s+/).filter(Boolean).join(' ');
      if (slugTokens && slugTokens === qContentOrdered.join(' ')) { boost += 0.15; reasons.push('exact_slug'); }
      if (FORM_PATH_RE.test(ownSlug)) { boost -= 0.10; reasons.push('form_path_penalty'); }
      let segs = [];
      try { segs = new URL(c.url).pathname.split('/').filter(Boolean); } catch { /* keep [] */ }
      if (segs.length > 1) boost -= Math.min((segs.length - 1) * 0.03, 0.15);
      // Language-mirror deprioritization: a leading /ar/, /en/, /fr/… segment marks a
      // localized mirror; prefer the canonical un-prefixed path on near-ties.
      if (/^(ar|en|fr|es|de|it)$/.test(segs[0] || '')) { boost -= 0.15; reasons.push('lang_mirror_penalty'); }
    }

    // 8. Dead-page detection (pages only; documents only with explicit 404 evidence in
    // their OWN title/filename). Penalized here and rejected after sorting.
    const deadText = normText(`${c.title} ${c.textPreview || ''}`);
    const isDead = c.sourceType === 'document'
      ? DEAD_PAGE_RE.test(normText(`${c.title} ${(c.metadata && c.metadata.filename) || ''}`))
      : DEAD_PAGE_RE.test(deadText);
    if (isDead) { boost -= 2.0; reasons.push('dead_page_penalty'); }

    return {
      sourceType: c.sourceType, title: c.title, url: c.url, sourcePageUrl: c.sourcePageUrl,
      metadata: c.metadata, dead: isDead,
      semanticScore: Number(sem.toFixed(4)),
      lexicalBoost: Number(boost.toFixed(4)),
      finalScore: Number((sem + boost).toFixed(4)),
      boostReasons: reasons,
      score: Number((sem + boost).toFixed(4)),
    };
  }).sort((a, b) => b.finalScore - a.finalScore);

  // Reject dead pages when any valid candidate exists; if ALL are dead → keep them but
  // mark not-confident so ACT falls back to keyword navigation (rule 4).
  const valid = reranked.filter((m) => !m.dead);
  const usable = valid.length ? valid : reranked;
  const rejectedDead = reranked.length - valid.length;

  const top = usable[0] || null;
  const second = usable[1] || null;
  const strongExact = !!top && top.boostReasons.some((r) => /^exact_phrase:(title|filename)/.test(r) || /^filename_tokens/.test(r));
  const margin = top ? top.finalScore - (second ? second.finalScore : 0) : 0;
  const confident = !!top && !top.dead && top.finalScore >= (floor + 0.15) && (margin >= 0.05 || strongExact);

  result.ok = true;
  result.matches = usable.slice(0, k);
  result.topMatch = top;
  result.confident = confident;
  result.debug = {
    docIntent, pageIntent, poolSize: pool.length, margin: Number(margin.toFixed(4)), strongExact,
    rejectedDeadPages: rejectedDead,
    topMatches: usable.slice(0, 5).map((m) => ({
      title: String(m.title || '').slice(0, 50), url: m.url, sourceType: m.sourceType,
      semanticScore: m.semanticScore, lexicalBoost: m.lexicalBoost, finalScore: m.finalScore,
      boostReasons: m.boostReasons,
    })),
  };
  return result;
}

module.exports = { semanticSearchNavigation, buildNavIndex, ensureNavIndex, navIndexPath };
