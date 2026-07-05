#!/usr/bin/env node
'use strict';

/**
 * build-site-index.js
 *
 * Crawl a public website with Playwright, deduplicate the result in memory,
 * and write ONE agent-ready JSON index file — no intermediate raw/clean
 * files are ever written to disk.
 *
 *   node scripts/build-site-index.js https://example.com
 *
 * Output: site-context/<domain>/site-index.json
 *   { meta, rawStats, cleanStats, pages, uniqueDocuments,
 *     uniqueDocumentActions, uniqueForms, uniqueBusinessForms, failedUrls }
 *
 * The script renders every page with a real browser so JavaScript-driven
 * content (dynamic buttons, jQuery templates, SPA sections) is captured.
 * It never clicks anything — it only records what is visible.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { cleanSiteIndex } = require('./lib/site-index-clean');

// ── Settings (kept as plain constants, not environment variables) ──────────────
// No fixed page/discovery cap: crawl runs until the queue is empty and no
// worker is active, or the user interrupts it (Ctrl+C).
const WORKERS = 3; // simple concurrency
const NAV_TIMEOUT = 35000; // primary navigation timeout per page (ms)
const DOM_TIMEOUT = 12000; // secondary waitForLoadState('domcontentloaded') budget
const RETRY_TIMEOUT = 45000; // timeout for the single retry attempt
const SETTLE_DELAY = 800; // extra wait after load so JS can render (ms)

// File extensions treated as documents.
const DOC_EXTENSIONS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'zip', 'rar'];

// Words that mark a visible element as a document / download control.
const DOWNLOAD_WORDS = [
  'telecharger', 'télécharger', 'download', 'document', 'documents',
  'formulaire', 'demande', 'dossier', 'brochure', 'guide', 'notice',
  'fichier', 'pdf', 'fiche',
];

// Words that mark an action as unsafe — never recorded as a document action.
const UNSAFE_WORDS = [
  'submit', 'login', 'log in', 'logout', 'log out', 'connexion', 'deconnexion',
  'déconnexion', 'delete', 'supprimer', 'payment', 'paiement', 'transfer',
  'virement', 'confirm', 'confirmer', 'checkout', 'save', 'enregistrer',
];

// Asset extensions that are never crawled as pages.
const ASSET_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tiff',
  'css', 'js', 'mjs', 'map', 'json', 'xml', 'rss',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp4', 'webm', 'ogg', 'mp3', 'wav', 'avi', 'mov',
  ...DOC_EXTENSIONS,
];

// Path words that mark a URL as risky/useless to crawl (auth, admin, money-moving actions).
const RISKY_PATH_WORDS = [
  'login', 'logout', 'connexion', 'deconnexion', 'déconnexion',
  'admin', 'wp-admin',
  'checkout', 'payment', 'paiement',
  'virement', 'transfer',
  'delete', 'supprimer',
];

// ── URL helpers ────────────────────────────────────────────────────────────────

function normalizeUrl(rawUrl) {
  // Strip the hash and any trailing slash so the same page is not crawled twice.
  const u = new URL(rawUrl);
  u.hash = '';
  let s = u.href;
  if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
  return s;
}

function isAssetUrl(rawUrl) {
  let pathname;
  try {
    pathname = new URL(rawUrl).pathname.toLowerCase();
  } catch {
    return true;
  }
  const ext = pathname.split('.').pop();
  return ASSET_EXTENSIONS.includes(ext);
}

function sameOrigin(rawUrl, origin) {
  try {
    return new URL(rawUrl).origin === origin;
  } catch {
    return false;
  }
}

function isRiskyPath(rawUrl) {
  let pathname;
  try {
    pathname = new URL(rawUrl).pathname.toLowerCase();
  } catch {
    return true;
  }
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // malformed escape sequence — fall back to the raw (still lowercased) pathname
  }
  return RISKY_PATH_WORDS.some((word) => pathname.includes(word));
}

// ATB "details" pages (details, details-finance, entreprises/details, ...) are only
// real content when the last two path segments are numeric, e.g. /details/2326/162.
// Same path prefix with a slug tail, e.g. /details/38/placement, is a bogus relative-link
// artifact and should be skipped.
function isMalformedDetailUrl(rawUrl) {
  let segments;
  try {
    segments = new URL(rawUrl).pathname.split('/').filter(Boolean);
  } catch {
    return true;
  }
  const isDetailUrl = segments.some((seg) => /^details(-.+)?$/i.test(seg));
  if (!isDetailUrl) return false; // not a "details" URL — nothing to check

  const lastTwo = segments.slice(-2);
  if (lastTwo.length < 2) return true; // missing id/sub-id — malformed
  return !lastTwo.every((seg) => /^\d+$/.test(seg));
}

// Single gate for "is this URL worth adding to the crawl queue".
// Returns false for invalid URLs, already-seen URLs, cross-origin URLs,
// asset/document URLs, and risky/useless paths (login, admin, payment, ...).
function shouldCrawlUrl(rawUrl, origin, seen) {
  let key;
  try {
    key = normalizeUrl(rawUrl);
  } catch {
    return false;
  }
  if (seen.has(key)) return false;
  if (!sameOrigin(key, origin)) return false;
  if (isAssetUrl(key)) return false;
  if (isRiskyPath(key)) return false;
  if (isMalformedDetailUrl(key)) return false;
  return true;
}

// ── Browser-side extraction ─────────────────────────────────────────────────────
// This function runs INSIDE the page. It must be self-contained (no outer refs).
function extractPageData(config) {
  const docExtensions = config.docExtensions;
  const downloadWords = config.downloadWords;
  const unsafeWords = config.unsafeWords;

  const docExtRe = new RegExp('\\.(' + docExtensions.join('|') + ')(\\?|#|$)', 'i');

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const lower = (s) => clean(s).toLowerCase();

  const toAbsolute = (href) => {
    if (!href) return null;
    try {
      return new URL(href, location.href).href;
    } catch {
      return null;
    }
  };

  const isVisible = (el) =>
    !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  const hasDownloadWord = (text) => {
    const t = lower(text);
    return downloadWords.some((w) => t.includes(w));
  };

  const isUnsafe = (text) => {
    const t = lower(text);
    return unsafeWords.some((w) => t.includes(w));
  };

  // Pull a document URL out of an element's link-like attributes.
  const findDocUrl = (el) => {
    const attrs = ['href', 'data-url', 'data-href', 'data-file'];
    for (const name of attrs) {
      const val = el.getAttribute(name);
      if (val && docExtRe.test(val)) return toAbsolute(val);
    }
    const onclick = el.getAttribute('onclick');
    if (onclick) {
      const m = onclick.match(/["']([^"']+\.[a-z0-9]+)["']/i);
      if (m && docExtRe.test(m[1])) return toAbsolute(m[1]);
    }
    return null;
  };

  const filenameOf = (url) => {
    try {
      const p = new URL(url).pathname;
      return decodeURIComponent(p.split('/').pop() || '');
    } catch {
      return '';
    }
  };

  // Title + description.
  const title = clean(document.title);
  const metaDesc =
    document.querySelector('meta[name="description"]') ||
    document.querySelector('meta[property="og:description"]');
  const description = clean(metaDesc ? metaDesc.getAttribute('content') : '');

  // Headings.
  const headings = [];
  for (const h of document.querySelectorAll('h1, h2, h3')) {
    const text = clean(h.innerText);
    if (text) headings.push({ level: h.tagName.toLowerCase(), text });
    if (headings.length >= 40) break;
  }

  // Text preview.
  const bodyText = clean(document.body ? document.body.innerText : '');
  const textPreview = bodyText.slice(0, 1500);

  // Internal links (absolute, same origin). Origin filtering is repeated in Node.
  const internalLinks = [];
  const seenLinks = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const abs = toAbsolute(a.getAttribute('href'));
    if (!abs) continue;
    if (!abs.startsWith(location.origin)) continue;
    const key = abs.split('#')[0];
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);
    internalLinks.push(key);
    if (internalLinks.length >= 500) break;
  }

  // Forms.
  const forms = [];
  for (const form of document.querySelectorAll('form')) {
    const fields = [];
    for (const field of form.querySelectorAll('input, select, textarea')) {
      const name = field.getAttribute('name') || field.getAttribute('id');
      if (name) fields.push(name);
    }
    forms.push({
      action: toAbsolute(form.getAttribute('action')) || '',
      method: (form.getAttribute('method') || 'get').toLowerCase(),
      fields,
    });
    if (forms.length >= 40) break;
  }

  // Visible buttons (general list, not necessarily document-related).
  const buttons = [];
  const seenButtons = new Set();
  for (const el of document.querySelectorAll(
    'button, [role="button"], input[type="button"], input[type="submit"]',
  )) {
    if (!isVisible(el)) continue;
    const text = clean(el.innerText || el.value || el.getAttribute('aria-label'));
    if (!text) continue;
    const key = text.toLowerCase();
    if (seenButtons.has(key)) continue;
    seenButtons.add(key);
    buttons.push(text);
    if (buttons.length >= 60) break;
  }

  // Document links and document actions.
  const documentLinks = [];
  const documentActions = [];
  const seenDocUrls = new Set();
  const seenActionText = new Set();

  const candidates = document.querySelectorAll(
    'a[href], [data-url], [data-href], [data-file], [onclick], button, [role="button"]',
  );

  for (const el of candidates) {
    const text = clean(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title'));
    const docUrl = findDocUrl(el);

    if (docUrl) {
      // Direct document URL found.
      if (seenDocUrls.has(docUrl)) continue;
      seenDocUrls.add(docUrl);
      documentLinks.push({
        linkText: text,
        documentUrl: docUrl,
        filename: filenameOf(docUrl),
      });
      continue;
    }

    // No file URL: maybe a JS-driven download button. Only record if it is
    // visible, reads like a download control, and is not an unsafe action.
    if (!text || !isVisible(el)) continue;
    if (!hasDownloadWord(text)) continue;
    if (isUnsafe(text)) continue;

    const key = text.toLowerCase();
    if (seenActionText.has(key)) continue;
    seenActionText.add(key);
    documentActions.push({ linkText: text, documentUrl: null });
    if (documentActions.length >= 40) break;
  }

  return {
    url: location.href,
    title,
    description,
    headings,
    textPreview,
    internalLinks,
    forms,
    buttons,
    documentLinks,
    documentActions,
  };
}

// ── Crawler ──────────────────────────────────────────────────────────────────────

// Navigate to url, wait for content, and return extracted data.
// Uses a two-phase wait:
//   1. 'commit'             — fires as soon as the HTTP response starts (never stalls on slow HTML)
//   2. waitForLoadState()   — best-effort; ignored if slow, we extract what we have
async function renderPage(context, url, config, navTimeout) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: navTimeout });
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: DOM_TIMEOUT });
    } catch {
      // DOM was slow — page has enough HTML to extract from, continue
    }
    await page.waitForTimeout(SETTLE_DELAY);
    return await page.evaluate(extractPageData, config);
  } finally {
    await page.close().catch(() => {});
  }
}

// Calls renderPage once; retries once with a longer timeout on network / timeout errors.
// Propagates immediately when the browser/context was closed (shutdown signal).
async function renderPageWithRetry(context, url, config) {
  try {
    return await renderPage(context, url, config, NAV_TIMEOUT);
  } catch (firstErr) {
    const msg = firstErr.message || '';

    if (msg.includes('closed') || msg.includes('destroyed') || msg.includes('disconnected')) {
      throw firstErr; // browser is shutting down — propagate so the worker can exit cleanly
    }

    if (msg.includes('Timeout') || msg.includes('timeout') || msg.includes('ERR_')) {
      console.log(`  ↺ retry ${url}`);
      return await renderPage(context, url, config, RETRY_TIMEOUT);
    }

    throw firstErr;
  }
}

async function main() {
  const targetUrl = process.argv[2];
  if (!targetUrl) {
    console.error('Usage: node scripts/build-site-index.js <url>');
    process.exit(1);
  }

  let start;
  try {
    start = new URL(targetUrl);
  } catch {
    console.error('Invalid URL:', targetUrl);
    process.exit(1);
  }

  const origin = start.origin;
  const domain = start.hostname;
  const startUrl = normalizeUrl(start.href);

  const config = {
    docExtensions: DOC_EXTENSIONS,
    downloadWords: DOWNLOAD_WORDS,
    unsafeWords: UNSAFE_WORDS,
  };

  const queue = [startUrl];
  const seen = new Set([startUrl]);
  const pages = [];
  const failedUrls = [];

  let crawled = 0;
  let active = 0;
  let interrupted = false;
  let partial = false;

  // First Ctrl+C: stop picking new URLs, let in-flight pages finish naturally.
  // Second Ctrl+C: force exit.
  // The browser is NOT closed here — it stays open until Promise.all(workers) resolves.
  process.on('SIGINT', () => {
    if (interrupted) {
      console.log('\nForce exit.');
      process.exit(130);
    }
    interrupted = true;
    partial = true;
    console.log('\nInterrupted — finishing in-flight pages, then writing partial index...');
  });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: 'SiteIndexBot/1.0 (+Playwright)' });

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  async function worker() {
    while (!interrupted) {
      const url = queue.shift();
      if (!url) {
        if (active === 0) return; // queue empty, nothing in flight — truly done
        await delay(50);
        continue;
      }

      active++;
      crawled++;
      const index = crawled;
      try {
        const data = await renderPageWithRetry(context, url, config);

        // Enqueue newly discovered same-origin, non-asset, non-risky links.
        for (const link of data.internalLinks) {
          if (interrupted) break;
          let key;
          try {
            key = normalizeUrl(link);
          } catch {
            continue;
          }
          if (!shouldCrawlUrl(key, origin, seen)) continue;
          seen.add(key);
          queue.push(key);
        }

        pages.push({ url, ...data });

        console.log(
          `[${index}] ${url} OK ` +
            `links=${data.internalLinks.length} ` +
            `docs=${data.documentLinks.length} ` +
            `actions=${data.documentActions.length} ` +
            `forms=${data.forms.length}`,
        );
      } catch (err) {
        const msg = err.message || '';
        // Browser/context closed during shutdown — not a real page failure
        if (interrupted && (msg.includes('closed') || msg.includes('destroyed') || msg.includes('disconnected'))) {
          // active-- happens in finally; just return after it
          return;
        }
        failedUrls.push({ url, error: msg.split('\n')[0] });
        console.log(`[${index}] ${url} FAILED ${msg.split('\n')[0]}`);
      } finally {
        active--;
      }
    }
  }

  const workers = [];
  for (let i = 0; i < WORKERS; i++) workers.push(worker());
  await Promise.all(workers);

  // Close after all workers finish — never before.
  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  // ── Deduplicate in memory + write the single agent-ready output file ──────────
  const output = cleanSiteIndex({
    meta: {
      targetUrl,
      domain,
      generatedAt: new Date().toISOString(),
      status: partial ? 'partial' : 'complete',
    },
    pages,
    failedUrls,
    urlsDiscovered: seen.size,
  });

  const outDir = path.join(process.cwd(), 'site-context', domain);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'site-index.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log('');
  if (partial) console.log('Crawl was PARTIAL (interrupted).');
  console.log('pages crawled          :', output.cleanStats.pagesCrawled);
  console.log('URLs discovered        :', output.cleanStats.urlsDiscovered);
  console.log('unique documents       :', output.uniqueDocuments.length, `(from ${output.cleanStats.documentOccurrencesFound} occurrences)`);
  console.log('unique document actions:', output.uniqueDocumentActions.length, `(from ${output.cleanStats.documentActionOccurrencesFound} occurrences)`);
  console.log('unique forms           :', output.uniqueForms.length, `(from ${output.cleanStats.formOccurrencesFound} occurrences)`);
  console.log('unique business forms  :', output.uniqueBusinessForms.length);
  console.log('failed pages           :', failedUrls.length);
  console.log('output path            :', outPath);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
