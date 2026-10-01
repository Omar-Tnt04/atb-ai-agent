'use strict';

/**
 * site-index-clean.js
 *
 * Pure, in-memory deduplication of a raw crawl result into the agent-ready
 * index shape. No file I/O — callers (build-site-index.js, clean-site-index.js)
 * own reading/writing.
 *
 * Input:  { meta, pages, failedUrls, urlsDiscovered }
 *   pages[] carry documentLinks/documentActions/forms per page (the shape
 *   extractPageData() in build-site-index.js produces).
 *
 * Output: { meta, rawStats, cleanStats, pages, uniqueDocuments,
 *           uniqueDocumentActions, uniqueForms, uniqueBusinessForms, failedUrls }
 */

const MAX_SOURCE_PAGES = 10;

// Generic document-action labels that carry no real information on their own.
const LOW_VALUE_ACTION_TEXTS = [
  'documents utiles',
  'وثائق مفيدة',
];

// Forms whose only field is one of these are technical/site-wide widgets, not
// real business forms (e.g. the header search box, a TMM rate calculator input).
const TECHNICAL_ONLY_FIELDS = ['search', 'tmmvalue'];

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const normText = (s) => clean(s).toLowerCase();

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

function bumpEntry(map, key, makeEntry, sourceUrl) {
  let entry = map.get(key);
  if (!entry) {
    entry = { ...makeEntry(), occurrencesCount: 0, sourcePages: [] };
    map.set(key, entry);
  }
  entry.occurrencesCount++;
  if (entry.sourcePages.length < MAX_SOURCE_PAGES && !entry.sourcePages.includes(sourceUrl)) {
    entry.sourcePages.push(sourceUrl);
  }
  return entry;
}

function isTechnicalForm(fields) {
  return fields.length === 1 && TECHNICAL_ONLY_FIELDS.includes(fields[0].toLowerCase());
}

/**
 * @param {{meta?: object, pages: Array, failedUrls?: Array, urlsDiscovered?: number}} raw
 * @returns {object} the final agent-ready index
 */
function deduplicatePages(pages) {
 const byUrl = new Map();
 // Keep the richest observed record; never synthesize page content.
 const score = p => String(p.textPreview || '').length + String(p.title || '').length + JSON.stringify(p.headings || []).length;
 for (const page of pages) {
  const previous = byUrl.get(page.url);
  if (!previous || score(page) > score(previous)) byUrl.set(page.url, page);
 }
 return [...byUrl.values()];
}

function cleanSiteIndex(raw) {
  const documentsMap = new Map(); // key: documentUrl
  const actionsMap = new Map(); // key: normalized linkText
  const formsMap = new Map(); // key: action|method|sorted unique fields

  let documentOccurrencesFound = 0;
  let documentActionOccurrencesFound = 0;
  let formOccurrencesFound = 0;

  const pages = [];

  for (const page of raw.pages || []) {
    const sourceUrl = page.url;

    pages.push({
      url: page.url,
      path: pathOf(page.url),
      title: page.title,
      description: page.description,
      headings: page.headings,
      textPreview: page.textPreview,
    });

    // Direct document links — dedupe by documentUrl.
    for (const doc of page.documentLinks || []) {
      if (!doc.documentUrl) continue;
      documentOccurrencesFound++;
      bumpEntry(
        documentsMap,
        doc.documentUrl,
        () => ({
          documentUrl: doc.documentUrl,
          filename: doc.filename || '',
          linkText: clean(doc.linkText),
        }),
        sourceUrl,
      );
    }

    // Click-only document actions — dedupe by normalized linkText.
    for (const action of page.documentActions || []) {
      const text = clean(action.linkText);
      if (!text) continue;
      documentActionOccurrencesFound++;

      const normalized = normText(text);
      if (LOW_VALUE_ACTION_TEXTS.includes(normalized)) continue; // generic label — drop entirely

      bumpEntry(actionsMap, normalized, () => ({ linkText: text }), sourceUrl);
    }

    // Forms — dedupe by action + method + sorted unique fields.
    for (const form of page.forms || []) {
      formOccurrencesFound++;
      const fields = Array.from(new Set((form.fields || []).map((f) => clean(f)))).sort();
      const method = (form.method || 'get').toLowerCase();
      const key = `${form.action || ''}|${method}|${fields.join(',')}`;

      bumpEntry(formsMap, key, () => ({ action: form.action || '', method, fields }), sourceUrl);
    }
  }

  const uniquePages = deduplicatePages(pages);
  const uniqueDocuments = Array.from(documentsMap.values());
  const uniqueDocumentActions = Array.from(actionsMap.values());
  const uniqueForms = Array.from(formsMap.values());
  const uniqueBusinessForms = uniqueForms.filter((f) => !isTechnicalForm(f.fields));

  const failedUrls = raw.failedUrls || [];
  const urlsDiscovered = raw.urlsDiscovered != null ? raw.urlsDiscovered : pages.length;

  return {
    meta: raw.meta || {},
    // rawStats keeps the original crawler field names (documentsFound,
    // documentActionsFound, ...) — same occurrence counts as cleanStats'
    // *OccurrencesFound fields, named for backward compatibility.
    rawStats: {
      pagesCrawled: pages.length,
      urlsDiscovered,
      documentsFound: documentOccurrencesFound,
      documentActionsFound: documentActionOccurrencesFound,
      formsFound: formOccurrencesFound,
      failedPages: failedUrls.length,
    },
    cleanStats: {
      pagesCrawled: uniquePages.length,
      urlsDiscovered,
      documentOccurrencesFound,
      uniqueDocumentsFound: uniqueDocuments.length,
      documentActionOccurrencesFound,
      uniqueDocumentActionsFound: uniqueDocumentActions.length,
      formOccurrencesFound,
      uniqueFormsFound: uniqueForms.length,
      uniqueBusinessFormsFound: uniqueBusinessForms.length,
      failedPages: failedUrls.length,
    },
    pages: uniquePages,
    uniqueDocuments,
    uniqueDocumentActions,
    uniqueForms,
    uniqueBusinessForms,
    failedUrls,
  };
}

module.exports = { cleanSiteIndex, deduplicatePages };
