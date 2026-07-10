'use strict';
/**
 * siteIndexAgent.service.js — simplified two-resource-type navigator.
 *
 * Only two resource types: pages and documents.
 *   contact page, agencies, simulator, rates  →  page  →  navigate
 *   PDF form, guide, tariff, request, file    →  document  →  download | navigate_then_download
 *
 * Pipeline:
 *   user message
 *     → Gemma: { action, requestDescription }
 *     → score pagesIndex or documentsIndex
 *     → build shortlist of up to 8 candidates
 *     → Gemma: { selectedCandidateNumber, reason } (fallback: deterministic top)
 *     → backend validates selected candidate URL
 *     → pageNavigator executes visible action
 *
 * Index source priority:
 *   1. siteIndex.resources (enriched, produced by enrich-site-index.js) — preferred
 *   2. siteIndex.agentIndex (raw crawl) — fallback when resources absent
 *
 * Scoring (resources path — preferred):
 *   requestDescription is tokenized and matched against resource.title + resource.description only.
 *   Pages:     titleToks (weight 0.40) + descToks (weight 0.52)
 *   Documents: titleToks (weight 0.40) + descToks (weight 0.52)
 *   Fields built into r.f but NOT used for scoring: pathToks, searchToks, linkToks,
 *   fileToks, sourcePageToks — retained in the index record for potential future use.
 *
 * Backend validates the final URL belongs to the indexed domain before returning.
 */

const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const crypto = require('crypto');
const { adaptSiteIndex } = require('./siteIndexAdapter.service');

function _shortHash(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 10);
}
function _pathOf(u) {
  try { return new URL(u).pathname; }
  catch { return String(u || '').replace(/^https?:\/\/[^/]+/, ''); }
}
function _extOf(name) {
  const m = String(name || '').match(/\.([a-z0-9]{1,5})(?:\?|#|$)/i);
  return m ? m[1].toLowerCase() : '';
}

// ── Index location ──────────────────────────────────────────────────────────
const SITE_CONTEXT_DIR = path.resolve(__dirname, '..', '..', '..', 'site-context');

function _domain() {
  try {
    return new URL(process.env.TARGET_URL || 'https://atb.tn').hostname.replace(/^www\./, '');
  } catch {
    return 'atb.tn';
  }
}

function _indexPath() {
  return path.join(SITE_CONTEXT_DIR, _domain(), 'site-index.json');
}

// ── Text normalization ────────────────────────────────────────────────────────
function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set([
  'the', 'and', 'for', 'are', 'this', 'that', 'with', 'from', 'what', 'how',
  'you', 'your', 'can', 'will', 'les', 'des', 'pour', 'dans', 'sur', 'une',
  'que', 'qui', 'par', 'moi', 'open', 'find', 'show', 'get', 'got', 'fetch',
  'page', 'site', 'website', 'please', 'want', 'need', 'give', 'see', 'view',
  'navigate', 'download', 'goto', 'visit', 'access', 'display', 'look',
  'le', 'la', 'de', 'du', 'un', 'en', 'et', 'au', 'aux', 'ce', 'ces', 'cet',
  'cette', 'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles', 'toi',
  'lui', 'eux', 'mon', 'ma', 'mes', 'ton', 'ta', 'tes', 'son', 'sa', 'ses',
  'notre', 'votre', 'leur', 'leurs', 'se', 'son', 'soi',
  'ouvre', 'ouvrir', 'va', 'aller', 'acceder', 'accede', 'trouve', 'trouver',
  'montre', 'montrer', 'telecharge', 'telecharger', 'voir', 'consulter',
  'afficher', 'ignore', 'ignorer',
  'document', 'documents', 'fichier', 'fichiers', 'officiel', 'officiels',
  'necessaire', 'necessaires', 'correspondant', 'correspondante', 'adapte', 'adaptee',
  'banque', 'bancaire', 'bancaires',
  'ouverture', 'ouvrir', 'avant', 'autre', 'autres', 'personne', 'personnes',
  'connecter', 'connexion', 'recuperer', 'obtenir', 'preparer', 'gerer', 'utiliser',
  'cherche', 'chercher', 'veux', 'voulez', 'depart', 'lie', 'correspondant',
  'depuis', 'sans', 'avec', 'mais', 'pas', 'non', 'aussi', 'alors',
  'detaille', 'detailles', 'detaillee', 'detaillees',
  'applique', 'appliques', 'appliquee', 'appliquees',
  'connaitre', 'savoir', 'combien', 'courante', 'courantes',
  'client', 'clients', 'devenir',
]);

function tokenize(text) {
  return normalize(text)
    .split(/[^a-z0-9؀-ۿ]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

function segTokens(text) {
  return normalize(text)
    .split(/[^a-z0-9؀-ۿ]+/)
    .filter((t) => t.length >= 3);
}

function filenameOf(url) {
  try { return new URL(url).pathname.split('/').pop() || ''; }
  catch { return String(url || '').split('/').pop().split('?')[0]; }
}

// ── Generic multilingual synonym groups ──────────────────────────────────────
const SYNONYMS = [
  ['contact', 'contacter', 'joindre'],
  ['card', 'carte', 'cartes'],
  ['request', 'demande', 'demander'],
  ['form', 'formulaire', 'formulaires'],
  ['subscription', 'abonnement', 'souscription', 'inscription'],
  ['credit', 'pret', 'financement', 'prets', 'loan'],
  ['simulator', 'simulateur', 'simulation', 'simulate'],
  ['agency', 'agencies', 'agence', 'agences', 'branch', 'reseau'],
  ['rates', 'rate', 'taux', 'change', 'exchange', 'devise', 'devises', 'currency'],
  ['tariff', 'tarif', 'tarifs', 'tarification', 'tarifications', 'frais', 'cout', 'couts', 'prix', 'fees'],
  ['transfer', 'transfert', 'virement'],
  ['account', 'compte', 'comptes'],
  ['complaint', 'reclamation', 'plainte'],
  ['notification', 'notifications', 'alerte', 'alertes', 'sms', 'messenger', 'mouvement', 'mouvements', 'atbmessenger'],
  ['mobile', 'telephone', 'mobilink', 'portable', 'gsm', 'mobilebanking'],
  ['internet', 'online', 'ligne', 'ebanking', 'atbnet', 'atbmobile', 'distance'],
  ['abroad', 'etranger', 'diaspora', 'allocation', 'touristique', 'restitution'],
  ['location', 'localisation'],
  ['joint', 'conjoint', 'cotitulaire', 'coassociation'],
];

const _synLookup = new Map();
for (const group of SYNONYMS) {
  const norm = group.map(normalize);
  for (const term of norm) if (!_synLookup.has(term)) _synLookup.set(term, norm);
}

function toConcepts(terms) {
  const seen = new Set();
  const out = [];
  for (const raw of terms) {
    const parts = String(raw || '').includes(' ') ? tokenize(raw) : [String(raw || '').trim()];
    for (const part of parts) {
      const t = normalize(part);
      if (!t || STOP.has(t) || t.length < 2) continue;
      const group = _synLookup.get(t) || [t];
      const key = group[0];
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(group);
    }
  }
  return out;
}

function _stem(a, b) {
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  if (min < 6) return false;
  return a.startsWith(b.slice(0, min)) || b.startsWith(a.slice(0, min));
}

function _matchTok(v, t) {
  if (v === t) return true;
  if (v.length >= 5 && t.includes(v)) return true;
  // Require 6+ chars for "token inside synonym" to avoid short common words
  // (e.g. "donne") accidentally matching inside unrelated synonyms ("coordonnees").
  if (t.length >= 6 && v.includes(t)) return true;
  return _stem(v, t);
}

function _conceptHits(group, toks) {
  for (const v of group) for (const t of toks) if (_matchTok(v, t)) return true;
  return false;
}

function _scoreRecord(concepts, fields) {
  let score = 0;
  let hits = 0;
  for (const c of concepts) {
    let best = 0;
    for (const { toks, weight } of fields) {
      if (weight > best && _conceptHits(c, toks)) best = weight;
    }
    if (best > 0) { score += best; hits += 1; }
  }
  return { score, hits };
}

// ── Load + cache ──────────────────────────────────────────────────────────────
let _cache = null;

function loadSiteIndex() {
  const file = _indexPath();
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { _cache = null; return null; }
  if (_cache && _cache.mtime === mtime) return _cache;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch { _cache = null; return null; }
  // Clean-index shape (scripts/clean-site-index.js) → reconstruct resources[]/
  // documentOccurrences[] so buildIndexes() below (occurrences schema) applies unchanged.
  raw = adaptSiteIndex(raw);
  // Accept any of the supported shapes: new occurrences schema (resources +
  // documentOccurrences), enriched resources, or legacy agentIndex.
  if (!raw || (!Array.isArray(raw.resources) && !Array.isArray(raw.agentIndex))) {
    _cache = null;
    return null;
  }

  const indexes = buildIndexes(raw);
  _cache = { mtime, raw, indexes };

  // One-line load summary so the active schema + counts are visible in logs.
  console.log(
    `[SITE_INDEX] schema=${indexes.schema} status=${raw.meta?.status || 'n/a'} ` +
    `pages=${indexes.pagesIndex?.length || 0} ` +
    `documents=${indexes.documentsIndex?.length || 0} ` +
    `occurrences=${indexes.occurrencesIndex?.length || 0} ` +
    `failedUrls=${Array.isArray(raw.failedUrls) ? raw.failedUrls.length : 'n/a'}`,
  );

  return _cache;
}

function clearCache() { _cache = null; }

// ── Build search indexes ──────────────────────────────────────────────────────

function buildIndexes(raw) {
  const resources = Array.isArray(raw.resources) ? raw.resources : [];

  // New simplified schema (build-site-index.js): page resources +
  // document_occurrence resources, plus a top-level documentOccurrences array.
  const isOccurrenceSchema =
    resources.some((r) => r.type === 'document_occurrence') ||
    (Array.isArray(raw.documentOccurrences) && !resources.some((r) => r.type === 'document'));
  if (resources.length > 0 && isOccurrenceSchema) {
    return _buildFromOccurrences(raw);
  }

  // Enriched resources schema (enrich-site-index.js): page + document resources
  // with sourcePages[].
  if (resources.length > 0) {
    return _buildFromResources(raw);
  }

  return _buildFromAgentIndex(raw);
}

// ── New occurrences schema (build-site-index.js) ──────────────────────────────
// resources[] = { type:'page', ... } and { type:'document_occurrence', ... }.
// Pages are scored on title + path + headings (descriptions are usually empty).
// Each document_occurrence is already a (document, sourcePage) pair, so it maps
// 1:1 to an occurrence record. Documents are deduplicated by documentUrl.
function _buildFromOccurrences(raw) {
  const resources = raw.resources || [];

  const pagesIndex       = [];
  const occurrencesIndex = [];
  const docMap           = new Map();  // documentUrl → documentsIndex record
  const pageDescMap      = new Map();  // page url → description|headings text
  const pageUrlSet       = new Set();
  const docUrlSet        = new Set();

  // ── Pages ──────────────────────────────────────────────────────────────────
  for (const r of resources) {
    if (r.type !== 'page') continue;
    const url      = r.url || '';
    const pth      = r.path || _pathOf(url);
    const headText = (r.headings || []).map((h) => h.text || '').join(' ');
    pageUrlSet.add(url);
    // Descriptions are usually empty in this schema; fall back to headings so
    // occurrences can still cross-reference a meaningful source-page description.
    pageDescMap.set(url, r.description || headText || '');

    pagesIndex.push({
      type:        'page',
      id:          r.id || `pg_${_shortHash(url)}`,
      url,
      path:        pth,
      title:       r.title || '',
      description: r.description || '',
      f: {
        // Path segments are folded into BOTH scored fields so the discriminating
        // URL word (devise, agences, contacter, simulateur …) always scores at the
        // top weight — titles in this schema are generic ("Arab Tunisian Bank"),
        // and a mere heading mention (descToks, 0.52) must not outrank the page
        // whose path IS the subject. When scores tie, _search's depth tiebreaker
        // then picks the canonical shallow path (/devise over /entreprises/devise).
        titleToks:  [...tokenize(r.title || ''), ...segTokens(pth)],
        pathToks:   segTokens(pth),
        // Headings + path segments (never the full textPreview — its shared
        // nav/footer boilerplate would match every page).
        descToks:   [...tokenize(headText), ...segTokens(pth)],
        searchToks: tokenize(r.textPreview || ''),  // retained, not scored here
        linkToks:   [],
      },
    });
  }

  // ── Document occurrences ─────────────────────────────────────────────────────
  for (const r of resources) {
    if (r.type !== 'document_occurrence') continue;

    const isClick = r.executionType === 'click_visible_document_button';
    const docUrl  = isClick ? null : (r.documentUrl || null);
    // A direct occurrence with no file URL is unusable — skip it.
    if (!isClick && !docUrl) continue;

    const srcUrl   = r.sourcePageUrl || null;
    const sPath    = srcUrl ? _pathOf(srcUrl) : '';
    const title    = (r.documentTitle || r.linkText || r.filename || '').trim();
    const lText    = (r.linkText || title || '').trim();
    if (!title && !docUrl) continue;
    const pageDesc = pageDescMap.get(srcUrl) || r.sourcePageDescription || '';
    const fileType = isClick ? 'action' : (r.fileType || _extOf(r.filename || docUrl || ''));
    if (docUrl) docUrlSet.add(docUrl);

    occurrencesIndex.push({
      type:          'document',
      id:            `${isClick ? 'act' : 'doc'}_${_shortHash(docUrl || srcUrl || lText)}::${sPath || srcUrl || ''}`,
      url:           docUrl || srcUrl || '',   // domain-validation target
      path:          sPath,                    // source-page path → _depth + _langPenalty
      title,
      documentUrl:   docUrl,
      documentTitle: title,
      description:   '',
      filename:      r.filename || '',
      fileType,
      executionType: r.executionType,
      sourcePageUrl: srcUrl,
      sourceUrl:     srcUrl || '',
      sourcePath:    sPath,
      linkText:      lText,
      sourcePageDesc: pageDesc,
      pathDepth:     sPath ? sPath.split('/').filter(Boolean).length : 0,
      highlightText: lText,
      f: {
        titleToks:    [...tokenize(title), ...segTokens(r.filename || '')],
        descToks:     tokenize(r.sourcePageTitle || ''),
        linkTextToks: tokenize(lText),
        pageDescToks: tokenize(pageDesc),
        pathToks:     segTokens(sPath),  // carries the product/page name (e.g. "tahawel")
      },
    });

    // Deduplicated document record (direct docs only) for searchDocuments.
    if (docUrl && !docMap.has(docUrl)) {
      docMap.set(docUrl, {
        type:           'document',
        id:             `doc_${_shortHash(docUrl)}`,
        url:            docUrl,
        path:           _pathOf(docUrl),
        title,
        filename:       r.filename || '',
        fileType,
        description:    '',
        sourceUrl:      srcUrl || '',
        sourceTitle:    r.sourcePageTitle || '',
        sourcePath:     sPath,
        sourceLinkText: lText,
        sourcePages:    [{ url: srcUrl, path: sPath, title: r.sourcePageTitle || '', linkText: lText }],
        highlightText:  lText,
        f: {
          titleToks:      [...tokenize(title), ...segTokens(r.filename || '')],
          descToks:       tokenize(r.sourcePageTitle || ''),
          searchToks:     [],
          fileToks:       segTokens(r.filename || ''),
          sourcePageToks: tokenize(`${r.sourcePageTitle || ''} ${sPath}`),
        },
      });
    }
  }

  const documentsIndex = Array.from(docMap.values());
  const allowedUrls    = new Set([...pageUrlSet, ...docUrlSet]);

  return {
    pagesIndex, documentsIndex, occurrencesIndex,
    allowedUrls, pageUrls: pageUrlSet, docUrls: docUrlSet,
    fromResources: true, schema: 'occurrences',
  };
}

// ── Resources path (preferred) ────────────────────────────────────────────────

function _buildFromResources(raw) {
  const agentMap = new Map();
  for (const e of (raw.agentIndex || [])) agentMap.set(e.url, e);

  // Page URL → description lookup for occurrence cross-referencing.
  const pageDescMap = new Map();
  for (const r of raw.resources) {
    if (r.type === 'page') pageDescMap.set(r.url, r.description || '');
  }

  const pagesIndex      = [];
  const documentsIndex  = [];
  const occurrencesIndex = [];

  for (const r of raw.resources) {
    if (r.type === 'page') {
      const agent    = agentMap.get(r.url);
      const linkToks = agent
        ? tokenize(
            (agent.links   || []).slice(0, 40).map((l) => l.text).join(' ') + ' ' +
            (agent.actions || []).map((a) => a.text).join(' '),
          )
        : [];

      pagesIndex.push({
        type:        'page',
        id:          r.id,
        url:         r.url,
        path:        r.path,
        title:       r.title,
        description: r.description || '',
        f: {
          titleToks:  tokenize(r.title),
          pathToks:   segTokens(r.path),
          descToks:   tokenize(r.description || ''),
          searchToks: tokenize(r.searchText  || ''),
          linkToks,
        },
      });

    } else if (r.type === 'document') {
      // Action occurrences: no known file URL; browser must navigate to sourcePage and click.
      if (r.fileType === 'action') {
        for (const sp of (r.sourcePages || [])) {
          const pageDesc = pageDescMap.get(sp.url) || '';
          const lText    = sp.linkText || r.title;
          const sPath    = sp.path || '';
          occurrencesIndex.push({
            type:           'document',
            id:             `${r.id}::${sPath || sp.url}`,
            url:            sp.url || '',  // source page URL — used for domain validation
            path:           sPath,
            title:          r.title,
            documentUrl:    null,
            documentTitle:  r.title,
            description:    r.description || '',
            filename:       '',
            fileType:       'action',
            executionType:  'click_visible_document_button',
            sourcePageUrl:  sp.url || null,
            sourceUrl:      sp.url || '',
            sourcePath:     sPath,
            linkText:       lText,
            sourcePageDesc: pageDesc,
            pathDepth:      sPath.split('/').filter(Boolean).length,
            highlightText:  lText,
            f: {
              titleToks:    tokenize(r.title),
              descToks:     tokenize(r.description || ''),
              linkTextToks: tokenize(lText),
              pageDescToks: tokenize(pageDesc),
              pathToks:     segTokens(sPath),
            },
          });
        }
        // skip documentsIndex entry for action docs — no file URL to index
        continue;  // eslint-disable-line no-continue
      }

      const firstSrc   = (r.sourcePages || [])[0] || {};
      const srcToksRaw = (r.sourcePages || []).slice(0, 5)
        .map((s) => `${s.title || ''} ${s.path || ''}`).join(' ');

      // Kept for backward compat with searchDocuments / direct tests.
      documentsIndex.push({
        type:          'document',
        id:            r.id,
        url:           r.url,
        path:          r.path,
        title:         r.title,
        filename:      r.filename || '',
        fileType:      r.fileType || '',
        description:   r.description || '',
        sourceUrl:      firstSrc.url      || '',
        sourceTitle:    firstSrc.title    || '',
        sourcePath:     firstSrc.path     || '',
        sourceLinkText: firstSrc.linkText || '',
        sourcePages:    r.sourcePages || [],
        highlightText:  firstSrc.linkText || r.title,
        f: {
          titleToks:      tokenize(r.title),
          descToks:       tokenize(r.description  || ''),
          searchToks:     tokenize(r.searchText   || ''),
          fileToks:       segTokens(r.filename    || ''),
          sourcePageToks: tokenize(srcToksRaw),
        },
      });

      // Occurrence index — one entry per (document, sourcePage) pair. Each occurrence
      // carries its own sourcePageUrl so the browser navigates to the best page for
      // the user's query instead of always using sourcePages[0].
      const srcPages = r.sourcePages || [];
      if (srcPages.length === 0) {
        // Fallback occurrence — no known source page; opens document directly.
        occurrencesIndex.push({
          type:          'document',
          id:            r.id,
          url:           r.url,       // document URL — used by domain validation
          path:          r.path || '',
          title:         r.title,
          documentUrl:   r.url,
          documentTitle: r.title,
          description:   r.description || '',
          filename:      r.filename || '',
          fileType:      r.fileType || '',
          sourcePageUrl:  null,
          sourceUrl:      '',
          sourcePath:     '',
          linkText:       r.title,
          sourcePageDesc: '',
          pathDepth:      0,
          highlightText:  r.title,
          f: {
            titleToks:    tokenize(r.title),
            descToks:     tokenize(r.description || ''),
            linkTextToks: tokenize(r.title),
            pageDescToks: [],
            pathToks:     [],
          },
        });
      } else {
        for (const sp of srcPages) {
          const pageDesc = pageDescMap.get(sp.url) || '';
          const lText    = sp.linkText || r.title;
          const sPath    = sp.path || '';
          occurrencesIndex.push({
            type:          'document',
            id:            `${r.id}::${sPath || sp.url}`,
            url:           r.url,       // document URL — used by domain validation
            path:          sPath,       // source page path — used by _langPenalty + _depth
            title:         r.title,
            documentUrl:   r.url,
            documentTitle: r.title,
            description:   r.description || '',
            filename:      r.filename || '',
            fileType:      r.fileType || '',
            sourcePageUrl:  sp.url || null,
            sourceUrl:      sp.url || '',
            sourcePath:     sPath,
            linkText:       lText,
            sourcePageDesc: pageDesc,
            pathDepth:      sPath.split('/').filter(Boolean).length,
            highlightText:  lText,
            f: {
              titleToks:    tokenize(r.title),
              descToks:     tokenize(r.description || ''),
              linkTextToks: tokenize(lText),
              pageDescToks: tokenize(pageDesc),
              pathToks:     segTokens(sPath),
            },
          });
        }
      }
    }
  }

  const allowedUrls = new Set();
  for (const r of raw.resources) if (r.url) allowedUrls.add(r.url);

  return { pagesIndex, documentsIndex, occurrencesIndex, allowedUrls, fromResources: true, schema: 'resources' };
}

// ── Legacy path (agentIndex fallback) ─────────────────────────────────────────

function _buildFromAgentIndex(raw) {
  const entries        = raw.agentIndex || [];
  const documentsIndex = [];
  const pagesIndex     = [];
  const seenDoc        = new Set();

  for (const e of entries) {
    const url      = String(e.url || '');
    const pathS    = String(e.path || '');
    const title    = String(e.title || '');
    const headText = (e.headings || []).map((h) => h.text).join(' ');
    const preview  = String(e.textPreview || '');
    const desc     = String(e.description || '');
    const pageToks = tokenize(`${title} ${pathS}`);

    pagesIndex.push({
      type: 'page', url, path: pathS, title,
      f: {
        pathToks:      segTokens(pathS),
        titleHeadToks: tokenize(`${title} ${headText}`),
        descToks:      tokenize(`${desc} ${preview}`),
        linkToks:      tokenize(
          (e.links || []).slice(0, 40).map((l) => l.text).join(' ') +
          ' ' + (e.actions || []).map((a) => a.text).join(' '),
        ),
      },
    });

    for (const dl of (e.downloads || [])) {
      const href = String(dl.href || '');
      if (!href) continue;
      const fname = filenameOf(href).toLowerCase();
      const dedup = `${href}::${fname}`;
      if (seenDoc.has(dedup)) continue;
      seenDoc.add(dedup);
      documentsIndex.push({
        type: 'document', url: href,
        title: (dl.text || '').trim() || filenameOf(href),
        fileType: (dl.fileType || '').toLowerCase(),
        sourceUrl: url, sourceTitle: title, sourcePath: pathS,
        highlightText: (dl.text || '').trim(),
        f: {
          titleToks: tokenize(dl.text || ''),
          fileToks:  segTokens(filenameOf(href)),
          pageToks,
          nearToks:  tokenize(preview),
        },
      });
    }
  }

  const allowedUrls = new Set();
  for (const p of pagesIndex)     if (p.url) allowedUrls.add(p.url);
  for (const d of documentsIndex) if (d.url) allowedUrls.add(d.url);

  return { pagesIndex, documentsIndex, allowedUrls, fromResources: false, schema: 'agentIndex' };
}

// Language-prefix path penalty (generic: /ar/… /fr/… /en/…).
function _langPenalty(record) {
  let p = record.path;
  if (!p) { try { p = new URL(record.url).pathname; } catch { p = ''; } }
  const segs = String(p || '').split('/').filter(Boolean);
  return (segs[0] && segs[0].length === 2 && /^[a-z]{2}$/i.test(segs[0])) ? 0.10 : 0;
}

// ── Generic scorer ────────────────────────────────────────────────────────────
function _search(records, concepts, weights) {
  const out = [];
  for (const r of records) {
    const fields = weights.map(([k, weight]) => ({ toks: r.f[k] || [], weight }));
    let { score, hits } = _scoreRecord(concepts, fields);
    if (score > 0 && hits > 0) {
      score -= _langPenalty(r);
      out.push({ ...r, score, _depth: segTokens(r.path || r.url).length || 1 });
    }
  }
  out.sort((a, b) => (b.score - a.score) || (a._depth - b._depth) || (a.url < b.url ? -1 : 1));
  return out;
}

// Match requestDescription concepts against title + description only.
// Description is primary (0.52 > SCORE_STRONG): pages matching semantically navigate directly.
// Title is secondary (0.40 < SCORE_STRONG): generic title matches (e.g. "tunisian" hitting every
// "Arab Tunisian Bank" page) stay below the threshold and fall through to the margin check,
// correctly returning suggestions when hundreds of results tie.
// The depth tiebreaker in _search breaks score ties in favour of canonical shallow paths.
// Legacy page fallback uses titleHeadToks (title baked in) since there is no separate titleToks.
function searchDocuments(concepts, idx) {
  return _search(idx.documentsIndex, concepts, [['titleToks', 0.40], ['descToks', 0.52]]);
}

// pathToks is weighted at SCORE_STRONG (0.54) — above descToks (0.52) — because the
// page whose URL path IS the subject (/devise, /nos-agences-en-tunisie, /contact) is
// the canonical destination and must outrank a page that merely mentions the word in
// a heading. Reaching SCORE_STRONG also lets a clear single-concept path match navigate
// confidently instead of falling through to suggestions. Legacy agentIndex pages have
// no separate titleToks, so they score title via titleHeadToks.
function searchPages(concepts, idx) {
  const titleField = idx.fromResources ? 'titleToks' : 'titleHeadToks';
  return _search(idx.pagesIndex, concepts, [[titleField, 0.40], ['descToks', 0.52], ['pathToks', 0.54]]);
}

// Score occurrence candidates: document-level signals (title, desc) dominate selection;
// occurrence-level signals (linkText, pageDesc, path) rank source-page quality.
// Always call _deduplicateOccurrences afterwards so margin check compares documents.
function searchOccurrences(concepts, idx) {
  if (!idx.occurrencesIndex) return searchDocuments(concepts, idx);
  const weights = [
    ['titleToks',    0.40],
    ['descToks',     0.52],
    ['linkTextToks', 0.35],
    ['pageDescToks', 0.28],
    ['pathToks',     0.15],
  ];
  // _search handles _langPenalty (penalises /ar/… source pages), depth sort, and initial sort.
  // Source-page depth ranking is handled by _search's _depth field (segTokens(r.path).length)
  // so that _deduplicateOccurrences picks the shallowest source page for each document.
  const pool = _search(idx.occurrencesIndex, concepts, weights);

  // Click-to-download occurrences have no resolved file URL (documentUrl=null); the
  // browser must navigate to the source page and click a button. A directly known
  // file URL is strictly more reliable, so demote click occurrences by a small,
  // margin-sized penalty. This keeps them selectable when they are the ONLY match
  // (score stays above SCORE_MIN) but lets any competitive direct document win.
  for (const occ of pool) {
    if (occ.executionType === 'click_visible_document_button') occ.score -= CLICK_PENALTY;
  }
  pool.sort((a, b) => (b.score - a.score) || (a._depth - b._depth) || (a.url < b.url ? -1 : 1));
  return pool;
}

// Collapse the full occurrence pool to the single best occurrence per unique documentUrl.
// Prevents multiple occurrences of the same document from compressing the score margin
// and pushing deterministic matches into the suggestions branch.
// After picking the best occurrence per document, _depth is re-computed from the document
// URL path so that _hasStrongMargin compares document depths — matching the behaviour of
// the original searchDocuments where r.path was the document path, not a source-page path.
function _deduplicateOccurrences(pool) {
  const best = new Map();
  for (const occ of pool) {
    const key  = occ.documentUrl || occ.url;
    const prev = best.get(key);
    if (!prev || occ.score > prev.score ||
        (occ.score === prev.score && (occ._depth || 0) < (prev._depth || 0))) {
      best.set(key, occ);
    }
  }
  const out = Array.from(best.values());
  // Re-derive _depth from the document URL path so cross-document margin checks
  // compare document canonical depth, not whichever source-page depth was picked.
  for (const occ of out) {
    let docPath = '';
    try { docPath = new URL(occ.documentUrl || occ.url).pathname; } catch {
      docPath = String(occ.documentUrl || occ.url || '').replace(/^https?:\/\/[^/]+/, '');
    }
    occ._depth = segTokens(docPath).length || 1;
  }
  out.sort((a, b) => (b.score - a.score) || (a._depth - b._depth) || (a.url < b.url ? -1 : 1));
  return out;
}

// ── Gemma system prompts ──────────────────────────────────────────────────────
const GEMMA_SYSTEM = `You are an intent classifier for a website navigation assistant.
Return only valid JSON. No markdown. No explanation.
Schema:
{
  "action": "open_document" | "open_page",
  "requestDescription": "one sentence describing what the user wants to find or open"
}
Rules:
- "action" must be exactly "open_document" or "open_page". No other value is allowed.
- "open_document": user wants a PDF, form, guide, tariff schedule, request file, or any downloadable resource.
- "open_page": user wants to open, visit, or consult a page, section, simulator, contact info, agencies, exchange rates, or any web-based service.
- "requestDescription": one concise neutral sentence. Include the key subject, type of resource, and any product or service name mentioned. Do not include URLs, IDs, or site names.
- Never return confidence, terms, target, URLs, IDs, or any field not in the schema above.
Example: {"action":"open_document","requestDescription":"formulaire d'abonnement au service ATB Messenger"}
Example: {"action":"open_page","requestDescription":"page des devises et taux de change"}
Example: {"action":"open_document","requestDescription":"tarification des opérations bancaires"}`;

const GEMMA_SELECT_SYSTEM = `You choose the best indexed candidate for the user request.
The backend has already built the candidate list. You ONLY pick a number.
Return only valid JSON. Do not invent or return URLs. Do not explain outside the JSON.

Schema:
{
  "selectedCandidateNumber": 1,
  "reason": "short reason"
}

Rules:
- "selectedCandidateNumber" must be one of the numbers shown in the candidate list.
- If none of the candidates match, return {"selectedCandidateNumber": 0, "reason": "no match"}.
- Never return a URL, id, title, or any field other than the two above. Any URL you emit is ignored.`;

// ── Intent parsing ────────────────────────────────────────────────────────────
function parseIntent(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b === -1 || b < a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

const VALID_RESOURCE_TYPES = new Set(['page', 'document', 'unknown']);

// Maps Gemma's new action field to the internal resourceType used by the scorer.
const ACTION_TO_RESOURCE_TYPE = { open_document: 'document', open_page: 'page' };

function validateIntent(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};

  // New schema: { action, requestDescription }
  // Backward-compat: also accept legacy { resourceType } when injected directly by tests.
  const resourceType =
    ACTION_TO_RESOURCE_TYPE[o.action] ||
    (VALID_RESOURCE_TYPES.has(o.resourceType) ? o.resourceType : 'unknown');

  const requestDescription = String(o.requestDescription || '').trim();

  return { resourceType, requestDescription };
}

function fallbackIntent(message) {
  return { resourceType: 'unknown', requestDescription: message };
}

// ── Candidate-selection response ──────────────────────────────────────────────
function parseSelectResponse(raw) {
  const s = String(raw || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b === -1) return null;
  try {
    const obj = JSON.parse(s.slice(a, b + 1));
    if (obj.selectedId === null || obj.selectedId === undefined) return null;
    const id = String(obj.selectedId).trim();
    return id && id !== 'null' ? id : null;
  } catch { return null; }
}

// Parse the number-based selection schema { selectedCandidateNumber, reason }.
// Returns a 1-based number in [1..count], or null for 0 / no-match / invalid.
// Any URL or extra field Gemma emits is ignored — only the number is read.
function parseSelectNumber(raw, count) {
  const s = String(raw || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b === -1) return null;
  try {
    const obj = JSON.parse(s.slice(a, b + 1));
    const n = parseInt(obj.selectedCandidateNumber, 10);
    if (!Number.isInteger(n) || n < 1) return null;
    if (typeof count === 'number' && n > count) return null;
    return n;
  } catch { return null; }
}

// ── Ollama HTTP client ────────────────────────────────────────────────────────
async function _callOllama(message, systemPrompt) {
  const base      = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model     = process.env.INTENT_MODEL || process.env.OLLAMA_MODEL || 'gemma4:e4b';
  const timeoutMs = parseInt(process.env.INTENT_TIMEOUT_MS || '12000', 10);

  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: String(message || '').slice(0, 500) },
    ],
    stream: false,
    format: 'json',
    // keep_alive keeps the ACT intent model (gemma4:e4b) resident between requests.
    keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m',
    options: { temperature: 0, num_predict: 160 },
  });

  return new Promise((resolve, reject) => {
    try {
      const u = new URL('/api/chat', base);
      const req = http.request({
        hostname: u.hostname, port: parseInt(u.port || '80', 10),
        path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          try { resolve(String(JSON.parse(buf)?.message?.content || '')); }
          catch { reject(new Error('ollama parse failed')); }
        });
      });
      req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('ollama timeout')); });
      req.on('error', reject);
      req.write(body);
      req.end();
    } catch (e) { reject(e); }
  });
}

async function callGemma(message) {
  try {
    const raw    = await _callOllama(message, GEMMA_SYSTEM);
    const parsed = parseIntent(raw);
    if (parsed) return validateIntent(parsed);
  } catch { /* fall through */ }
  return fallbackIntent(message);
}

// Build candidate list the backend fully controls. Each candidate carries an
// opaque id, a 1-based number (what Gemma picks), a display title, and the real
// record. Gemma never sees a URL, so it cannot smuggle an invented one back.
function _buildCandidateList(pool, n = 8) {
  return pool.slice(0, n).map((r, i) => ({
    id:         `c${i}`,
    number:     i + 1,
    title:      r.title || filenameOf(r.url || ''),
    fileType:   r.fileType || '',
    type:       r.type || 'unknown',
    path:       r.path || '',
    linkText:   r.linkText || '',
    sourcePath: r.sourcePath || '',
    _record:    r,
  }));
}

function _formatCandidates(candidates) {
  return candidates.map((c) => {
    if (c.type === 'page') {
      const loc = c.path ? ` (${c.path})` : '';
      return `${c.number}. ${c.title}${loc}`;
    }
    const display = c.linkText || c.title;
    const ext     = c.fileType ? ` (${c.fileType.toUpperCase()})` : '';
    const src     = c.sourcePath ? ` — from ${c.sourcePath}` : '';
    return `${c.number}. ${display}${ext}${src}`;
  }).join('\n');
}

// Second Gemma call: the backend supplies a numbered candidate list; Gemma returns
// only { selectedCandidateNumber, reason }. We map the number back to OUR record —
// any URL/id/title Gemma emits is ignored. Returns the chosen candidate's opaque id,
// or null on failure / no-match.
async function callGemmaSelectCandidate(message, candidates) {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].id;
  const list = _formatCandidates(candidates);
  try {
    const raw = await _callOllama(
      `User request: "${message}"\n\nCandidates:\n${list}`,
      GEMMA_SELECT_SYSTEM,
    );
    const num = parseSelectNumber(raw, candidates.length);
    if (num !== null) {
      const chosen = candidates.find((c) => c.number === num);
      if (chosen) return chosen.id;
    }
  } catch { /* fall through */ }
  return null;
}

// ── Decision thresholds ───────────────────────────────────────────────────────
// SCORE_STRONG is set just above the single-concept description weight (0.52) so that
// a lone ambiguous title-only match does not bypass the margin check and navigate
// prematurely.  Multi-concept matches (e.g. 3 concepts × 0.52 = 1.56) still exceed it.
// SCORE_MARGIN is lowered to 0.10 so a 0.12-point gap (description vs title match) is
// enough to declare a confident winner without requiring the old 0.14 gap.
const SCORE_STRONG = 0.54;
const SCORE_MIN    = 0.22;
const SCORE_MARGIN = 0.10;
// Demotion applied to click-to-download occurrences (documentUrl=null) so a known
// direct file URL always wins when competitive, while a lone click match survives.
const CLICK_PENALTY = 0.12;

function _confidence(score, gemmaConf) {
  const s = Math.max(0, Math.min(0.99, score / (score + 0.8)));
  return Number((typeof gemmaConf === 'number' ? Math.min(0.99, (s + gemmaConf) / 2) : s).toFixed(2));
}

function _topMatches(list, n = 3) {
  return list.slice(0, n).map((m) => ({
    type: m.type, title: m.title || filenameOf(m.url), url: m.url, score: Number(m.score.toFixed(2)),
  }));
}

function _hasStrongMargin(pool) {
  if (pool.length < 2) return true;
  if (pool[0].score >= SCORE_STRONG) return true;
  if (pool[0].score === pool[1].score && pool[0]._depth < pool[1]._depth) return true;
  return (pool[0].score - pool[1].score) >= SCORE_MARGIN;
}

function _notFound(intent) {
  return {
    found: false,
    confidence: 0,
    resourceType: intent?.resourceType || 'unknown',
    intent: intent?.resourceType || 'unknown',
    action: { type: 'not_found' },
    answer: 'I could not find that in the indexed public site context.',
    reason: 'No indexed field matched the query terms.',
    topMatches: [],
  };
}

// ── Debug: matched concept → field mapping ────────────────────────────────────
function _matchedConcepts(concepts, record) {
  const matches = [];
  for (const group of (concepts || [])) {
    for (const [field, toks] of Object.entries(record.f || {})) {
      if (_conceptHits(group, toks)) {
        matches.push(`${group[0]}→${field}`);
        break;
      }
    }
  }
  return matches;
}

// ── Result builder ────────────────────────────────────────────────────────────
// concepts is optional; when provided, _selectedResource debug block is attached.
// top may be either a legacy document record or an occurrence record.
// Occurrence records carry sourcePageUrl + documentUrl explicitly; legacy records
// use sourceUrl + url (with sourcePages[] fallback).
function _buildResult(top, intent, allMatches, concepts) {
  const confidence = _confidence(top.score, intent.confidence);
  let action;
  if (top.type === 'document') {
    const hl = top.linkText || top.highlightText || top.title;
    if (top.executionType === 'click_visible_document_button') {
      // No known file URL; browser navigates to product page and clicks the visible button.
      action = {
        type:          'navigate_then_click',
        sourceUrl:     top.sourcePageUrl,
        url:           top.sourcePageUrl,  // used by domain validation
        linkText:      top.linkText || top.title,
        highlightText: hl,
        executionType: 'click_visible_document_button',
      };
    } else {
      const docUrl = top.documentUrl || top.url;
      const srcUrl = top.sourcePageUrl !== undefined
        ? top.sourcePageUrl   // occurrence: explicit field (null → download)
        : (top.sourceUrl || top.sourcePages?.[0]?.url || null);  // legacy record
      action = srcUrl
        ? { type: 'navigate_then_download', sourceUrl: srcUrl, documentUrl: docUrl, url: docUrl, title: top.documentTitle || top.title, highlightText: hl }
        : { type: 'download', url: docUrl, title: top.documentTitle || top.title, highlightText: hl };
    }
  } else {
    action = { type: 'navigate', url: top.url, title: top.title, highlightText: top.highlightText || '' };
  }

  const result = {
    found: true,
    confidence,
    resourceType: intent.resourceType,
    intent: intent.resourceType,
    action,
    answer: 'I found the most relevant result in the indexed site context.',
    reason: 'Matched query terms against indexed fields.',
    topMatches: _topMatches(allMatches || [top]),
  };

  if (concepts) {
    result._selectedResource = {
      id:           top.id   || null,
      title:        top.title,
      description:  top.description || '',
      matchedTerms: _matchedConcepts(concepts, top),
      score:        Number(top.score.toFixed(3)),
      finalUrl:     action.url || action.documentUrl || '',
    };
  }

  return result;
}

// ── Generic document-request detection ───────────────────────────────────────
const _DOC_REQUEST_RE = /\b(documents?|formulaires?|fichiers?|pdf|t[eé]l[eé]charg\w*|demande|remplir|dossier|inscription|liste)\b/i;

function _looksLikeDocumentRequest(message) {
  return _DOC_REQUEST_RE.test(normalize(message));
}

// ── Index-aware document override ─────────────────────────────────────────────
// Returns true when the user query directly names an indexed document occurrence
// by title, linkText, or filename — even without using download keywords.
// Catches cases like "donne moi l'engagement qualité" where Gemma returns open_page
// but the user is clearly asking for a specific indexed PDF/document.
//
// Single-token labels (≥5 chars): exact token presence in query.
// Multi-token labels (≥2 tokens):  ≥75% content-token overlap, minimum 2 hits.
function _strongDocumentMatch(message, requestDescription, idx) {
  if (!idx.occurrencesIndex || idx.occurrencesIndex.length === 0) return false;

  const combined   = normalize((requestDescription || '') + ' ' + (message || ''));
  const queryToks  = tokenize(combined);
  if (queryToks.length === 0) return false;
  const queryTokSet = new Set(queryToks);

  for (const occ of idx.occurrencesIndex) {
    const rawLabels = [
      occ.documentTitle || occ.title || '',
      occ.linkText || '',
    ];
    if (occ.filename) rawLabels.push(occ.filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '));

    for (const raw of rawLabels) {
      const label     = normalize(raw);
      if (label.length < 3) continue;
      const labelToks = tokenize(label);
      if (labelToks.length === 0) continue;

      if (labelToks.length === 1) {
        const tok = labelToks[0];
        if (tok.length >= 5 && (queryTokSet.has(tok) || queryToks.some((qt) => _matchTok(qt, tok)))) {
          return true;
        }
      } else {
        const hits = labelToks.filter((t) =>
          queryTokSet.has(t) || queryToks.some((qt) => _matchTok(qt, t)));
        if (hits.length >= 2 && hits.length >= Math.ceil(labelToks.length * 0.75)) {
          return true;
        }
      }
    }
  }
  return false;
}

// ── Bridge-page search ────────────────────────────────────────────────────────
function _extractBridgeTokens(pageResults, conceptTokenSet) {
  const seen   = new Set(conceptTokenSet);
  const tokens = [];
  for (const page of pageResults.slice(0, 5)) {
    // Support both field names: resources path uses titleToks, legacy uses titleHeadToks
    const toks = [
      ...(page.f.titleToks || page.f.titleHeadToks || []),
      ...(page.f.linkToks || []).slice(0, 40),
    ];
    for (const tok of toks) {
      if (!seen.has(tok) && tok.length >= 4 && !STOP.has(tok)) {
        tokens.push(tok);
        seen.add(tok);
      }
    }
  }
  return tokens.slice(0, 20);
}

function _bridgePageLabel(page) {
  if (page.title && !/arab tunisian bank|البنك/i.test(page.title)) return page.title;
  return page.path || page.url || '';
}

// ── URL validation ────────────────────────────────────────────────────────────
// Validates that a selected URL belongs to the indexed domain AND is an indexed
// URL. The allowed set (built by buildIndexes) contains every page URL plus every
// direct-document URL, so both navigate and download targets are covered. Falls
// back to the raw.resources[].url scan for the enriched schema, then domain-only.
function _validateSelectedUrl(url, domain, raw, idx) {
  if (!url) return false;
  try {
    if (new URL(url).hostname.replace(/^www\./, '') !== domain.replace(/^www\./, '')) return false;
  } catch { return false; }
  if (idx && idx.allowedUrls instanceof Set && idx.allowedUrls.size > 0) {
    return idx.allowedUrls.has(url);
  }
  if (Array.isArray(raw.resources) && raw.resources.length > 0) {
    return raw.resources.some((r) => r.url === url);
  }
  return true;
}

// ── Resolve helpers ───────────────────────────────────────────────────────────
async function _resolveDocument(message, intent, pool, dbg, concepts, selectFn) {
  if (pool.length === 0 || pool[0].score < SCORE_MIN) {
    if (dbg) { dbg.candidates = []; dbg.selectedId = null; dbg.selectionMode = 'empty'; }
    return null;
  }
  const candidates = _buildCandidateList(pool, 8);
  if (dbg) dbg.candidates = candidates;

  // Gemma candidate selection (primary path).
  const fn = selectFn || callGemmaSelectCandidate;
  try {
    const selectedId = await fn(message, candidates);
    if (selectedId !== null && selectedId !== undefined) {
      const chosen = candidates.find((c) => c.id === selectedId);
      if (chosen) {
        if (dbg) { dbg.selectedId = selectedId; dbg.selectionMode = 'gemma'; }
        return _buildResult(chosen._record, intent, pool, concepts);
      }
    }
  } catch { /* Ollama offline / timeout — fall through to deterministic */ }

  // Deterministic fallback: strong-margin top result.
  if (_hasStrongMargin(pool)) {
    if (dbg) { dbg.selectedId = candidates[0]?.id ?? null; dbg.selectionMode = 'deterministic_fallback'; }
    return _buildResult(pool[0], intent, pool, concepts);
  }
  if (dbg) dbg.selectionMode = 'none';
  return null;
}

async function _resolvePage(message, intent, pool, dbg, concepts, selectFn) {
  if (pool.length === 0 || pool[0].score < SCORE_MIN) {
    if (dbg) { dbg.candidates = []; dbg.selectedId = null; dbg.selectionMode = 'empty'; }
    return null;
  }
  const candidates = _buildCandidateList(pool, 8);
  if (dbg) dbg.candidates = candidates;

  // Gemma candidate selection (primary path).
  const fn = selectFn || callGemmaSelectCandidate;
  try {
    const selectedId = await fn(message, candidates);
    if (selectedId !== null && selectedId !== undefined) {
      const chosen = candidates.find((c) => c.id === selectedId);
      if (chosen) {
        if (dbg) { dbg.selectedId = selectedId; dbg.selectionMode = 'gemma'; }
        return _buildResult(chosen._record, intent, pool, concepts);
      }
    }
  } catch { /* Ollama offline / timeout — fall through to deterministic */ }

  // Deterministic fallback: strong-margin top result.
  if (_hasStrongMargin(pool)) {
    if (dbg) { dbg.selectedId = candidates[0]?.id ?? null; dbg.selectionMode = 'deterministic_fallback'; }
    return _buildResult(pool[0], intent, pool, concepts);
  }
  if (dbg) dbg.selectionMode = 'none';
  return null;
}

// ── Main decision function ────────────────────────────────────────────────────
async function decideAction(message, { intent: injected, allowedDomain = '', debug = false, _selectFn, _docOverride = false } = {}) {
  const loaded = loadSiteIndex();
  if (!loaded) {
    return {
      ..._notFound(null),
      answer: 'The site index is not available yet. Run `npm run site:index` first.',
      reason: 'site-index.json missing.',
    };
  }
  const idx = loaded.indexes;
  const raw = loaded.raw;

  let intent = injected ? validateIntent(injected) : await callGemma(message);

  if (!injected && intent.resourceType !== 'document' && _looksLikeDocumentRequest(message)) {
    intent = { ...intent, resourceType: 'document' };
  }

  // Index-aware correction: when Gemma said open_page but the query directly names
  // an indexed document by title/linkText/filename, switch to open_document.
  // _docOverride=true lets tests simulate this path with an injected intent.
  if ((!injected || _docOverride) && intent.resourceType === 'page' &&
      _strongDocumentMatch(message, intent.requestDescription, idx)) {
    intent = { ...intent, resourceType: 'document' };
  }

  const descTerms        = intent.requestDescription ? tokenize(intent.requestDescription) : [];
  const baseConceptInput = descTerms.length > 0 ? descTerms : tokenize(message);
  let concepts           = toConcepts(baseConceptInput);

  const dbg = debug ? { intent } : null;

  if (concepts.length === 0) {
    const r = _notFound(intent);
    if (dbg) r._debug = { ...dbg, expandedTerms: [], candidates: [], pool: [], bridgePages: [], bridgeTerms: [] };
    return r;
  }

  const domain   = allowedDomain || _domain();
  const inDomain = (u) => !domain || String(u || '').includes(domain);

  let bridgePages = [];
  let bridgeTerms = [];

  if (intent.resourceType === 'document') {
    const pageCandidates  = searchPages(concepts, idx).filter((r) => inDomain(r.url)).slice(0, 5);
    const conceptTokenSet = new Set(concepts.flatMap((g) => g));
    const rawBridgeTokens = _extractBridgeTokens(pageCandidates, conceptTokenSet);
    bridgeTerms  = rawBridgeTokens;
    bridgePages  = pageCandidates
      .filter((p) => p.score >= SCORE_MIN)
      .map((p) => ({ label: _bridgePageLabel(p), path: p.path || '', score: Number(p.score.toFixed(3)) }));
  }

  if (dbg) {
    dbg.expandedTerms = concepts.flatMap((g) => g);
    dbg.bridgePages   = bridgePages;
    dbg.bridgeTerms   = bridgeTerms;
  }

  let pool = [];
  if (intent.resourceType === 'document') {
    // Use occurrence-based search: finds best (document, sourcePage) pair.
    // Deduplication collapses to one best occurrence per documentUrl so margin
    // check compares documents, not multiple occurrences of the same file.
    pool = _deduplicateOccurrences(
      searchOccurrences(concepts, idx).filter((r) => inDomain(r.url)),
    );
  } else if (intent.resourceType === 'page') {
    pool = searchPages(concepts, idx).filter((r) => inDomain(r.url));
  } else {
    const docs  = searchDocuments(concepts, idx).filter((r) => inDomain(r.url));
    const pages = searchPages(concepts, idx).filter((r) => inDomain(r.url));
    pool = [...docs, ...pages].sort((a, b) => (b.score - a.score) || (a._depth - b._depth));
  }

  if (pool.length === 0) {
    const r = _notFound(intent);
    if (dbg) r._debug = { ...dbg, candidates: [], pool: [] };
    return r;
  }

  const resolve = intent.resourceType === 'document' ? _resolveDocument : _resolvePage;
  const result  = await resolve(message, intent, pool, dbg, concepts, _selectFn);

  if (result) {
    // Validate the final URL belongs to domain and exists in resources
    const finalUrl = result.action.url || result.action.documentUrl;
    if (finalUrl && !_validateSelectedUrl(finalUrl, domain, raw, idx)) {
      const r = _notFound(intent);
      if (dbg) r._debug = { ...dbg, pool: pool.slice(0, 8), validationFailed: finalUrl };
      return r;
    }

    if (dbg) {
      result._debug = { ...dbg, pool: pool.slice(0, 8) };
      if (result._selectedResource) {
        result._debug.resource = result._selectedResource;
      }
    }
    delete result._selectedResource;
    return result;
  }

  // Margin not strong enough — surface suggestions.
  if (pool[0].score >= SCORE_MIN) {
    const topMatches = _topMatches(pool);
    const r = {
      found: false,
      confidence: _confidence(pool[0].score, intent.confidence),
      resourceType: intent.resourceType,
      intent: intent.resourceType,
      action: { type: 'suggestions', items: topMatches },
      answer: 'I found a few possible matches in the indexed site — which one did you mean?',
      reason: 'Best match below the confidence threshold or no candidate was confidently selected.',
      topMatches,
    };
    if (dbg) r._debug = { ...dbg, pool: pool.slice(0, 8) };
    return r;
  }

  const r = _notFound(intent);
  if (dbg) r._debug = { ...dbg, pool: pool.slice(0, 8) };
  return r;
}

module.exports = {
  decideAction,
  callGemma,
  callGemmaSelectCandidate,
  parseIntent,
  parseSelectResponse,
  parseSelectNumber,
  validateIntent,
  fallbackIntent,
  loadSiteIndex,
  buildIndexes,
  clearCache,
  normalize,
  tokenize,
  toConcepts,
  searchDocuments,
  searchOccurrences,
  searchPages,
  GEMMA_SYSTEM,
  GEMMA_SELECT_SYSTEM,
  SCORE_MIN,
  SCORE_STRONG,
  SCORE_MARGIN,
  _looksLikeDocumentRequest,
  _strongDocumentMatch,
  _extractBridgeTokens,
  _buildCandidateList,
  _formatCandidates,
};
