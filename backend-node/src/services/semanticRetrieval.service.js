'use strict';
/**
 * SEMANTIC RETRIEVAL — Ollama embeddings (bge-m3) over ask-context.json + catalog content.
 * ------------------------------------------------------------------------------
 * Multilingual, typo-tolerant retrieval for Ask mode. Builds a semantic index of
 * chunks (ask-context blocks + catalog entries with real file content), caches the
 * embeddings OUTSIDE site-context (ASK_SEMANTIC_INDEX_DIR/<domain>/semantic-index.json),
 * and cosine-searches the user question against it.
 *
 * Never throws to the caller: on any failure (bge-m3 missing, embed error, index build
 * error) retrieve() returns { ok:false, failedReason } so ask mode falls back to keyword
 * retrieval. Does not touch act mode or any site-context schema.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const env = require('../config/env');

const {
  targetDomain, loadAskContext, askContextPath,
} = require('./askContext.service');
const { loadResourceCatalog } = require('./resourceCatalog.service');
const { toEvidence, loadEntryContent, isImageCatalogEntry } = require('./catalogRetrieval.service');

const EMBED_MODEL = () => process.env.ASK_EMBEDDING_MODEL || 'bge-m3';
const OLLAMA_BASE = () => String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');

// backend-node/ root — anchor the cache here regardless of process CWD. The env value
// (default "backend-node/.cache/...") is repo-root-relative, so both the unset default
// and the documented env value resolve to <repo>/backend-node/.cache/semantic-indexes.
const BACKEND_ROOT = path.join(__dirname, '..', '..');
const INDEX_DIR = () => {
  const v = process.env.SEMANTIC_INDEX_BASE_DIR || process.env.ASK_SEMANTIC_INDEX_DIR;
  if (v) return path.isAbsolute(v) ? v : path.resolve(BACKEND_ROOT, '..', v);
  return path.join(BACKEND_ROOT, '.cache', 'semantic-indexes');
};
const CHUNK_TEXT_CAP = 1500;
const INDEX_SCHEMA_VERSION = 2;

// ── Ollama embedding client ────────────────────────────────────────────────────
function _ollama(endpoint, payload, timeoutMs) {
  const base = OLLAMA_BASE();
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(endpoint, base);
      const req = http.request({
        hostname: u.hostname, port: parseInt(u.port || '80', 10), path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { reject(new Error('embed parse failed')); } });
      });
      req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('embed timeout')); });
      req.on('error', reject);
      req.write(body); req.end();
    } catch (e) { reject(e); }
  });
}

/** Embed one or many texts. Returns array of vectors (same order). Throws on failure. */
async function embed(texts) {
  const input = Array.isArray(texts) ? texts : [texts];
  const timeoutMs = parseInt(process.env.ASK_EMBEDDING_TIMEOUT_MS || '120000', 10);
  // keep_alive keeps bge-m3 resident so it is not evicted between requests (cold reload ~8s).
  const keepAlive = process.env.OLLAMA_KEEP_ALIVE || '30m';
  const out = await _ollama('/api/embed', { model: EMBED_MODEL(), input, keep_alive: keepAlive }, timeoutMs);
  if (out?.error) throw new Error(`embed: ${out.error}`);
  const embeddings = out && out.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== input.length) {
    throw new Error('embed: unexpected response shape');
  }
  return embeddings;
}

/** True if the embedding model responds (no auto-pull). A 1-token embed is definitive. */
async function isEmbedModelAvailable() {
  try { await embed(['ping']); return true; } catch { return false; }
}

// ── Source hashing (cache invalidation) ─────────────────────────────────────────
function _fileHash(file) {
  try { return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex'); }
  catch { return null; }
}

function _catalogPath() { return path.resolve(env.resourceCatalogPath); }

// ── Chunk building ──────────────────────────────────────────────────────────────
function _askContextChunks(domain) {
  const ctx = loadAskContext(domain);
  if (!ctx || !Array.isArray(ctx.contextBlocks)) return [];
  return ctx.contextBlocks.map((block, i) => {
    const kps = Array.isArray(block.keyPoints) ? block.keyPoints : [];
    const text = [
      block.title,
      (block.usefulForQuestionsAbout || []).join('. '),
      block.richContext || block.promptText,
      kps.map((k) => `${k && k.point || ''} ${k && k.evidence || ''}`).join('. '),
    ].filter(Boolean).join('\n').replace(/\s+/g, ' ').trim().slice(0, CHUNK_TEXT_CAP);
    return {
      id: `ask:${block.id || block.url || i}`,
      sourceType: 'ask-context',
      sourceId: block.id || block.url || String(i),
      title: block.title || '',
      url: block.url || '',
      category: '',
      text,
      metadata: { block }, // full block so synthesis reuses keyPoints unchanged
    };
  }).filter((c) => c.text);
}

async function _catalogChunks() {
  let catalog;
  try { catalog = await loadResourceCatalog({}); } catch { return []; }
  if (!Array.isArray(catalog)) return [];
  return catalog.filter((entry) => !isImageCatalogEntry(entry)).map((entry, i) => {
    const ev = toEvidence(entry, 0);
    const { content, source } = loadEntryContent(entry);
    const text = [ev.title, ev.description, content]
      .filter(Boolean).join('\n').replace(/\s+/g, ' ').trim().slice(0, CHUNK_TEXT_CAP);
    return {
      id: `cat:${ev.id || i}`,
      sourceType: 'catalog',
      sourceId: ev.id || String(i),
      title: ev.title || '',
      url: ev.url || '',
      category: ev.category || '',
      text,
      metadata: {
        evidence: {
          ...ev,
          evidence: content || ev.description || ev.title,
          contentLoaded: Boolean(content),
          contentSource: source,
        },
      },
    };
  }).filter((c) => c.text);
}

// ── Index build / load / cache ──────────────────────────────────────────────────
function _indexPath(domain) { return path.join(INDEX_DIR(), domain, 'semantic-index.json'); }

function _currentHashes(domain) {
  return {
    askContext: _fileHash(askContextPath(domain)),
    catalog: _fileHash(_catalogPath()),
  };
}

function _hashesMatch(a, b) {
  return a && b && a.askContext === b.askContext && a.catalog === b.catalog;
}

async function buildIndex(domain = targetDomain()) {
  const chunks = [...(_askContextChunks(domain)), ...(await _catalogChunks())];
  if (chunks.length === 0) throw new Error('no chunks to index');
  // A refreshed site can contain hundreds of chunks. Bound the model batch so
  // rebuilding the index does not exhaust Ollama's context/memory budget.
  const vectors = [];
  for (let offset = 0; offset < chunks.length; offset += 16) {
    vectors.push(...await embed(chunks.slice(offset, offset + 16).map(chunk => chunk.text)));
  }
  const stored = chunks.map((c, i) => ({
    id: c.id, sourceType: c.sourceType, sourceId: c.sourceId, title: c.title,
    url: c.url, category: c.category, textPreview: c.text.slice(0, 200),
    metadata: c.metadata, embedding: vectors[i],
  }));
  const index = {
    meta: {
      domain, model: EMBED_MODEL(), builtAt: new Date().toISOString(),
      sourceHashes: _currentHashes(domain),
      schemaVersion: INDEX_SCHEMA_VERSION,
    },
    chunks: stored,
  };
  const file = _indexPath(domain);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(index));
  return index;
}

// In-process cache to avoid re-reading the JSON each request.
let _mem = null; // { domain, index }

/** Load a fresh, valid index (reuse cache if source files + model unchanged, else rebuild). */
async function ensureIndex(domain = targetDomain()) {
  const want = _currentHashes(domain);
  const model = EMBED_MODEL();
  if (_mem && _mem.domain === domain && _mem.index.meta.model === model
      && _mem.index.meta.schemaVersion === INDEX_SCHEMA_VERSION
      && _hashesMatch(_mem.index.meta.sourceHashes, want)) {
    return { index: _mem.index, built: false };
  }
  const file = _indexPath(domain);
  if (fs.existsSync(file)) {
    try {
      const disk = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (disk.meta && disk.meta.model === model && _hashesMatch(disk.meta.sourceHashes, want)) {
        if (disk.meta.schemaVersion !== INDEX_SCHEMA_VERSION) throw new Error('stale semantic index schema');
        _mem = { domain, index: disk };
        return { index: disk, built: false };
      }
    } catch { /* corrupt cache → rebuild */ }
  }
  const index = await buildIndex(domain);
  _mem = { domain, index };
  return { index, built: true };
}

// ── Cosine search ────────────────────────────────────────────────────────────────
function _cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Retrieve top-K semantically similar chunks for a question.
 * @returns {{ok, chunks, indexLoaded, indexBuilt, chunkCount, model, indexPath, failedReason}}
 * Never throws — ok:false signals the caller to fall back to keyword retrieval.
 */
async function retrieve(question, { domain = targetDomain(), topK, minScore, queryEmbedding = null } = {}) {
  const k = topK || parseInt(process.env.ASK_SEMANTIC_TOP_K || '6', 10);
  const floor = minScore != null ? minScore : parseFloat(process.env.ASK_SEMANTIC_MIN_SCORE || '0.45');
  const result = {
    ok: false, chunks: [], indexLoaded: false, indexBuilt: false, chunkCount: 0,
    model: EMBED_MODEL(), indexPath: _indexPath(domain), failedReason: '',
    reusedEmbedding: false,
  };
  let index;
  try {
    const r = await ensureIndex(domain);
    index = r.index; result.indexBuilt = r.built; result.indexLoaded = true;
    result.chunkCount = index.chunks.length;
  } catch (e) {
    result.failedReason = `index_build_failed: ${e.message}`;
    return result;
  }
  // Reuse a precomputed query embedding (from requestPreparation) when available.
  let qvec = Array.isArray(queryEmbedding) && queryEmbedding.length ? queryEmbedding : null;
  if (qvec) {
    result.reusedEmbedding = true;
  } else {
    try { [qvec] = await embed(question); }
    catch (e) { result.failedReason = /timeout/i.test(e.message) ? 'embed_timeout' : 'embed_failed'; return result; }
  }

  const scored = index.chunks
    .map((c) => ({ chunk: c, score: _cosine(qvec, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .filter((s) => s.score >= floor)
    .slice(0, k);

  result.ok = true;
  result.chunks = scored.map(({ chunk, score }) => ({
    id: chunk.id, sourceType: chunk.sourceType, sourceId: chunk.sourceId,
    title: chunk.title, url: chunk.url, category: chunk.category,
    score: Number(score.toFixed(4)), metadata: chunk.metadata,
  }));
  return result;
}

// ASK semantic search with an explicit prepared-embedding contract (Part 3).
// Reuses `retrieve`; passes the precomputed queryEmbedding straight through so Ollama
// is not called again. queryEmbedding null → retrieve reports embed failure → caller falls back.
async function semanticSearchAsk({
  domain = targetDomain(), originalQuestion = '', normalizedQuestion = '',
  queryEmbedding = null, topK, minScore,
} = {}) {
  return retrieve(originalQuestion || normalizedQuestion, { domain, topK, minScore, queryEmbedding });
}

module.exports = {
  retrieve, semanticSearchAsk, buildIndex, ensureIndex, embed, isEmbedModelAvailable,
  cosine: _cosine, semanticIndexBaseDir: () => INDEX_DIR(),
};
