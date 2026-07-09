'use strict';
/**
 * ASK-MODE CATALOG RETRIEVAL — Laragon catalog.json (structured business data)
 * ------------------------------------------------------------------------------
 * Second ask-mode knowledge source, kept SEPARATE from ask-context.json.
 *
 * Reuses the existing configurable loader/cache in resourceCatalog.service.js
 * (env.resourceCatalogPath, default C:/laragon/www/atb-general-resources/catalog.json)
 * so there is one catalog path/config. On top of it, this adds a lightweight
 * ask-oriented keyword scorer that returns the TOP-K relevant catalog entries as
 * evidence (source = "catalog.json") — unlike resourceCatalog's act-mode selector
 * which is margin-gated to pick a single resource to act on.
 *
 * Domain-generic: nothing here is hardcoded to a specific site; the path comes
 * from env, the fields come from whatever the catalog provides.
 *
 * If Laragon/catalog.json is unavailable, retrieval returns [] (ask mode then
 * falls back to ask-context.json / the rest of the pipeline) — never throws.
 */

const fs = require('fs');
const path = require('path');
const env = require('../config/env');
const { loadResourceCatalog } = require('./resourceCatalog.service');
const { tokenize, stemMatch } = require('./askContext.service');

// Physical root that the catalog's file folders (txt/json/documents/images) sit under.
const CATALOG_ROOT = path.dirname(path.resolve(env.resourceCatalogPath));
const CONTENT_CAP = 1200; // per-entry evidence cap (chars) — Fix 1/Fix 5.

/**
 * Load the linked resource file's real content as evidence (not the meta-description).
 * Prefers a readable text sibling (.txt/.md, else .json); skips pdf/image (binary).
 * File path parts come from the catalog, already validated by withCatalogFileUrl.
 * Never throws — missing file / Laragon offline → { content:null }.
 */
function loadEntryContent(entry, cap = CONTENT_CAP) {
  const files = (entry && entry.metadata && entry.metadata.files) || [];
  const pick =
    files.find((f) => /\.(txt|md)$/i.test(f.fileName || '')) ||
    files.find((f) => /\.json$/i.test(f.fileName || ''));
  if (!pick || !pick.folder || !pick.fileName) return { content: null, source: null };
  try {
    let raw = fs.readFileSync(path.join(CATALOG_ROOT, pick.folder, pick.fileName), 'utf8');
    if (/\.json$/i.test(pick.fileName)) {
      try { raw = JSON.stringify(JSON.parse(raw)); } catch { /* keep raw text */ }
    }
    raw = raw.replace(/\s+/g, ' ').trim();
    if (!raw) return { content: null, source: null };
    return { content: raw.slice(0, cap), source: pick.fileName };
  } catch {
    return { content: null, source: null }; // ponytail: 4 small reads/query, no cache until it matters
  }
}

// Field weights: which catalog fields are the strongest relevance signal.
const FIELD_WEIGHTS = {
  title: 0.35,
  category: 0.30,
  exampleQueries: 0.30,
  description: 0.15,
  id: 0.10,
};

/** Pull the searchable text of a catalog entry per field (from its normalized metadata). */
function entryFieldTokens(entry) {
  const m = (entry && entry.metadata) || {};
  const exampleQueries = Array.isArray(m.exampleQueries) ? m.exampleQueries.join(' ') : '';
  return {
    title: tokenize(m.title),
    category: tokenize(m.category || m.resourceType || m.type),
    exampleQueries: tokenize(exampleQueries),
    description: tokenize(m.description),
    id: tokenize(m.resourceId || m.id),
  };
}

function isImageCatalogEntry(entry) {
  const m = (entry && entry.metadata) || {};
  const files = Array.isArray(m.files) ? m.files : [];
  return (
    String(m.resourceFileType || '').toLowerCase() === 'image' ||
    files.some((file) =>
      String(file.fileType || '').toLowerCase() === 'image' ||
      String(file.mimeType || '').toLowerCase().startsWith('image/') ||
      /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(String(file.fileName || ''))
    )
  );
}

/** Normalize an entry into the flat evidence shape used by the combined answer builder. */
function toEvidence(entry, score) {
  const m = (entry && entry.metadata) || {};
  return {
    source: 'catalog.json',
    score,
    id: m.resourceId || m.id || null,
    title: m.title || null,
    category: m.category || m.resourceType || m.type || null,
    resourceFileType: m.resourceFileType || null,
    description: m.description || null,
    url: entry.url || null,
    // Evidence text = the catalog's own description (the answerer copies this verbatim).
    evidence: m.description || m.title || null,
  };
}

/**
 * Retrieve the top relevant catalog entries for a question.
 * Returns [{ source:'catalog.json', score, id, title, category, description, url, evidence }].
 * Never throws — returns [] when the catalog is unavailable or nothing matches.
 */
async function retrieveCatalogEntries(question, { topK = 4, minScore = 0.18, catalog: override = null } = {}) {
  let catalog;
  try {
    // `override` (tests) is passed straight to the existing loader; runtime loads from env path.
    catalog = await loadResourceCatalog(override ? { catalog: override } : {});
  } catch {
    return []; // Laragon/catalog.json offline → no catalog evidence this turn.
  }
  if (!Array.isArray(catalog) || catalog.length === 0) return [];

  const qTokens = tokenize(question);
  if (qTokens.length === 0) return [];

  const scored = [];
  for (const entry of catalog) {
    // Image resources must stay on the OCR/vision path. ASK text synthesis should
    // never answer image content questions from thin catalog metadata.
    if (isImageCatalogEntry(entry)) continue;
    const fields = entryFieldTokens(entry);
    let raw = 0;
    let matched = 0;
    for (const qt of qTokens) {
      let best = 0;
      for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
        const toks = fields[field] || [];
        if (toks.some((t) => stemMatch(qt, t)) && weight > best) best = weight;
      }
      if (best > 0) { raw += best; matched++; }
    }
    if (matched === 0) continue;
    const score = raw / qTokens.length + matched * 0.02;
    if (score >= minScore) scored.push({ entry, evidence: toEvidence(entry, score) });
  }
  scored.sort((a, b) => b.evidence.score - a.evidence.score);

  // Enrich only the top-K with real file content (avoids reading 41 files/query).
  return scored.slice(0, topK).map(({ entry, evidence }) => {
    const { content, source } = loadEntryContent(entry);
    return {
      ...evidence,
      // Real resource content is the evidence when available; description is the fallback.
      evidence: content || evidence.description || evidence.title,
      contentLoaded: Boolean(content),
      contentSource: source,
    };
  });
}

module.exports = { retrieveCatalogEntries, toEvidence, loadEntryContent, isImageCatalogEntry };
