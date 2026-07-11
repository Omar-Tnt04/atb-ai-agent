#!/usr/bin/env node
'use strict';

/**
 * build-ask-exact-context.js
 *
 * Generate a SEPARATE exact-evidence file for ASK mode from the curated page list in
 * ask-context.json. Renders each contextBlocks[].url, extracts the exact main text
 * (verbatim — no summarizing, translation, or LLM) and writes ask-exact-context.json.
 *
 *   node scripts/build-ask-exact-context.js https://atb.tn --force
 *
 * Input : site-context/<domain>/ask-context.json         (READ ONLY — never modified)
 * Output: site-context/<domain>/ask-exact-context.json   (--force)  or  .preview.json
 *
 * Only contextBlocks[].url is used. Does NOT crawl site-index.json, does NOT read
 * page-content.json / page-content-chunks.json, and does NOT follow links.
 *
 * Options:
 *   --force            write ask-exact-context.json (atomic); else write .preview.json
 *   --url <pageUrl>    process ONLY the block whose url matches (quick test)
 *   --limit <n>        process at most n url-bearing blocks
 *   --delay-ms <n>     delay between page renders (default 150)
 */

const fs = require('fs');
const path = require('path');
const { load } = require('cheerio');
const { chromium } = require('playwright');

// ── args ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { rootUrl: null, force: false, url: null, limit: 0, delayMs: 150, chunkSize: 900 };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--force') args.force = true;
    else if (a === '--url') args.url = rest[++i];
    else if (a === '--limit') args.limit = parseInt(rest[++i], 10) || 0;
    else if (a === '--delay-ms') args.delayMs = parseInt(rest[++i], 10) || 0;
    else if (a === '--chunk-size') args.chunkSize = parseInt(rest[++i], 10) || 900;
    else if (!a.startsWith('--') && !args.rootUrl) args.rootUrl = a;
  }
  return args;
}

const domainOf = (rootUrl) => new URL(rootUrl).hostname.replace(/^www\./, '');
const normalizeWs = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const normUrl = (u) => String(u || '').replace(/#.*$/, '');
const foldAccents = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── render (real browser — some ATB pages are JS-rendered) ──────────────────────
async function render(browser, url, timeoutMs = 30000) {
  const page = await browser.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const status = resp ? resp.status() : 0;
    if (status >= 400) return { ok: false, error: `http_${status}` };
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); // soft settle, never hang
    return { ok: true, html: await page.content() };
  } catch (e) {
    return { ok: false, error: /timeout/i.test(String(e && e.message)) ? 'nav_timeout' : `render_failed:${e && e.message}` };
  } finally {
    await page.close().catch(() => {});
  }
}

// ── best-block extraction (avoid menu/header/footer/sidebar) ────────────────────
const STRIP_SELECTORS = ['script', 'style', 'header', 'nav', 'footer', 'iframe', 'noscript', 'svg'];
const CANDIDATE_SELECTORS = [
  'main', 'article', '[role="main"]', 'section',
  '[id*="content"]', '[id*="container"]', '[id*="contener"]', '[id*="main"]', '[id*="produit"]', '[id*="product"]',
  '[class*="content"]', '[class*="container"]', '[class*="main"]', '[class*="article"]', '[class*="produit"]', '[class*="product"]',
  'body > div', 'body > section',
];
const MENU_WORDS = [
  'espace particuliers', 'espace professionnels', 'espace entreprises', 'espace finance',
  'documents utiles', 'recrutement', 'devenir client', 'nous contacter', 'trouver votre agence',
  'enquete de satisfaction', 'reclamations', 'newsletter', 'mentions legales', 'plan du site',
  'atbchallenge', 'assistance entreprises', 'se connecter', 'connexion', 'prix atb',
];
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
  const score = nonLink * (1 - density) * (1 - density) + kwHits * 40 + headings * 20 + paragraphs * 8 - menuHits * 60;
  return { el, score };
}
function extract(html) {
  const $ = load(html);
  const title = normalizeWs($('title').first().text()) || normalizeWs($('h1').first().text());
  const langRaw = String($('html').attr('lang') || '').trim().toLowerCase();
  const language = langRaw ? langRaw.split(/[-_]/)[0] : 'fr';

  $(STRIP_SELECTORS.join(',')).remove();
  const seen = new Set();
  const cands = [];
  const consider = (el) => { if (el && !seen.has(el)) { seen.add(el); const s = scoreCandidate($, el); if (s) cands.push(s); } };
  $(CANDIDATE_SELECTORS.join(',')).each((_, el) => consider(el));
  if ($('body').length) consider($('body')[0]);
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  const $c = best ? $(best.el) : ($('body').length ? $('body') : $.root());
  const cleanText = normalizeWs($c.text());
  const linkTextLen = normalizeWs($c.find('a').text()).length;
  return {
    title, language, cleanText,
    metrics: { textLength: cleanText.length, nonLink: cleanText.length - linkTextLen, density: cleanText.length ? linkTextLen / cleanText.length : 1 },
  };
}

// ── quality gates ───────────────────────────────────────────────────────────────
function isErrorText(title, cleanText) {
  const hay = `${String(title || '').toLowerCase()}\n${String(cleanText || '').slice(0, 300).toLowerCase()}`;
  return /the requested url/.test(hay) || /was not found on this server/.test(hay) || /not found/.test(hay) || /\b404\b/.test(hay);
}
function qualityReason(title, cleanText, m) {
  if (isErrorText(title, cleanText)) return 'error_page';
  if (m.textLength < 120) return 'too_short';
  if (m.nonLink < 100) return 'low_nonlink_text';
  if (m.density > 0.7) return 'high_link_density';
  return null; // ok
}

// ── chunking (natural boundaries, verbatim, no overlap) ─────────────────────────
function findBreak(clean, start, hardEnd) {
  const min = start + Math.floor((hardEnd - start) * 0.5);
  for (let i = hardEnd; i > min; i--) {
    const ch = clean[i];
    if ((ch === '.' || ch === '!' || ch === '?' || ch === '…') && (i + 1 >= clean.length || clean[i + 1] === ' ')) return i + 1;
  }
  const sp = clean.lastIndexOf(' ', hardEnd);
  if (sp > min) return sp;
  return hardEnd;
}
function chunkText(text, size) {
  const clean = normalizeWs(text);
  if (clean.length <= size) return clean ? [clean] : [];
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    const hardEnd = Math.min(start + size, clean.length);
    let end = hardEnd < clean.length ? findBreak(clean, start, hardEnd) : hardEnd;
    if (end <= start) end = hardEnd;
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = end;
    while (start < clean.length && clean[start] === ' ') start++;
  }
  return chunks;
}
function filterChunks(chunks) {
  if (chunks.length <= 1) return chunks;
  const kept = chunks.filter((c) => c.length >= 80);
  return kept.length ? kept : chunks.slice(0, 1);
}

// ── main ────────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  if (!args.rootUrl) {
    console.error('Usage: node scripts/build-ask-exact-context.js <rootUrl> [--force] [--url <pageUrl>] [--limit n] [--delay-ms n]');
    process.exit(1);
  }

  const domain = domainOf(args.rootUrl);
  const dir = path.join(__dirname, '..', 'site-context', domain);
  const askFile = path.join(dir, 'ask-context.json');
  if (!fs.existsSync(askFile)) { console.error(`Missing ${path.relative(process.cwd(), askFile)}.`); process.exit(1); }

  // ask-context.json is opened READ-ONLY and never written back.
  let source;
  try { source = JSON.parse(fs.readFileSync(askFile, 'utf-8')); }
  catch (e) { console.error(`Cannot parse ask-context.json: ${e.message}`); process.exit(1); }
  const blocks = Array.isArray(source.contextBlocks) ? source.contextBlocks : [];

  // Clean up the stale artifact from the old in-place enrichment plan (never touch ask-context.json).
  const oldPreview = path.join(dir, 'ask-context.preview.json');
  try { if (fs.existsSync(oldPreview)) { fs.unlinkSync(oldPreview); console.log(`Removed stale ${path.relative(process.cwd(), oldPreview)}`); } } catch {}

  let targets;
  if (args.url) {
    const key = normUrl(args.url);
    targets = blocks.filter((b) => b && normUrl(b.url) === key);
    if (targets.length === 0) { console.error(`--url ${args.url} not found among contextBlocks[].url.`); process.exit(1); }
  } else {
    targets = args.limit > 0 ? blocks.filter((b) => b && b.url).slice(0, args.limit) : blocks;
  }

  const stats = {
    totalSourceBlocks: blocks.length, attemptedUrls: 0, exactBlocks: 0,
    skippedLowQuality: 0, failedExtractions: 0, totalExactChunks: 0, failures: [],
  };
  const exactBlocks = [];

  const browser = await chromium.launch();
  try {
    for (let i = 0; i < targets.length; i++) {
      const b = targets[i];
      const id = b && (b.id || b.url) || `block${i}`;
      const url = b && typeof b.url === 'string' ? b.url : '';
      if (!url) { stats.failures.push({ id, url: null, error: 'no_url' }); stats.failedExtractions++; continue; }

      stats.attemptedUrls++;
      let result;
      try {
        const r = await render(browser, url);
        if (!r.ok) result = { fail: r.error };
        else {
          const ext = extract(r.html);
          const reason = qualityReason(ext.title, ext.cleanText, ext.metrics);
          result = reason ? { fail: reason } : { ext };
        }
      } catch (e) {
        result = { fail: `page_error:${e && e.message}` };
      }

      if (result.fail) {
        stats.failures.push({ id, url, error: result.fail });
        if (result.fail === 'too_short' || result.fail === 'low_nonlink_text' || result.fail === 'high_link_density') stats.skippedLowQuality++;
        else stats.failedExtractions++;
      } else {
        const { ext } = result;
        const pieces = filterChunks(chunkText(ext.cleanText, args.chunkSize));
        const exactChunks = pieces.map((text, chunkIndex) => ({ chunkId: `${id}-${chunkIndex}`, text, textLength: text.length, chunkIndex }));
        exactBlocks.push({
          id: b.id || id,
          type: b.type || 'page',
          url,
          title: ext.title || b.title || '',
          language: ext.language || b.language || '',
          sourceContextId: b.id || null,
          sourceConfidence: b.confidence != null ? b.confidence : null,
          usefulForQuestionsAbout: Array.isArray(b.usefulForQuestionsAbout) ? b.usefulForQuestionsAbout : [],
          exactText: { cleanText: ext.cleanText, textLength: ext.cleanText.length, source: 'rendered-html', indexedAt: new Date().toISOString() },
          exactChunks,
        });
        stats.exactBlocks++;
        stats.totalExactChunks += exactChunks.length;
      }

      if ((i + 1) % 10 === 0 || i === targets.length - 1) {
        console.log(`  ${i + 1}/${targets.length}  exact=${stats.exactBlocks} failed=${stats.failedExtractions} lowQ=${stats.skippedLowQuality}`);
      }
      if (args.delayMs > 0 && i < targets.length - 1) await sleep(args.delayMs);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const output = {
    meta: {
      version: '1.0',
      purpose: 'ask_exact_context',
      targetUrl: args.rootUrl,
      domain,
      generatedAt: new Date().toISOString(),
      sourceFile: 'ask-context.json',
      stats,
    },
    exactBlocks,
  };

  const outName = args.force ? 'ask-exact-context.json' : 'ask-exact-context.preview.json';
  const outFile = path.join(dir, outName);
  const tmp = `${outFile}.tmp`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(output, null, 2), 'utf-8');
  fs.renameSync(tmp, outFile);
  console.log(
    `Wrote ${path.relative(process.cwd(), outFile)}${args.force ? '' : ' (PREVIEW — original ask-context.json untouched)'} — ` +
    `exactBlocks=${stats.exactBlocks}/${stats.totalSourceBlocks} chunks=${stats.totalExactChunks} failed=${stats.failedExtractions} lowQ=${stats.skippedLowQuality}`);
}

main().catch((e) => { console.error('build-ask-exact-context failed:', e); process.exit(1); });
