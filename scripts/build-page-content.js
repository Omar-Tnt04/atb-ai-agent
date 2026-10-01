#!/usr/bin/env node
'use strict';

/**
 * build-page-content.js
 *
 * Generate an EXACT cleaned-text JSON of every internal HTML page of a site.
 * Unlike ask-context.json (curated/summarized), this keeps the real page text
 * verbatim — no summarizing, no translation, no LLM. Whitespace is normalized only.
 *
 *   node scripts/build-page-content.js https://atb.tn
 *
 * Input : site-context/<domain>/site-index.json  (reads pages[].url)
 * Output: site-context/<domain>/page-content.json
 *
 * Rendering: pages are rendered with a real browser (Playwright/Chromium) because
 * ATB product pages inject their real content with JavaScript — a raw HTTP fetch
 * returns only the static menu/footer shell. Same engine build-site-index.js uses.
 *
 * Content selection: the visible menu/footer chrome is NOT wrapped in semantic
 * <nav>/<header>/<footer> tags on ATB, so after stripping the semantic chrome we
 * SCORE candidate blocks (low link density + headings/paragraphs + product keywords,
 * penalizing menu words) and keep the best one — not the first container blindly.
 *
 * URL source (--source, default ask-context):
 *   ask-context  curated ask-context.json URLs + useful product/service pages from
 *                site-index.json (/produits/, credit, compte, carte, agence, …).
 *   site-index   all internal HTML pages from site-index.json, minus archive/detail.
 *   all          the full site-index (dangerous/slow — thousands of pages).
 * /details/, /liste.php, pagination/archive/news are skipped unless --include-details
 * (never skipped for --source all).
 *
 * Flags:
 *   --source <mode>    ask-context (default) | site-index | all
 *   --include-details  allow /details/ and /liste.php and archive/news pages
 *   --limit <n>        process at most n pages
 *   --url <pageUrl>    fetch ONLY this one page (quick test); still writes the output file
 *   --force            overwrite an existing page-content.json
 *   --delay-ms <n>     delay between pages (politeness), default 150
 *   --debug-url <url>  render one page, print candidate blocks + scores, write nothing
 *
 * Skips PDFs/images/office docs/zip, mailto:/tel:, and external domains. Keeps .php
 * pages (ATB uses them for real product pages).
 */

const fs = require('fs');
const path = require('path');
const { load } = require('cheerio');
const { chromium } = require('playwright');

// ── args ────────────────────────────────────────────────────────────────────
const SOURCES = new Set(['ask-context', 'site-index', 'all']);

function parseArgs(argv) {
  const args = {
    rootUrl: null, limit: 0, url: null, force: false, delayMs: 150, debugUrl: null,
    source: 'ask-context', includeDetails: false,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--force') args.force = true;
    else if (a === '--include-details') args.includeDetails = true;
    else if (a === '--source') args.source = String(rest[++i] || '').toLowerCase();
    else if (a === '--limit') args.limit = parseInt(rest[++i], 10) || 0;
    else if (a === '--delay-ms') args.delayMs = parseInt(rest[++i], 10) || 0;
    else if (a === '--url') args.url = rest[++i];
    else if (a === '--debug-url') args.debugUrl = rest[++i];
    else if (!a.startsWith('--') && !args.rootUrl) args.rootUrl = a;
  }
  if (!SOURCES.has(args.source)) {
    console.error(`Invalid --source "${args.source}". Use: ask-context | site-index | all`);
    process.exit(1);
  }
  return args;
}

function domainOf(rootUrl) {
  return new URL(rootUrl).hostname.replace(/^www\./, '');
}

// ── URL filtering ─────────────────────────────────────────────────────────────
const SKIP_EXT_RE =
  /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|gz|tar|csv|jpe?g|png|gif|webp|svg|bmp|tiff?|ico|mp[34]|avi|mov|wmv|webm|woff2?|ttf|eot)(?:$|[?#])/i;

function isInternalHtmlUrl(u, domain) {
  let parsed;
  try { parsed = new URL(u); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false; // drops mailto:/tel:
  const host = parsed.hostname.replace(/^www\./, '');
  if (host !== domain) return false;               // external domain
  if (SKIP_EXT_RE.test(parsed.pathname)) return false; // pdf/image/doc/zip/etc.
  return true;
}

function collectPageUrls(siteIndex, domain) {
  const pages = Array.isArray(siteIndex.pages) ? siteIndex.pages : [];
  const seen = new Set();
  const urls = [];
  for (const p of pages) {
    const u = p && p.url;
    if (!u || !isInternalHtmlUrl(u, domain)) continue;
    const key = u.replace(/#.*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(key);
  }
  return urls;
}

// ── URL source selection ──────────────────────────────────────────────────────
// Useful product/service path tokens (lowercased substring match on the full URL).
const USEFUL_TOKENS = [
  '/produits/', '/services/', 'credit', 'compte', 'carte', 'devise', 'simulateur',
  'devenez_client', 'reclamation', 'contact', 'agence', 'documents', 'atb-connect',
  'mobilink', 'atbpay',
];
// Low-value archive / pagination / detail / news pages — skipped unless --include-details
// (never skipped for --source all, which is the deliberate full crawl).
const ARCHIVE_TOKENS = ['/details/', '/liste.php', '?page=', '/actualite', '/archive', '/news'];

const urlKey = (u) => String(u || '').replace(/#.*$/, '');
const isUsefulUrl = (u) => { const s = String(u).toLowerCase(); return USEFUL_TOKENS.some((t) => s.includes(t)); };
const isArchiveUrl = (u) => { const s = String(u).toLowerCase(); return ARCHIVE_TOKENS.some((t) => s.includes(t)); };

// Curated ASK page URLs: contextBlocks[].url (+ any links referenced by those blocks).
function askContextUrls(outDir) {
  const file = path.join(outDir, 'ask-context.json');
  if (!fs.existsSync(file)) return { urls: [], missing: true };
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return { urls: [], parseError: true }; }
  const blocks = Array.isArray(data.contextBlocks) ? data.contextBlocks : [];
  const urls = [];
  for (const b of blocks) {
    if (b && typeof b.url === 'string') urls.push(b.url);
    const links = Array.isArray(b && b.links) ? b.links : [];
    for (const l of links) {
      const u = typeof l === 'string' ? l : (l && (l.url || l.href));
      if (typeof u === 'string') urls.push(u);
    }
  }
  return { urls };
}

function siteIndexUrls(outDir, domain) {
  const file = path.join(outDir, 'site-index.json');
  if (!fs.existsSync(file)) return { urls: [], missing: true };
  let idx;
  try { idx = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return { urls: [], parseError: true }; }
  return { urls: collectPageUrls(idx, domain) };
}

// Build the crawl work list per --source. Returns { urls, info } (info = counts for logging).
function buildWorkList(args, domain, outDir) {
  const { source, includeDetails } = args;
  const applyArchiveSkip = source !== 'all' && !includeDetails;
  const info = { source, askCount: 0, usefulCount: 0, siteIndexCount: 0, selected: 0 };
  let raw = [];

  if (source === 'ask-context') {
    const ask = askContextUrls(outDir);
    if (ask.missing) console.error('warn: ask-context.json missing — falling back to useful site-index URLs only.');
    info.askCount = ask.urls.length;
    const si = siteIndexUrls(outDir, domain);
    if (si.missing) console.error('warn: site-index.json missing — using ask-context URLs only.');
    const useful = (si.urls || []).filter(isUsefulUrl);
    info.usefulCount = useful.length;
    raw = [...ask.urls, ...useful];
    if (raw.length === 0) { console.error('No URLs selected from ask-context.json or site-index.json.'); process.exit(1); }
  } else {
    const si = siteIndexUrls(outDir, domain);
    if (si.missing) { console.error(`Missing ${path.join(outDir, 'site-index.json')} — required for --source ${source}.`); process.exit(1); }
    if (si.parseError) { console.error('Cannot parse site-index.json.'); process.exit(1); }
    raw = si.urls;
    info.siteIndexCount = raw.length;
  }

  const seen = new Set();
  const out = [];
  for (const u of raw) {
    if (!isInternalHtmlUrl(u, domain)) continue;         // non-HTML/external/mailto/tel
    if (applyArchiveSkip && isArchiveUrl(u)) continue;   // /details//liste.php/archive/news
    const k = urlKey(u);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  info.selected = out.length;
  return { urls: out, info };
}

// ── render (real browser — JS content) ─────────────────────────────────────────
async function renderHtml(browser, url, navTimeoutMs = 30000) {
  const page = await browser.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
    // HTTP error status → don't extract; caller records it in failedUrls.
    const status = resp ? resp.status() : 0;
    if (status >= 400) return { ok: false, error: `http_${status}` };
    // Let JS-injected product content settle; don't fail hard if the socket stays open.
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    return { ok: true, html: await page.content() };
  } catch (e) {
    return { ok: false, error: /timeout/i.test(String(e && e.message)) ? 'nav_timeout' : `render_failed:${e && e.message}` };
  } finally {
    await page.close().catch(() => {});
  }
}

// ── extraction ──────────────────────────────────────────────────────────────
const STRIP_SELECTORS = ['script', 'style', 'header', 'nav', 'footer', 'iframe', 'noscript', 'svg'];

// Candidate content containers: semantic tags + id/class hints + top-level body blocks.
// (ATB uses ids like #container-main / #contener_interne, not semantic <main>.)
const CANDIDATE_SELECTORS = [
  'main', 'article', '[role="main"]', 'section',
  '[id*="content"]', '[id*="container"]', '[id*="contener"]', '[id*="main"]', '[id*="produit"]', '[id*="product"]',
  '[class*="content"]', '[class*="container"]', '[class*="main"]', '[class*="article"]', '[class*="produit"]', '[class*="product"]',
  'body > div', 'body > section',
];

function foldAccents(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
const normalizeWs = (t) => String(t || '').replace(/\s+/g, ' ').trim();

// Menu/footer chrome words (accent-folded). Presence in a block penalizes it.
const MENU_WORDS = [
  'espace particuliers', 'espace professionnels', 'espace entreprises', 'espace finance',
  'documents utiles', 'recrutement', 'devenir client', 'nous contacter', 'trouver votre agence',
  'enquete de satisfaction', 'reclamations', 'newsletter', 'mentions legales', 'plan du site',
  'atbchallenge', 'assistance entreprises', 'se connecter', 'connexion', 'prix atb',
];
// Product/service signal words (accent-folded). Presence rewards a block.
const KEYWORD_WORDS = [
  'credit', 'taux', 'tmm', 'dinar', 'montant', 'duree', 'mensualite', 'financ', 'jusqu',
  'apport', 'remboursement', 'souscri', 'offre', 'avantage', 'condition', 'eligib',
  'assurance', 'epargne', 'compte', 'carte', 'pret', 'renov', 'logement', 'travaux',
];

function countOccurrences(hay, needles) {
  let n = 0;
  for (const w of needles) { let i = hay.indexOf(w); while (i !== -1) { n++; i = hay.indexOf(w, i + w.length); } }
  return n;
}

function scoreCandidate($, el) {
  const $el = $(el);
  const text = normalizeWs($el.text());
  const textLen = text.length;
  if (textLen < 40) return null;
  const linkTextLen = normalizeWs($el.find('a').text()).length;
  const density = textLen ? linkTextLen / textLen : 1;
  const nonLink = textLen - linkTextLen;
  const headings = $el.find('h1, h2, h3').length;
  const paragraphs = $el.find('p').length;
  const folded = foldAccents(text);
  const kwHits = countOccurrences(folded, KEYWORD_WORDS);
  const menuHits = countOccurrences(folded, MENU_WORDS);
  // Non-link text dominates; link density is penalized quadratically so a chrome-heavy
  // <body> can't win on raw size alone. Menu words push chrome blocks down hard.
  const score =
    nonLink * (1 - density) * (1 - density)
    + kwHits * 40 + headings * 20 + paragraphs * 8
    - menuHits * 60;
  return { el, text, textLen, links: $el.find('a').length, density, headings, paragraphs, kwHits, menuHits, score };
}

// Return scored candidates (desc). Body is always included as a fallback candidate.
function scoreCandidates($) {
  const seen = new Set();
  const cands = [];
  const consider = (el) => {
    if (!el || seen.has(el)) return;
    seen.add(el);
    const s = scoreCandidate($, el);
    if (s) cands.push(s);
  };
  $(CANDIDATE_SELECTORS.join(',')).each((_, el) => consider(el));
  if ($('body').length) consider($('body')[0]);
  cands.sort((a, b) => b.score - a.score);
  return cands;
}

function labelOf($, el) {
  const $el = $(el);
  const id = $el.attr('id');
  const cls = String($el.attr('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
  return `${el.tagName}${id ? `#${id}` : ''}${cls ? `.${cls}` : ''}`;
}

function extractPage(url, html) {
  const $ = load(html);

  const title = normalizeWs($('title').first().text()) || normalizeWs($('h1').first().text()) || url;
  const langRaw = String($('html').attr('lang') || '').trim().toLowerCase();
  const language = langRaw ? langRaw.split(/[-_]/)[0] : 'fr'; // ATB default; no LLM/detection

  // Remove semantic chrome everywhere, then pick the best-scoring content block.
  $(STRIP_SELECTORS.join(',')).remove();
  const cands = scoreCandidates($);
  const best = cands[0];
  const $container = best ? $(best.el) : ($('body').length ? $('body') : $.root());

  const headings = [];
  const seenH = new Set();
  $container.find('h1, h2, h3').each((_, el) => {
    const h = normalizeWs($(el).text());
    if (h && !seenH.has(h)) { seenH.add(h); headings.push(h); }
  });

  const cleanText = normalizeWs($container.text());

  return {
    page: {
      url,
      title,
      language,
      headings: headings.slice(0, 100),
      cleanText,
      textLength: cleanText.length,
      source: 'html',
      indexedAt: new Date().toISOString(),
    },
    _debug: { cands, chosen: best, $ },
  };
}

// Some servers return HTTP 200 but render a soft error page (Apache "Not Found …").
// Catch those by title/lead text so they never enter pages[].
function looksLikeErrorPage(pg) {
  const title = String(pg && pg.title || '').toLowerCase();
  const hay = `${title}\n${String(pg && pg.cleanText || '').slice(0, 300).toLowerCase()}`;
  return /the requested url/.test(hay)
    || /was not found on this server/.test(hay)
    || /^not found\b/.test(title)
    || /\b404\b/.test(title);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  if (!args.rootUrl) {
    console.error('Usage: node scripts/build-page-content.js <rootUrl> [--url <pageUrl>] [--debug-url <pageUrl>] [--limit n] [--delay-ms n] [--force]');
    process.exit(1);
  }

  const domain = domainOf(args.rootUrl);
  const outDir = path.join(__dirname, '..', 'site-context', domain);
  const outFile = path.join(outDir, 'page-content.json');

  const browser = await chromium.launch();
  try {
    // ── debug mode: render one page, print candidate scores, write nothing ──
    if (args.debugUrl) {
      const r = await renderHtml(browser, args.debugUrl);
      if (!r.ok) { console.error(`debug render failed: ${r.error}`); return; }
      const { page, _debug } = extractPage(args.debugUrl, r.html);
      console.log(`DEBUG ${args.debugUrl}`);
      console.log(`title: ${page.title}`);
      console.log('candidates (top 8, by score):');
      for (const c of _debug.cands.slice(0, 8)) {
        const marker = c === _debug.chosen ? ' <== CHOSEN' : '';
        console.log(
          `  ${labelOf(_debug.$, c.el).padEnd(28)} score=${c.score.toFixed(0).padStart(6)} ` +
          `textLen=${c.textLen} links=${c.links} density=${c.density.toFixed(2)} ` +
          `h=${c.headings} p=${c.paragraphs} kw=${c.kwHits} menu=${c.menuHits}${marker}`);
        console.log(`      preview: ${c.text.slice(0, 90)}`);
      }
      console.log(`\nchosen cleanText[0:400]:\n${page.cleanText.slice(0, 400)}`);
      return;
    }

    if (fs.existsSync(outFile) && !args.force) {
      console.error(`Refusing to overwrite existing ${path.relative(process.cwd(), outFile)} — pass --force.`);
      process.exit(1);
    }

    // Build the URL work list.
    let urls;
    if (args.url) {
      if (!isInternalHtmlUrl(args.url, domain)) {
        console.error(`--url ${args.url} is not an internal HTML page of ${domain}.`);
        process.exit(1);
      }
      urls = [args.url.replace(/#.*$/, '')];
    } else {
      const { urls: work, info } = buildWorkList(args, domain, outDir);
      urls = work;
      console.log(
        `source=${info.source} selected=${info.selected} ` +
        `(askContext=${info.askCount} usefulSiteIndex=${info.usefulCount} siteIndexAll=${info.siteIndexCount})`);
    }
    if (args.limit > 0) urls = urls.slice(0, args.limit);

    console.log(`build-page-content: domain=${domain} pages=${urls.length} delay=${args.delayMs}ms${args.url ? ' (single-url test)' : ''}`);

    const pages = [];
    const failedUrls = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      // One bad page must never abort the run — every failure mode lands in failedUrls.
      try {
        const r = await renderHtml(browser, url);
        if (!r.ok) {
          failedUrls.push({ url, error: r.error });
        } else {
          const pg = extractPage(url, r.html).page;
          if (looksLikeErrorPage(pg)) failedUrls.push({ url, error: 'error_page' });
          else pages.push(pg);
        }
      } catch (e) {
        failedUrls.push({ url, error: `page_error:${e && e.message}` });
      }
      if ((i + 1) % 25 === 0 || i === urls.length - 1) {
        console.log(`  ${i + 1}/${urls.length}  ok=${pages.length} failed=${failedUrls.length}`);
      }
      if (args.delayMs > 0 && i < urls.length - 1) await sleep(args.delayMs);
    }

    const output = {
      domain,
      rootUrl: args.rootUrl,
      generatedAt: new Date().toISOString(),
      pageCount: pages.length,
      pages,
      failedUrls,
    };

    // Atomic write: fill a temp file, then rename — a crash mid-write can't leave a
    // half-written page-content.json in place of the previous good one.
    fs.mkdirSync(outDir, { recursive: true });
    const tmpFile = `${outFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(output, null, 2), 'utf-8');
    fs.renameSync(tmpFile, outFile);
    console.log(`Wrote ${path.relative(process.cwd(), outFile)} — pageCount=${pages.length} failed=${failedUrls.length}.`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error('build-page-content failed:', e); process.exit(1); });
