'use strict';

/**
 * siteIndexAdapter.service.js
 *
 * scripts/clean-site-index.js writes a deduplicated index shape:
 *   meta, rawStats, cleanStats, pages, uniqueDocuments, uniqueDocumentActions,
 *   uniqueForms, uniqueBusinessForms, failedUrls
 *
 * Existing readers (siteIndex.service.js, siteIndexAgent.service.js) were built
 * against the raw crawler shape: top-level resources[]/documentOccurrences[],
 * and page.documentLinks/page.documentActions/page.forms per page.
 *
 * adaptSiteIndex() detects the clean shape and reconstructs the raw shape from
 * it (documents/actions/forms reattached to every page listed in sourcePages),
 * so downstream scoring code needs no changes. Raw/enriched indexes pass through
 * untouched. getPages/getDocuments/getDocumentActions/getForms are direct
 * accessors for callers that just want the deduplicated lists.
 */

const crypto = require('crypto');

function isCleanFormat(raw) {
  return !!raw && typeof raw === 'object' && Array.isArray(raw.uniqueDocuments);
}

function _hash(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 10);
}

function _pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

function _extOf(name) {
  const m = String(name || '').match(/\.([a-z0-9]{1,5})(?:\?|#|$)/i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Reconstruct the raw crawler shape (resources[]/documentOccurrences[] +
 * per-page documentLinks/documentActions/forms) from a clean index, so
 * existing scoring code (siteIndex.service.js, siteIndexAgent.service.js)
 * keeps working unmodified. Non-clean indexes are returned as-is.
 */
function adaptSiteIndex(raw) {
  if (!isCleanFormat(raw)) return raw;

  const pages = Array.isArray(raw.pages) ? raw.pages : [];
  const documents = raw.uniqueDocuments || [];
  const documentActions = raw.uniqueDocumentActions || [];
  const businessForms = raw.uniqueBusinessForms || [];

  const pageTitleByUrl = new Map(pages.map((p) => [p.url, p.title || '']));

  const resources = [];
  const documentOccurrences = [];
  const documentLinksByPage = new Map();
  const documentActionsByPage = new Map();
  const formsByPage = new Map();

  for (const page of pages) {
    resources.push({
      type: 'page',
      id: `pg_${_hash(page.url)}`,
      title: page.title || '',
      description: page.description || '',
      url: page.url,
      path: page.path || _pathOf(page.url),
      headings: page.headings || [],
      textPreview: page.textPreview || '',
    });
  }

  for (const doc of documents) {
    const sourcePages = Array.isArray(doc.sourcePages) ? doc.sourcePages : [];
    resources.push({
      type: 'document',
      id: `doc_${_hash(doc.documentUrl)}`,
      url: doc.documentUrl || '',
      path: _pathOf(doc.documentUrl),
      title: doc.linkText || doc.filename || '',
      filename: doc.filename || '',
      fileType: _extOf(doc.filename || doc.documentUrl),
      description: '',
      sourcePages: sourcePages.map((url) => ({
        url,
        path: _pathOf(url),
        title: pageTitleByUrl.get(url) || '',
        linkText: doc.linkText || '',
      })),
    });

    for (const url of sourcePages) {
      documentOccurrences.push({
        sourcePageUrl: url,
        linkText: doc.linkText || '',
        documentUrl: doc.documentUrl || '',
        executionType: 'direct_document_url',
      });
      const arr = documentLinksByPage.get(url) || [];
      arr.push({ linkText: doc.linkText || '', documentUrl: doc.documentUrl || '', filename: doc.filename || '' });
      documentLinksByPage.set(url, arr);
    }
  }

  for (const action of documentActions) {
    const sourcePages = Array.isArray(action.sourcePages) ? action.sourcePages : [];
    resources.push({
      type: 'document',
      id: `act_${_hash(action.linkText)}`,
      url: '',
      title: action.linkText || '',
      filename: '',
      fileType: 'action',
      description: '',
      sourcePages: sourcePages.map((url) => ({
        url,
        path: _pathOf(url),
        title: pageTitleByUrl.get(url) || '',
        linkText: action.linkText || '',
      })),
    });

    for (const url of sourcePages) {
      documentOccurrences.push({
        sourcePageUrl: url,
        linkText: action.linkText || '',
        documentUrl: null,
        executionType: 'click_visible_document_button',
      });
      const arr = documentActionsByPage.get(url) || [];
      arr.push({ linkText: action.linkText || '', documentUrl: null });
      documentActionsByPage.set(url, arr);
    }
  }

  for (const form of businessForms) {
    const sourcePages = Array.isArray(form.sourcePages) ? form.sourcePages : [];
    for (const url of sourcePages) {
      const arr = formsByPage.get(url) || [];
      arr.push({ action: form.action || '', method: form.method || 'get', fields: form.fields || [] });
      formsByPage.set(url, arr);
    }
  }

  const adaptedPages = pages.map((page) => ({
    ...page,
    documentLinks: documentLinksByPage.get(page.url) || [],
    documentActions: documentActionsByPage.get(page.url) || [],
    forms: formsByPage.get(page.url) || [],
  }));

  return {
    ...raw,
    pages: adaptedPages,
    resources,
    documentOccurrences,
    // rawStats keeps the original field names (documentsFound, documentActionsFound,
    // pagesCrawled, ...) that existing consumers (e.g. widgetDemo.routes.js) read;
    // cleanStats uses different names (uniqueDocumentsFound, ...) so it's last resort.
    stats: raw.stats || raw.rawStats || raw.cleanStats || {},
  };
}

// ── Direct accessors ─────────────────────────────────────────────────────────
// Clean format reads straight from the deduplicated arrays; raw/enriched format
// falls back to resources[]/documentOccurrences[]/page.* so callers don't need
// to know which schema they were handed.

function getPages(index) {
  return (index && Array.isArray(index.pages)) ? index.pages : [];
}

function getDocuments(index) {
  if (!index) return [];
  if (Array.isArray(index.uniqueDocuments)) return index.uniqueDocuments;

  if (Array.isArray(index.documentOccurrences)) {
    return index.documentOccurrences
      .filter((o) => o.executionType === 'direct_document_url' && o.documentUrl)
      .map((o) => ({ documentUrl: o.documentUrl, linkText: o.linkText || '', sourcePages: [o.sourcePageUrl] }));
  }

  const out = [];
  for (const page of getPages(index)) {
    for (const d of (page.documentLinks || [])) {
      out.push({ documentUrl: d.documentUrl, filename: d.filename || '', linkText: d.linkText || '', sourcePages: [page.url] });
    }
  }
  return out;
}

function getDocumentActions(index) {
  if (!index) return [];
  if (Array.isArray(index.uniqueDocumentActions)) return index.uniqueDocumentActions;

  if (Array.isArray(index.documentOccurrences)) {
    return index.documentOccurrences
      .filter((o) => o.executionType === 'click_visible_document_button')
      .map((o) => ({ linkText: o.linkText || '', sourcePages: [o.sourcePageUrl] }));
  }

  const out = [];
  for (const page of getPages(index)) {
    for (const a of (page.documentActions || [])) {
      out.push({ linkText: a.linkText || '', sourcePages: [page.url] });
    }
  }
  return out;
}

function getForms(index) {
  if (!index) return [];
  if (Array.isArray(index.uniqueBusinessForms)) return index.uniqueBusinessForms;

  const out = [];
  for (const page of getPages(index)) {
    for (const f of (page.forms || [])) {
      out.push({ action: f.action || '', method: f.method || 'get', fields: f.fields || [], sourcePages: [page.url] });
    }
  }
  return out;
}

module.exports = {
  isCleanFormat,
  adaptSiteIndex,
  getPages,
  getDocuments,
  getDocumentActions,
  getForms,
};
