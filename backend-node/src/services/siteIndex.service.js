'use strict';
const crypto = require('crypto');
const fs   = require('fs');
const path = require('path');
const { adaptSiteIndex } = require('./siteIndexAdapter.service');

const CACHE_DIR  = path.join(__dirname, '../../.cache');
const INDEX_PATH = path.join(CACHE_DIR, 'site-index.json');

// Primary source of truth: Crawlee unified output at site-context/<domain>/site-index.json.
// Falls back to the legacy backend-node/.cache/site-index.json when present.
const SITE_CONTEXT_DIR = path.join(__dirname, '../../..', 'site-context');

function _targetDomain() {
  try {
    return new URL(process.env.TARGET_URL || 'https://atb.tn').hostname.replace(/^www\./, '');
  } catch {
    return 'atb.tn';
  }
}

function _siteContextIndexPath() {
  return path.join(SITE_CONTEXT_DIR, _targetDomain(), 'site-index.json');
}

// Normalize the unified site-index.json so existing consumers keep working:
// flatten meta.{targetUrl,origin,generatedAt} to top level. `pages` already has
// the full page shape used by the scorers.
function _normalizeUnified(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  // Clean-index shape (scripts/clean-site-index.js) → reconstruct resources[]/
  // documentOccurrences[]/page.documentLinks etc. so scorers below need no changes.
  parsed = adaptSiteIndex(parsed);
  if (parsed.meta && !parsed.targetUrl) {
    return {
      ...parsed,
      targetUrl:   parsed.meta.targetUrl || null,
      origin:      parsed.meta.origin || null,
      generatedAt: parsed.meta.generatedAt || null,
    };
  }
  return parsed;
}

function _ensureDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// ── In-memory cache (5-min TTL) ───────────────────────────────────────────────

let _mem = null;
let _memAt = 0;
const MEM_TTL_MS = 5 * 60 * 1000;

// ── Persistence ───────────────────────────────────────────────────────────────

function getSiteIndex() {
  const now = Date.now();
  if (_mem && (now - _memAt) < MEM_TTL_MS) return _mem;
  // Prefer the unified site-context output; fall back to the legacy cache.
  const candidates = [_siteContextIndexPath(), INDEX_PATH];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = _normalizeUnified(JSON.parse(fs.readFileSync(file, 'utf-8')));
      if (!parsed || !Array.isArray(parsed.pages)) continue;
      _mem = parsed;
      _memAt = now;
      return _mem;
    } catch {
      /* try next candidate */
    }
  }
  _mem = null;
  return null;
}

function saveSiteIndex(index) {
  _ensureDir();
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), 'utf-8');
  _mem = index;
  _memAt = Date.now();
}

function clearSiteIndex() {
  try { if (fs.existsSync(INDEX_PATH)) fs.unlinkSync(INDEX_PATH); } catch { /* ignore */ }
  _mem = null;
  _memAt = 0;
}

// ── Content checks ────────────────────────────────────────────────────────────

function siteIndexHasUsefulContent(index) {
  if (!index || !Array.isArray(index.pages)) return false;
  return index.pages.length > 0;
}

// ── Summary ───────────────────────────────────────────────────────────────────

function summarizeSiteIndex(index) {
  if (!index) return null;
  const pages = index.pages || [];
  const totalLinks = pages.reduce((s, p) => s + (p.links?.length || p.internalLinks?.length || 0), 0);
  const totalDownloads = pages.reduce((s, p) => s + _downloadsOf(p).length, 0);
  return {
    exists: true,
    pageCount: pages.length,
    totalLinks,
    totalDownloads,
    generatedAt: index.generatedAt || null,
    targetUrl: index.targetUrl || null,
    topPages: pages.slice(0, 5).map((p) => ({ url: p.url, title: p.title || '' })),
  };
}

// ── Prompt formatting ─────────────────────────────────────────────────────────

function formatSiteIndexForPrompt(index, { maxPages = 8, maxLinksPerPage = 6 } = {}) {
  if (!siteIndexHasUsefulContent(index)) return '';
  const lines = ['[SITE INDEX]'];
  if (index.targetUrl) lines.push(`Site: ${index.targetUrl}`);
  if (index.generatedAt) lines.push(`Indexed: ${index.generatedAt}`);
  lines.push('');

  for (const page of (index.pages || []).slice(0, maxPages)) {
    lines.push(`Page: ${page.url}`);
    if (page.title) lines.push(`  Title: ${page.title}`);
    if (page.headings?.length) {
      const h = page.headings.slice(0, 4).map((h) => h.text).join(' | ');
      lines.push(`  Headings: ${h}`);
    }
    if (page.textBlocks?.length) {
      lines.push(`  Text: ${page.textBlocks[0].slice(0, 160)}`);
    }
    if (page.links?.length) {
      const linkSample = page.links.slice(0, maxLinksPerPage).map((l) => l.text).join(', ');
      lines.push(`  Links (${page.links.length}): ${linkSample}`);
    }
    if (page.downloadLinks?.length) {
      const dlSample = page.downloadLinks.slice(0, 4).map((d) => `${d.text} (${d.fileType})`).join(', ');
      lines.push(`  Downloads (${page.downloadLinks.length}): ${dlSample}`);
    }
    if (page.contactFacts?.emails?.length || page.contactFacts?.phones?.length) {
      const cf = [
        ...(page.contactFacts.emails || []),
        ...(page.contactFacts.phones || []),
      ].slice(0, 4).join(', ');
      lines.push(`  Contact: ${cf}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Retrieval helpers ─────────────────────────────────────────────────────────

// Generic stop words — English + French function words.
const STOP_WORDS = new Set([
  'the','and','for','are','this','that','with','from','what','how',
  'can','you','have','has','will','its','more','but','not','all','any','each',
  'les','des','pour','dans','sur','une','est','qui','que','par','pas',
  'cette','votre','notre','mon','mes','son','ses',
  'quel','quels','quelle','quelles',
  'faire','avoir','etre','aller','voir','vouloir',
  'about','there','would','could','should','their','which','when','were',
]);

// ── Bilingual alias groups for ATB site search ────────────────────────────────
// Each group = equivalent EN/FR terms. When any appears in a query, all group
// members are used for scoring, bridging short EN tokens (card/form/request)
// to longer French words (carte/formulaire/demande) that block stem matching.
const _ALIAS_GROUPS = [
  ['contact', 'contacter', 'joindre'],
  ['card', 'carte', 'cartes', 'bancaire', 'bancaires'],
  ['request', 'demande', 'demander'],
  ['form', 'formulaire'],
  ['credit', 'crédit', 'prêt', 'pret', 'financement'],
  ['simulator', 'simulateur', 'simulation'],
  ['agency', 'agence', 'agences'],
  ['rates', 'rate', 'taux', 'change', 'devise', 'devises'],
  ['tariff', 'tariffs', 'tarif', 'tarifs'],
  ['transfer', 'transfert', 'virement'],
  ['digital', 'ebanking', 'online'],
  ['complaint', 'réclamation', 'reclamation', 'plainte'],
  ['abroad', 'étranger', 'etranger', 'diaspora'],
  ['messenger', 'atbmessenger'],
  ['mobile', 'mobilink', 'atbmobile'],
  ['pay', 'atbpay'],
];

// term → group (all members lowercase, including self).
const _aliasLookup = new Map();
for (const group of _ALIAS_GROUPS) {
  const norm = group.map((t) => t.toLowerCase());
  for (const term of norm) {
    if (!_aliasLookup.has(term)) _aliasLookup.set(term, norm);
  }
}

// Expand tokens: each token that matches an alias group adds all group members.
function _expandTokens(tokens) {
  const out = new Set(tokens);
  for (const tok of tokens) {
    const g = _aliasLookup.get(tok);
    if (g) g.forEach((t) => out.add(t));
  }
  return [...out];
}

// Fold accents so query text matches indexed text regardless of diacritics:
// "médiateur" → "mediateur", "téléphone" → "telephone", "réclamation" → "reclamation".
// Generic (Unicode NFD), not a per-word table.
function _foldAccents(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function _tokenize(text) {
  return _foldAccents(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

// True if the query is about the user's personal account data (not the website).
function _isPersonalQuery(query) {
  return /\b(my|mon|mes)\s+(customer|account|card|profile|balance|transaction|statement|bill|loan|cheque|checkbook)\b|\b(my|mon|mes)\s+(savings|current)\s+account\b|\bmy\s+(phone|number)\s+(is|on|in)\b|\bon\s+my\b/i.test(query);
}

// True when query explicitly refers to the whole site (not just the current page).
function _isSiteWideQuery(query) {
  return /\bon\s+(the|your|this)\s+site\b|\bon\s+the\s+website\b|\bavailable\s+on\s+(the\s+)?(site|website)\b|\bsur\s+le\s+site\b|\bdu\s+site\b|\bon\s+your\s+website\b/i.test(query);
}

/**
 * Clean a raw extracted phone string.
 * Returns a normalized string, or null if clearly not a phone.
 * Does NOT invent digits — only normalizes whitespace/separators.
 */
function _cleanPhone(s) {
  const str = String(s || '').trim();
  const digits = (str.match(/\d/g) || []).length;
  if (digits < 8 || digits > 13) return null;
  if (/\d{4}-\d{2}-\d{2}/.test(str)) return null; // date
  if (/\d+\.\d{4}/.test(str)) return null;          // coordinate
  // Normalize repeated spaces and tighten spacing around dashes
  return str.replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim();
}

function _isLikelyPhone(s) { return _cleanPhone(s) !== null; }

// Prefix-based stem match for French morphological variants.
// "demander" ↔ "demande", "services" ↔ "service", "bancaires" ↔ "bancaire"
function _stemMatch(a, b) {
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen < 5) return false;
  return a.startsWith(b.slice(0, minLen)) || b.startsWith(a.slice(0, minLen));
}

// ── Page-shape normalizers (old crawl vs new build-site-index schema) ──────────
// Old (Laragon) pages carry textBlocks[] + downloadLinks[{text,href,fileType}].
// New (build-site-index) pages carry textPreview + documentLinks[{linkText,
// documentUrl,filename}]. These helpers expose one shape to the scorers/answerers
// so both indexes work without special-casing every call site.
function _downloadsOf(page) {
  if (Array.isArray(page.downloadLinks) && page.downloadLinks.length) return page.downloadLinks;
  if (Array.isArray(page.documentLinks) && page.documentLinks.length) {
    return page.documentLinks.map((d) => {
      const src = String(d.filename || d.documentUrl || '');
      const ext = (src.match(/\.([a-z0-9]{1,5})(?:\?|#|$)/i) || [])[1] || '';
      return { text: d.linkText || d.filename || '', href: d.documentUrl || '', fileType: ext.toLowerCase() };
    });
  }
  return [];
}

function _bodyTextOf(page) {
  if (Array.isArray(page.textBlocks) && page.textBlocks.length) return page.textBlocks.slice(0, 5).join(' ');
  return String(page.textPreview || '');
}

/**
 * Score individual download links across matched pages against the specific query.
 * Uses alias expansion (EN/FR) + stem matching. Scores per original query concept
 * to avoid double-counting when multiple aliases match the same document field.
 * Also scores against dl.href and parent page title/URL as fallback signals.
 * Returns [{dl, page, score}] sorted desc, filtered to score >= 0.3.
 */
function searchDocumentLinks(question, matches) {
  const rawQTokens = _tokenize(question);
  if (rawQTokens.length === 0 || !matches || matches.length === 0) return [];

  const scored = [];
  for (const { page } of matches) {
    const pageToks = _tokenize(`${page.title || ''} ${page.url || ''}`);
    for (const dl of _downloadsOf(page)) {
      const dlToks     = _tokenize(dl.text || '');
      const dlHrefToks = _tokenize(dl.href  || '');
      let score = 0;
      const matchedConcepts = new Set();

      for (const rawTok of rawQTokens) {
        if (matchedConcepts.has(rawTok)) continue;
        // Expand this token to its full alias group (always includes self).
        const tokGroup = _aliasLookup.has(rawTok)
          ? new Set([rawTok, ..._aliasLookup.get(rawTok)])
          : new Set([rawTok]);

        let matched = false;

        // 1. Document title text — strongest signal.
        for (const qt of tokGroup) {
          for (const dt of dlToks) {
            if (_stemMatch(qt, dt)) { matched = true; break; }
          }
          if (matched) break;
        }
        if (matched) { matchedConcepts.add(rawTok); score += 0.40; continue; }

        // 2. Document href/URL — medium signal (file name often encodes subject).
        for (const qt of tokGroup) {
          for (const dt of dlHrefToks) {
            if (_stemMatch(qt, dt)) { matched = true; break; }
          }
          if (matched) break;
        }
        if (matched) { matchedConcepts.add(rawTok); score += 0.20; continue; }

        // 3. Parent page title + URL — weak context signal.
        for (const qt of tokGroup) {
          for (const pt of pageToks) {
            if (_stemMatch(qt, pt)) { matched = true; break; }
          }
          if (matched) break;
        }
        if (matched) { matchedConcepts.add(rawTok); score += 0.10; continue; }
      }

      if (score >= 0.3) scored.push({ dl, page, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5);
}

/**
 * Derive a human-readable label from a page's URL path.
 * For very short paths (language codes, etc.) fall back to title if more descriptive.
 */
function getPageLabel(page) {
  try {
    const u = new URL(String(page.url || 'https://x.com'));
    const rawPath = u.pathname.replace(/^\//, '').replace(/\/+$/, '').replace(/\.[^./?]+$/, '');
    if (!rawPath) return 'Homepage';
    // Very short path (e.g. "/ar", "/fr") — likely a language variant; use title if available
    if (rawPath.length <= 3) {
      const title = String(page.title || '').trim();
      if (title && title.length > 6) return title.slice(0, 60);
      return rawPath.toUpperCase() + ' version';
    }
    const label = rawPath.replace(/[-_/]+/g, ' ').trim();
    return label.charAt(0).toUpperCase() + label.slice(1);
  } catch {
    return String(page.title || page.url || 'Unknown page');
  }
}

/**
 * Pick the single most-relevant page for the Match trace line.
 * Intent-aware: documents → most downloads; contact → contact-page first;
 * services/default → highest score (already at index 0).
 */
function getBestMatchPage(question, matches) {
  if (!matches || matches.length === 0) return null;
  const q = question.toLowerCase();
  const wantsDocuments = /\b(documents?|downloads?|forms?|formulaire|pdfs?|t[eé]l[eé]charger|files?|fichiers?)\b/i.test(q);
  const wantsContact   = /\b(contact|phone|t[eé]l|email|address|adresse|agence)\b/i.test(q);

  if (wantsDocuments) {
    return [...matches].sort(
      (a, b) => _downloadsOf(b.page).length - _downloadsOf(a.page).length,
    )[0]?.page || matches[0].page;
  }

  if (wantsContact) {
    const contactMatch = matches.find(({ page }) =>
      /contact|agence|nous[\s-]+joindre/.test(`${page.url} ${page.title}`.toLowerCase()),
    );
    if (contactMatch) return contactMatch.page;
    return [...matches].sort((a, b) => {
      const af = ((a.page.contactFacts?.phones || []).filter(_isLikelyPhone).length +
                  (a.page.contactFacts?.emails || []).length);
      const bf = ((b.page.contactFacts?.phones || []).filter(_isLikelyPhone).length +
                  (b.page.contactFacts?.emails || []).length);
      return bf - af;
    })[0]?.page || matches[0].page;
  }

  // Default: highest-scoring page (already sorted)
  return matches[0].page;
}

/**
 * Score each page in the index against the query.
 * Returns sorted [{page, score}] filtered to score >= minScore.
 * Returns [] immediately for personal account questions.
 */
function searchSiteIndex(query, index, { maxResults = 5, minScore = 0.30 } = {}) {
  if (!siteIndexHasUsefulContent(index)) return [];
  if (_isPersonalQuery(query)) return [];

  const rawTokens = _tokenize(query);
  if (rawTokens.length === 0) return [];

  const pages = index.pages || [];

  // ── Ubiquitous token exclusion (IDF-based) ──────────────────────────────
  // Tokens that appear in the title or URL of ≥75% of pages are site-identity
  // tokens (e.g. "atb", "bank", "arab") and do not discriminate between pages.
  const tokenPageFreq = new Map();
  for (const page of pages) {
    const pageToks = new Set(_tokenize(`${page.title} ${page.url}`));
    for (const t of pageToks) tokenPageFreq.set(t, (tokenPageFreq.get(t) || 0) + 1);
  }
  const ubiqThresh = Math.ceil(pages.length * 0.75);
  const ubiqToks = new Set(
    [...tokenPageFreq.entries()].filter(([, c]) => c >= ubiqThresh).map(([t]) => t),
  );
  // Also exclude bare domain tokens (e.g. "atb" from "atb.tn").
  const domainToks = new Set(
    _tokenize((index.origin || index.targetUrl || '').replace(/^https?:\/\//, '')),
  );

  const tokens = rawTokens.filter((t) => !ubiqToks.has(t) && !domainToks.has(t));
  // If all tokens were ubiquitous, fall back to raw tokens but with low weight.
  const scoringTokens  = tokens.length > 0 ? tokens : rawTokens;
  const tokenWeight    = tokens.length > 0 ? 1.0 : 0.3;
  const expandedTokens = _expandTokens(scoringTokens);

  // ── Category intent detection ────────────────────────────────────────────
  const wantsDocuments = /\b(documents?|downloads?|forms?|formulaire|pdfs?|t[eé]l[eé]charger|files?|fichiers?)\b/i.test(query);
  const wantsContact   = /\b(contact|phone|t[eé]l[eé]phone|email|address|adresse|reach|joindre|agence)\b/i.test(query);
  const wantsServices  = /\b(services?|banque|banking|online|en ligne|produits?|products?|tarifs?|fees?|r[eé]clamation|complaint)\b/i.test(query);
  const siteBoost      = _isSiteWideQuery(query) ? 0.30 : 0.0;

  // Generic doc query: asks about available downloads/files broadly.
  // NOT generic: "what documents are required for SME account" (product-specific).
  const isGenericDocQuery = wantsDocuments &&
    !/\b(required|needed|necessary|obligatoire)\b.{0,40}\b(account|loan|credit|sme|pme|compte|pr[eê]t)\b|\b(pour\s+(ouvrir|un|une))\b/i.test(query);

  // Generic contact query: asks how to reach the organisation broadly.
  // NOT generic: "support phone for Tunis branches" (branch-specific).
  const isGenericContactQuery = wantsContact &&
    !/\b(for\s+(the\s+)?\w+(\s+\w+)?\s*(branch(?:es)?|agences?|r[eé]gion)\b|support\s+(phone|line|number)\s+for\b)/i.test(query);

  const scored = [];

  for (const page of pages) {
    let score = 0;

    const titleToks = _tokenize(page.title || '');
    const urlToks   = _tokenize(page.url || '');
    const hText     = (page.headings || []).map((h) => String(h.text || '')).join(' ');
    const hToks     = _tokenize(hText);
    const bodyText  = _bodyTextOf(page);
    const bodyToks  = _tokenize(bodyText);
    const linkText  = (page.links || []).slice(0, 60).map((l) => String(l.text || '')).join(' ');
    const linkToks  = _tokenize(linkText);
    const downloads = _downloadsOf(page);
    const dlText    = downloads.map((d) => String(d.text || '')).join(' ');
    const dlToks    = _tokenize(dlText);

    // Token overlap scoring — alias-expanded for EN/FR cross-matching.
    for (const tok of expandedTokens) {
      if (titleToks.includes(tok)) score += 0.40 * tokenWeight;
      if (urlToks.includes(tok))   score += 0.20 * tokenWeight;
      if (hToks.includes(tok))     score += 0.30 * tokenWeight;
      if (bodyToks.includes(tok))  score += 0.15 * tokenWeight;
      if (linkToks.includes(tok))  score += 0.10 * tokenWeight;
      if (dlToks.includes(tok))    score += 0.25 * tokenWeight;
    }

    // URL slug stem boost — rescues WAF-blocked pages whose only signal is their
    // URL path (e.g. /nous-contacter). Stem-matches so "contact" hits "contacter".
    // Deduplicates per URL path token to prevent double-counting alias variants.
    const urlSlugToks  = _tokenize((() => { try { return new URL(page.url).pathname; } catch { return ''; } })());
    const hitSlugToks  = new Set();
    for (const tok of expandedTokens) {
      for (const ut of urlSlugToks) {
        if (!hitSlugToks.has(ut) && _stemMatch(tok, ut)) {
          hitSlugToks.add(ut);
          score += 0.40 * tokenWeight;
        }
      }
    }

    // Exact phrase boost (title or headings)
    const qLower = query.toLowerCase().trim();
    if (`${page.title} ${hText}`.toLowerCase().includes(qLower)) score += 0.50;

    // Category boosts — only for genuinely generic site-exploration questions
    if (isGenericDocQuery && downloads.length > 0) score += 0.50;
    if (isGenericContactQuery) {
      const cf = page.contactFacts || {};
      const hasPhone = (cf.phones || []).some(_isLikelyPhone);
      const hasEmail = (cf.emails || []).length > 0;
      if (hasPhone || hasEmail) score += 0.50;
      if (/contact|agence/.test(`${page.url} ${page.title}`.toLowerCase())) score += 0.30;
    }
    if (wantsServices) {
      if (/service|banque|banking|produit|product|en\s+ligne|online|tarif/.test(
        `${page.title} ${hText} ${linkText}`.toLowerCase(),
      )) score += 0.20;
    }

    score += siteBoost;

    if (score >= minScore) scored.push({ page, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}

// ── Generic labeled-field extraction ──────────────────────────────────────────
// Pulls "Label: value" pairs out of free page text (address / email / phone /
// hours), multilingual labels, value runs until the next known label or end.
// Reusable for any site whose pages carry structured-looking contact text —
// NOT ATB-specific. ponytail: covers the common label set; add a label spelling
// to _FIELD_SYNONYMS if a site uses a term not listed.
const _FIELD_SYNONYMS = [
  ['address', 'adresse|address|location|siege\\s+social|siege'],
  ['email',   'e[-\\s]?mail|courriel'],
  ['phone',   'telephone|tel|phone|mobile|gsm|fax|numero'],
  ['hours',   'horaires?|opening\\s+hours|hours|ouverture'],
];
const _ANY_FIELD_LABEL = _FIELD_SYNONYMS.map(([, syn]) => syn).join('|');

function extractLabeledFields(text) {
  const s = _foldAccents(text).replace(/\s+/g, ' ').trim();
  if (!s) return {};
  const out = {};
  for (const [field, syn] of _FIELD_SYNONYMS) {
    // value = everything after "label :" up to the next known label+colon or end.
    const re = new RegExp(`\\b(?:${syn})\\s*[:：]\\s*(.+?)(?=\\s+(?:${_ANY_FIELD_LABEL})\\s*[:：]|$)`, 'i');
    const m = s.match(re);
    if (!m || m[1].trim().length <= 1) continue;
    const val = m[1].trim();
    // Reject truncated/garbage phone values (crawl often cuts numbers off).
    if (field === 'phone' && !_isLikelyPhone(val)) continue;
    out[field] = val;
  }
  return out;
}

// Which labeled fields the question is asking for (accent-folded, multilingual).
function _wantedContactFields(question) {
  const q = _foldAccents(question).toLowerCase();
  const out = [];
  if (/\b(adresse|address|location|situe|localis|siege|ou\s+se\s+trouve|where)\b/.test(q)) out.push('address');
  if (/\b(email|e\s?mail|courriel|mail)\b/.test(q)) out.push('email');
  if (/\b(telephone|tel|phone|numero|number|appeler|call|joindre|contact)\b/.test(q)) out.push('phone');
  if (/\b(horaires?|hours|ouvert|open)\b/.test(q)) out.push('hours');
  return out;
}

/**
 * Build a concise (≤ 3 non-empty lines) deterministic answer from siteIndex matches.
 * Returns null when no useful answer can be constructed (caller should fall through).
 */
function buildSiteIndexAnswer(question, matches) {
  if (!matches || matches.length === 0) return null;

  const q = question.toLowerCase();
  const wantsDocuments = /\b(documents?|downloads?|forms?|formulaire|pdfs?|t[eé]l[eé]charger|files?|fichiers?)\b/i.test(q);
  const wantsContact   = /\b(contact|phone|t[eé]l|email|address|adresse|reach|joindre|agence)\b/i.test(q);

  // ── Documents / downloads ────────────────────────────────────────────────
  if (wantsDocuments) {
    // Try specific document matching — score individual download links.
    const SPECIFIC_DOC_THRESHOLD = 0.6;
    const specificMatches = searchDocumentLinks(question, matches);
    if (specificMatches.length > 0 && specificMatches[0].score >= SPECIFIC_DOC_THRESHOLD) {
      const { dl, page } = specificMatches[0];
      const fileType = (dl.fileType || 'pdf').toUpperCase();
      return [
        `Best matching document: **${dl.text}** (${fileType})`,
        `Download: ${dl.href}`,
        `Source: ${page.url}`,
      ].join('\n');
    }

    // Generic: collect and display all indexed downloads.
    const sortedByDl = [...matches].sort(
      (a, b) => _downloadsOf(b.page).length - _downloadsOf(a.page).length,
    );
    const dls  = [];
    const seen = new Set();
    for (const { page } of sortedByDl) {
      for (const dl of _downloadsOf(page)) {
        const key = dl.href || dl.text;
        if (!seen.has(key)) { seen.add(key); dls.push(dl); }
        if (dls.length >= 20) break;
      }
      if (dls.length >= 20) break;
    }

    if (dls.length === 0) {
      return (
        `Found ${matches.length} relevant page(s) — no direct downloads are indexed.\n` +
        `Switch to **Act on site** mode to browse and download files.`
      );
    }

    const sourcePage = sortedByDl[0].page;
    const sourceLabel = getPageLabel(sourcePage);
    const sample = dls.slice(0, 3).map((dl) => `**${dl.text}** (${dl.fileType.toUpperCase()})`).join(', ');
    const moreCount = dls.length - 3;
    return [
      `I found **${dls.length}** downloadable file(s) on the site (from: ${sourceLabel}).`,
      `Top files: ${sample}${moreCount > 0 ? ` …and ${moreCount} more` : ''}.`,
      `Source: ${sourcePage.url}`,
    ].join('\n');
  }

  // ── Contact / phone / email ──────────────────────────────────────────────
  if (wantsContact) {
    // Generic labeled-field extraction: scan matched pages' body text for the
    // exact field the user asked for (address/email/phone/hours). Handles pages
    // like /professionnels/mediateur whose contact data lives in free text, not
    // in a structured contactFacts object. Not ATB-specific.
    const wantedFields = _wantedContactFields(question);
    if (wantedFields.length > 0) {
      const LABELS = { address: 'Address', email: 'Email', phone: 'Phone', hours: 'Hours' };
      for (const { page } of matches.slice(0, 5)) {
        const fields = extractLabeledFields(_bodyTextOf(page));
        const hit = wantedFields.find((f) => fields[f]);
        if (hit) {
          return [`${LABELS[hit]}: ${fields[hit]}`, `Source: ${page.url}`].join('\n');
        }
      }
    }

    // Only commit to siteIndex answer if a genuine contact page exists in results.
    const hasContactPage = matches.some(({ page }) =>
      /contact|agence|nous[\s-]+joindre/.test(`${page.url} ${page.title}`.toLowerCase()),
    );

    const phones = [];
    const emails = [];
    const contactPages = [];
    for (const { page } of matches) {
      const cf = page.contactFacts || {};
      const pgPhones = (cf.phones || []).map(_cleanPhone).filter(Boolean);
      const pgEmails = cf.emails || [];
      if (pgPhones.length || pgEmails.length) {
        phones.push(...pgPhones);
        emails.push(...pgEmails);
        contactPages.push(page);
      }
    }
    const uPhones = [...new Set(phones)].slice(0, 3);
    const uEmails = [...new Set(emails)].slice(0, 2);

    // No contact page and no facts → fall through to static contact facts.
    if (!hasContactPage && uPhones.length === 0 && uEmails.length === 0) return null;

    // Contact page exists but no clean facts → point to the page directly.
    if (uPhones.length === 0 && uEmails.length === 0) {
      const cp = matches.find(({ page }) =>
        /contact|agence/.test(`${page.url} ${page.title}`.toLowerCase()),
      );
      if (cp) {
        return (
          `I found a contact page: **${getPageLabel(cp.page)}** — ${cp.page.url}\n` +
          `Switch to **Act on site** mode to browse it for current contact details.`
        );
      }
      return null;
    }

    // Build answer — label as "possible" to signal imperfect extraction.
    const out = [];
    if (uPhones.length > 0) {
      // Use comma separator (not " | ") to avoid confusion with dash-separated numbers
      out.push(`Possible contact number(s): ${uPhones.join(', ')}`);
    }
    if (uEmails.length > 0) out.push(`Email: ${uEmails.join(', ')}`);
    const srcPage = contactPages[0];
    if (srcPage) out.push(`Source: ${srcPage.url}`);
    return out.slice(0, 3).join('\n');
  }

  // ── Default: services / general site exploration ──────────────────────────
  // Show top 3 pages with URL-derived labels and the most descriptive snippet available.
  // Prefer: headings → internal link texts → textBlocks (links often carry service names).
  const top = matches.slice(0, 3);
  const items = top.map(({ page }) => {
    const label = getPageLabel(page);
    const headDesc = (page.headings || []).slice(0, 2).map((h) => h.text).filter(Boolean).join(', ');
    // Skip the first internal link (usually a logo/language-switcher) and take the next 5.
    const linkDesc = (page.links || [])
      .filter((l) => !l.external)
      .slice(1, 6)
      .map((l) => l.text)
      .filter(Boolean)
      .join(', ');
    const textDesc = _bodyTextOf(page).slice(0, 80);
    const desc = headDesc || linkDesc.slice(0, 120) || textDesc;
    const shortUrl = page.url.replace(/^https?:\/\/[^/]+/, '') || '/';
    const descPart = desc ? `: ${desc.slice(0, 120)}` : '';
    return `- **${label}**${descPart} (${shortUrl})`;
  });

  if (items.length === 0) return null;
  return ['Here is what I found in the indexed content:', ...items].join('\n');
}

// ── Normalized Resource builders ──────────────────────────────────────────────
// Produce the canonical Resource shape used by resourceResolver.service.js.
// Both functions are additive — existing callers of siteIndex are unaffected.

function _resourceId(url) {
  return crypto.createHash('sha1').update(String(url || '')).digest('hex').slice(0, 12);
}

function _urlSlug(url) {
  try {
    return new URL(String(url || '')).pathname
      .replace(/^\//, '').replace(/\/+$/, '').replace(/\.[^./?]+$/, '')
      .replace(/[-_/]+/g, ' ').trim();
  } catch { return ''; }
}

/**
 * Normalize a siteIndex download-link + its containing page into a Resource object.
 * @param {{ href: string, text: string, fileType: string }} dl
 * @param {{ url: string, title: string, headings: Array, textBlocks: Array }} page
 */
function toResource(dl, page) {
  const url = String(dl.href || '');
  const filename = url.split('/').pop().split('?')[0] || '';
  const extMatch = filename.match(/\.([a-z0-9]+)$/i);
  const extension = extMatch ? extMatch[1].toLowerCase() : (dl.fileType || '');
  const nearbyText = (page.textBlocks || []).slice(0, 2).join(' ').slice(0, 200);
  const headingText = (page.headings || []).slice(0, 3).map((h) => String(h.text || '')).join(' | ').slice(0, 120);
  return {
    id:          _resourceId(url),
    type:        'document',
    url,
    sourcePage:  page.url || null,
    title:       page.title || '',
    filename,
    extension,
    anchorText:  String(dl.text || '').trim(),
    nearbyText,
    headingText,
    urlSlug:     '',
    selector:    url ? `a[href="${url}"]` : null,
    contentType: 'download',
  };
}

/**
 * Normalize a siteIndex page into a Resource object.
 * @param {{ url: string, title: string, headings: Array, textBlocks: Array }} page
 */
function pageToResource(page) {
  const url = String(page.url || '');
  const nearbyText = (page.textBlocks || []).slice(0, 2).join(' ').slice(0, 200);
  const headingText = (page.headings || []).slice(0, 3).map((h) => String(h.text || '')).join(' | ').slice(0, 120);
  return {
    id:          _resourceId(url),
    type:        'page',
    url,
    sourcePage:  null,
    title:       page.title || '',
    filename:    '',
    extension:   '',
    anchorText:  '',
    nearbyText,
    headingText,
    urlSlug:     _urlSlug(url),
    selector:    null,
    contentType: 'navigation',
  };
}

// ── ASK-mode helpers ──────────────────────────────────────────────────────────

const _ACTION_VERBS_RE = /\b(open|go\s+to|navigate(?:\s+to)?|click|download|t[eé]l[eé]charger|ouvre|ouvrir|va\s+(?:vers|au|aux?)|clique[rz]?|ouvrez|acc[eé]de[rz]?)\b/i;

/**
 * Returns true when the query contains an explicit action verb (open, navigate,
 * download, etc.). ASK mode uses this to redirect to ACT mode instead of
 * attempting a knowledge answer.
 */
function isActionRequest(query) {
  return _ACTION_VERBS_RE.test(query);
}

/**
 * Collect structured evidence from a site-index for a given query.
 * Reads page matches AND document links AND top-level documentOccurrences (new schema).
 * Returns [{sourceType, kind, title, url, text, score}] sorted by score desc.
 */
function collectEvidence(query, index) {
  if (!siteIndexHasUsefulContent(index)) return [];

  const matches  = searchSiteIndex(query, index, { maxResults: 8, minScore: 0.20 });
  const evidence = [];
  const seenUrls = new Set();

  for (const { page, score } of matches) {
    const pageUrl = page.url || '';
    if (!seenUrls.has(pageUrl)) {
      seenUrls.add(pageUrl);
      const text = _bodyTextOf(page).slice(0, 200) ||
        (page.headings || []).slice(0, 2).map((h) => h.text).join(' ');
      evidence.push({
        sourceType: 'site-index',
        kind: 'page',
        title: page.title || getPageLabel(page),
        url: pageUrl,
        text,
        score,
      });
    }

    for (const dl of _downloadsOf(page).slice(0, 3)) {
      const docUrl = dl.href || '';
      if (!docUrl || seenUrls.has(docUrl)) continue;
      seenUrls.add(docUrl);
      evidence.push({
        sourceType: 'site-index',
        kind: 'document',
        title: dl.text || dl.href,
        url: docUrl,
        text: `${dl.text} (${(dl.fileType || 'pdf').toUpperCase()}) — from ${page.title || page.url}`,
        score: score * 0.85,
      });
    }
  }

  // Top-level documentOccurrences (new build-site-index schema)
  const docOccs = Array.isArray(index.documentOccurrences) ? index.documentOccurrences : [];
  if (docOccs.length > 0) {
    const rawToks = _tokenize(query);
    const expanded = _expandTokens(rawToks);
    for (const occ of docOccs) {
      const occToks = _tokenize(
        [occ.linkText, occ.documentTitle, occ.filename].filter(Boolean).join(' '),
      );
      let hits = 0;
      for (const tok of expanded) {
        if (occToks.some((t) => _stemMatch(tok, t))) hits++;
      }
      if (hits === 0) continue;
      const docUrl = occ.documentUrl || '';
      if (!docUrl || seenUrls.has(docUrl)) continue;
      seenUrls.add(docUrl);
      evidence.push({
        sourceType: 'site-index',
        kind: 'document',
        title: occ.linkText || occ.documentTitle || occ.filename || docUrl,
        url: docUrl,
        text: `${occ.linkText || occ.documentTitle || ''} — from ${occ.sourcePageUrl || ''}`,
        score: Math.min(hits * 0.35, 0.90),
      });
    }
  }

  evidence.sort((a, b) => b.score - a.score);
  return evidence.slice(0, 10);
}

/**
 * Standard "not enough context" answer for ASK mode.
 * Returned when evidence is empty or below confidence threshold.
 */
function buildAskNotFoundAnswer() {
  return 'I could not find enough information in the indexed sources to answer this question.';
}

module.exports = {
  getSiteIndex,
  saveSiteIndex,
  clearSiteIndex,
  siteIndexHasUsefulContent,
  summarizeSiteIndex,
  formatSiteIndexForPrompt,
  searchSiteIndex,
  searchDocumentLinks,
  buildSiteIndexAnswer,
  extractLabeledFields,
  getBestMatchPage,
  getPageLabel,
  toResource,
  pageToResource,
  isActionRequest,
  collectEvidence,
  buildAskNotFoundAnswer,
  INDEX_PATH,
};
