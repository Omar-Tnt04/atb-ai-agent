#!/usr/bin/env node
'use strict';

/*
 * export-playwright-capture.js
 *
 * Secure, generic Playwright capture exporter for ANY public website (incl. banking).
 * Renders each safe, same-origin public page read-only, extracts evidence + a full-page
 * screenshot, and packages everything into a zip you can upload to ChatGPT later so
 * ChatGPT can manually author ask-context.json.
 *
 * This script does NOT generate ask-context.json, does NOT call any LLM, and does NOT
 * modify act mode or the existing crawler.
 *
 *   node scripts/export-playwright-capture.js site-context/atb.tn/site-index.json   # from index
 *   node scripts/export-playwright-capture.js https://example.com                   # from URL
 *
 * Env (defaults):
 *   CAPTURE_MAX_PAGES=0            0 = all discovered safe pages, no artificial limit
 *   CAPTURE_HEADLESS=true
 *   CAPTURE_TIMEOUT_MS=35000
 *   CAPTURE_WORKERS=3
 *   CAPTURE_VIEWPORT_WIDTH=1440
 *   CAPTURE_VIEWPORT_HEIGHT=1000
 *   CAPTURE_SAME_ORIGIN_ONLY=true
 *   CAPTURE_FORCE=false           re-capture URLs already present (resume off)
 *   CAPTURE_ZIP_SPLIT_MB=90       split package when it would exceed this
 *
 * Security: read-only. Never submits forms, types, clicks, authenticates, or uses a saved
 * profile. Fresh isolated browser context per page. No cookies/storage packaged. Skips
 * login/account/payment/etc. paths and token-like query params. Redacts obvious secrets.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const AdmZip = require('adm-zip');

// ---------------------------------------------------------------------------- config
const bool = (v, d) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.floor(n) : d; };

const CFG = {
  maxPages: int(process.env.CAPTURE_MAX_PAGES, 0), // 0 => unlimited
  headless: bool(process.env.CAPTURE_HEADLESS, true),
  timeout: int(process.env.CAPTURE_TIMEOUT_MS, 35000),
  workers: Math.max(1, int(process.env.CAPTURE_WORKERS, 3)),
  viewport: { width: int(process.env.CAPTURE_VIEWPORT_WIDTH, 1440), height: int(process.env.CAPTURE_VIEWPORT_HEIGHT, 1000) },
  sameOriginOnly: bool(process.env.CAPTURE_SAME_ORIGIN_ONLY, true),
  force: bool(process.env.CAPTURE_FORCE, false),
  splitBytes: int(process.env.CAPTURE_ZIP_SPLIT_MB, 90) * 1024 * 1024,
};

// Asset extensions that must never be treated as a page.
const ASSET_EXT = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'zip', 'rar',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'css', 'js', 'mjs',
  'json', 'xml', 'mp4', 'mp3', 'webm', 'avi', 'mov', 'woff', 'woff2', 'ttf', 'eot',
]);
// Document extensions we RECORD (as links) but never download.
const DOC_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'zip', 'rar']);

// Risky/private path segments — never capture.
const RISKY = [
  'login', 'logout', 'signin', 'sign-in', 'signup', 'sign-up', 'admin', 'wp-admin',
  'account', 'compte', 'dashboard', 'payment', 'paiement', 'transfer', 'virement',
  'checkout', 'password', 'motdepasse', 'otp', 'auth', 'delete', 'supprimer',
  'confirm', 'send', 'connexion', 'deconnexion',
];
const RISKY_RE = new RegExp(`(?:^|[/_-])(?:${RISKY.join('|')})(?:$|[/_?-])`, 'i');

// Query keys that look like tokens/secrets — such URLs are skipped entirely.
const SECRET_KEY_RE = /(token|secret|password|passwd|otp|auth|session|sess|jwt|access|refresh|bearer|api[_-]?key|apikey|signature|sig|code|nonce|hash)/i;
// Inline secret shapes to redact from text/urls.
const SECRET_VALUE_RES = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT
  /\b(?:bearer|token|secret|apikey|api_key|password)\b\s*[:=]\s*[^\s'"&]{6,}/gi,
  /\b[A-Fa-f0-9]{32,}\b/g, // long hex (hashes/keys)
];

function redact(text) {
  let out = String(text || '');
  for (const re of SECRET_VALUE_RES) out = out.replace(re, '[REDACTED]');
  return out;
}

// ---------------------------------------------------------------------------- url helpers
function extensionOf(pathname) {
  const leaf = pathname.split('/').pop() || '';
  return leaf.includes('.') ? leaf.split('.').pop().toLowerCase() : '';
}

function normalizeUrl(raw, base) {
  let url;
  try { url = base ? new URL(raw, base) : new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_|fbclid|gclid|mc_)/i.test(key) || SECRET_KEY_RE.test(key)) url.searchParams.delete(key);
  }
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
}

function host(h) { return String(h || '').toLowerCase().replace(/^www\./, ''); }

function isDocUrl(u) {
  try { return DOC_EXT.has(extensionOf(new URL(u).pathname)); } catch { return false; }
}

// Is this URL a safe, same-origin, non-asset, non-risky PAGE?
function isCapturable(raw, originHost) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (!/^https?:$/.test(url.protocol)) return false;
  if (CFG.sameOriginOnly && host(url.hostname) !== host(originHost)) return false;
  if (ASSET_EXT.has(extensionOf(url.pathname))) return false;
  let pathname = url.pathname;
  try { pathname = decodeURIComponent(pathname); } catch {}
  if (RISKY_RE.test(pathname)) return false;
  for (const key of url.searchParams.keys()) if (SECRET_KEY_RE.test(key)) return false;
  return true;
}

function safeName(url) {
  const h = crypto.createHash('sha1').update(url).digest('hex').slice(0, 10);
  let slug;
  try {
    slug = new URL(url).pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'root';
  } catch { slug = 'page'; }
  return `${slug}-${h}`;
}

// ---------------------------------------------------------------------------- in-page extractor
// Runs inside the browser. Self-contained. Read-only — no clicks, no typing, no submits.
function extractInPage() {
  const tidy = (v) => String(v || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const abs = (v) => { try { return new URL(v, location.href).href.split('#')[0]; } catch { return ''; } };
  const docRe = /\.(pdf|docx?|xlsx?|pptx?|csv|txt|zip|rar)(?:[?#]|$)/i;

  const title = tidy(document.title);
  const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
  const metaDescription = tidy(meta && meta.getAttribute('content'));
  const language = tidy(document.documentElement.lang).toLowerCase().split('-')[0] || 'unknown';
  const renderedText = String(document.body ? document.body.innerText : '').replace(/ /g, ' ');

  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    .map((h) => ({ level: h.tagName.toLowerCase(), text: tidy(h.innerText) }))
    .filter((h) => h.text);

  const roleFor = (el) => {
    const tag = el.tagName.toLowerCase();
    if (['header', 'nav', 'main', 'section', 'article', 'footer'].includes(tag)) return tag;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'banner') return 'header';
    if (role === 'navigation') return 'nav';
    if (role === 'main') return 'main';
    if (role === 'contentinfo') return 'footer';
    return 'other';
  };
  const sections = [];
  for (const el of document.querySelectorAll('header,nav,main,section,article,footer,[role="main"],[role="banner"],[role="navigation"],[role="contentinfo"]')) {
    const text = tidy(el.innerText).slice(0, 6000);
    if (!text) continue;
    const h = el.querySelector('h1,h2,h3,h4,h5,h6');
    sections.push({ role: roleFor(el), heading: tidy(h && h.innerText), text });
  }

  const links = [];
  const documents = [];
  const seenL = new Set();
  const seenD = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const href = abs(a.getAttribute('href'));
    if (!href) continue;
    const text = tidy(a.innerText || a.getAttribute('aria-label') || a.title);
    if (docRe.test(href)) {
      if (seenD.has(href)) continue;
      seenD.add(href);
      let filename = '';
      try { filename = decodeURIComponent(new URL(href).pathname.split('/').pop() || ''); } catch {}
      documents.push({ text, url: href, filename, fileType: (href.match(docRe)[1] || '').toLowerCase() });
    } else {
      if (seenL.has(href)) continue;
      seenL.add(href);
      links.push({ text, href });
    }
  }

  const buttons = [...document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]')]
    .map((b) => ({ text: tidy(b.innerText || b.value || b.getAttribute('aria-label')) }))
    .filter((b) => b.text);

  // Forms are RECORDED only. We never submit or type into them.
  const forms = [...document.querySelectorAll('form')].map((f) => ({
    action: abs(f.getAttribute('action') || location.href),
    method: tidy(f.method || 'get').toLowerCase(),
    fields: [...f.querySelectorAll('input,select,textarea')].map((x) => ({
      name: tidy(x.name || x.id),
      type: tidy(x.type || x.tagName).toLowerCase(),
      placeholder: tidy(x.placeholder),
      label: tidy((x.labels && x.labels[0] && x.labels[0].innerText) || x.getAttribute('aria-label')),
    })),
  }));

  return { title, language, metaDescription, renderedText, headings, sections, links, buttons, forms, documents };
}

// ---------------------------------------------------------------------------- capture one page
async function capturePage(browser, url, shotDir) {
  const warnings = [];
  // Fresh isolated context per page: no shared cookies/storage, no saved profile, no auth carryover.
  const context = await browser.newContext({
    viewport: CFG.viewport,
    userAgent: 'PlaywrightCaptureExporter/1.0 (read-only public capture)',
    javaScriptEnabled: true,
  });
  const page = await context.newPage();
  try {
    // Read-only: only allow top-level document navigation to the intended URL; block nothing else
    // but never interact. (No route blocking needed — we simply never click/type/submit.)
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CFG.timeout });
    const status = resp ? resp.status() : 0;
    if (status >= 400) warnings.push(`http_${status}`);

    // If redirected onto a login/risky page, abort capture (do not capture pages behind login).
    const finalUrl = normalizeUrl(page.url()) || url;
    if (!isCapturable(finalUrl, new URL(url).hostname)) {
      warnings.push('redirected_to_risky_or_offsite');
      return { skipped: true, url, finalUrl, warnings };
    }

    await page.waitForTimeout(400);
    const data = await page.evaluate(extractInPage);

    const shotFile = `${safeName(url)}.png`;
    await page.screenshot({ path: path.join(shotDir, shotFile), fullPage: true, timeout: CFG.timeout });

    // Redact secrets in text + link hrefs.
    data.renderedText = redact(data.renderedText).slice(0, 200000);
    data.links = data.links.map((l) => ({ text: l.text, href: redact(l.href) }));
    data.sections = data.sections.map((s) => ({ ...s, text: redact(s.text) }));

    return {
      skipped: false,
      page: {
        url,
        title: data.title,
        language: data.language,
        metaDescription: data.metaDescription,
        screenshot: `screenshots/${shotFile}`,
        renderedText: data.renderedText,
        headings: data.headings,
        sections: data.sections,
        links: data.links,
        buttons: data.buttons,
        forms: data.forms,
        documents: data.documents,
        warnings,
      },
      links: data.links.map((l) => l.href),
    };
  } finally {
    // Discard the context entirely — nothing persisted.
    await context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------- inputs / resume
function loadInventoryFromIndex(indexPath) {
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const urls = (index.pages || []).map((p) => p.url).filter(Boolean);
  const domain = (index.meta && index.meta.domain) || (urls[0] && new URL(urls[0]).hostname) || '';
  const targetUrl = (index.meta && index.meta.targetUrl) || (urls[0] ? new URL(urls[0]).origin : '');
  return { urls, domain, targetUrl };
}

function loadResume(outFile) {
  if (CFG.force || !fs.existsSync(outFile)) return { done: new Set(), pages: [], failed: [], skipped: [] };
  try {
    const prev = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    return {
      done: new Set((prev.pages || []).map((p) => p.url)),
      pages: prev.pages || [],
      failed: prev.failedPages || [],
      skipped: prev.skippedUrls || [],
    };
  } catch { return { done: new Set(), pages: [], failed: [], skipped: [] }; }
}

// ---------------------------------------------------------------------------- packaging
function buildZip(entries, zipPath) {
  // ponytail: adm-zip builds in memory — fine up to a few hundred MB. For multi-GB
  // captures the split-package path below keeps each zip bounded; stream if that ceiling bites.
  const zip = new AdmZip();
  for (const e of entries) zip.addLocalFile(e.path, e.folder || '');
  zip.writeZip(zipPath);
  return fs.statSync(zipPath).size;
}

function packageCapture(outDir, jsonFile, shotDir) {
  const shots = fs.existsSync(shotDir)
    ? fs.readdirSync(shotDir).map((f) => ({ path: path.join(shotDir, f), folder: 'screenshots', size: fs.statSync(path.join(shotDir, f)).size }))
    : [];
  const total = shots.reduce((s, f) => s + f.size, 0);
  const mainZip = path.join(outDir, 'capture-package.zip');
  const parts = [];

  if (total <= CFG.splitBytes) {
    buildZip([{ path: jsonFile }, ...shots], mainZip);
    return { mainZip, parts, totalBytes: total };
  }

  // Too large: split screenshots into size-bounded parts. part-001 also carries the manifest.
  let chunk = [];
  let chunkBytes = 0;
  let idx = 1;
  const flush = () => {
    if (!chunk.length) return;
    const name = `capture-package-part-${String(idx).padStart(3, '0')}.zip`;
    const zp = path.join(outDir, name);
    const entries = idx === 1 ? [{ path: jsonFile }, ...chunk] : chunk;
    buildZip(entries, zp);
    parts.push(zp);
    idx++; chunk = []; chunkBytes = 0;
  };
  for (const f of shots) {
    if (chunkBytes + f.size > CFG.splitBytes && chunk.length) flush();
    chunk.push(f); chunkBytes += f.size;
  }
  flush();
  // Manifest-only main zip so capture-package.zip always exists.
  buildZip([{ path: jsonFile }], mainZip);
  return { mainZip, parts, totalBytes: total };
}

// ---------------------------------------------------------------------------- main
async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node scripts/export-playwright-capture.js <site-index.json | https://url>');
    process.exit(1);
  }

  let inventory = null;      // fixed list (index mode) or null (crawl mode)
  let domain;
  let targetUrl;
  let originHost;

  if (/^https?:\/\//i.test(input)) {
    targetUrl = normalizeUrl(input);
    if (!targetUrl) { console.error('Invalid URL'); process.exit(1); }
    domain = new URL(targetUrl).hostname;
    originHost = domain;
  } else {
    const abs = path.resolve(input);
    if (!fs.existsSync(abs)) { console.error(`Not found: ${abs}`); process.exit(1); }
    const inv = loadInventoryFromIndex(abs);
    inventory = [...new Set(inv.urls.map((u) => normalizeUrl(u)).filter(Boolean))];
    domain = inv.domain;
    targetUrl = inv.targetUrl || (inventory[0] || '');
    originHost = targetUrl ? new URL(targetUrl).hostname : (inventory[0] ? new URL(inventory[0]).hostname : '');
  }

  const outDir = path.resolve('site-context', host(domain), 'playwright-capture');
  const shotDir = path.join(outDir, 'screenshots');
  const outFile = path.join(outDir, 'playwright-capture.json');
  fs.mkdirSync(shotDir, { recursive: true });

  const resume = loadResume(outFile);
  const pages = [...resume.pages];
  const failedPages = [...resume.failed];
  const skippedUrls = [...resume.skipped];
  const warnings = [];

  // Queue + seen set (dedupe + loop guard). Seed with inventory or the start URL.
  const seen = new Set();
  const queue = [];
  const enqueue = (u) => {
    const n = normalizeUrl(u);
    if (!n || seen.has(n)) return;
    seen.add(n);
    if (!isCapturable(n, originHost)) { skippedUrls.push(n); return; }
    if (resume.done.has(n)) return; // already captured in a prior run
    queue.push(n);
  };

  if (inventory) inventory.forEach(enqueue);
  else enqueue(targetUrl);

  const limit = CFG.maxPages > 0 ? CFG.maxPages : Infinity;
  const crawlMode = !inventory; // only discover new links when given a bare URL

  console.log(`Input        : ${input}`);
  console.log(`Domain       : ${domain}`);
  console.log(`Mode         : ${crawlMode ? 'crawl (discover links)' : 'index inventory'}`);
  console.log(`Max pages    : ${CFG.maxPages === 0 ? 'unlimited' : CFG.maxPages}`);
  console.log(`Workers      : ${CFG.workers}  Headless: ${CFG.headless}`);
  console.log(`Resume       : ${resume.done.size} already captured${CFG.force ? ' (FORCE: re-capturing)' : ''}`);
  console.log(`Output dir   : ${outDir}\n`);

  const browser = await chromium.launch({ headless: CFG.headless });
  let captured = 0;
  let interrupted = false;
  process.on('SIGINT', () => { interrupted = true; console.log('\nStopping after in-flight pages...'); });

  async function worker(id) {
    while (!interrupted) {
      if (pages.length >= limit) return;
      const url = queue.shift();
      if (!url) return;
      try {
        const res = await capturePage(browser, url, shotDir);
        if (res.skipped) {
          skippedUrls.push(url);
        } else {
          pages.push(res.page);
          captured++;
          if (crawlMode) res.links.forEach(enqueue);
          if (captured % 10 === 0) console.log(`  [+] ${pages.length} captured, ${queue.length} queued`);
        }
      } catch (err) {
        failedPages.push({ url, error: redact(err.message) });
        console.log(`  [!] ${url} :: ${err.message}`);
      }
    }
  }

  // Workers pull from a shared queue; in crawl mode the queue grows as links are found.
  const runners = Array.from({ length: CFG.workers }, (_, i) => worker(i));
  await Promise.all(runners);
  // Drain any late-discovered work in crawl mode until the queue empties.
  while (crawlMode && !interrupted && queue.length && pages.length < limit) {
    await Promise.all(Array.from({ length: CFG.workers }, (_, i) => worker(i)));
  }
  await browser.close().catch(() => {});

  const manifest = {
    meta: {
      targetUrl: targetUrl || '',
      domain: host(domain),
      generatedAt: new Date().toISOString(),
      generator: 'export-playwright-capture.js',
      purpose: 'manual_context_generation_package',
      securityMode: 'read_only_public_capture',
    },
    pages,
    coverage: {
      pagesCaptured: pages.length,
      urlsDiscovered: seen.size,
      screenshots: pages.filter((p) => p.screenshot).length,
      links: pages.reduce((s, p) => s + (p.links ? p.links.length : 0), 0),
      forms: pages.reduce((s, p) => s + (p.forms ? p.forms.length : 0), 0),
      documents: pages.reduce((s, p) => s + (p.documents ? p.documents.length : 0), 0),
      failedPages: failedPages.length,
      skippedRiskyUrls: skippedUrls.length,
      warnings,
    },
    failedPages,
    skippedUrls: [...new Set(skippedUrls)],
  };

  fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2));
  console.log(`\nManifest     : ${outFile}`);

  const pkg = packageCapture(outDir, outFile, shotDir);
  console.log(`Package      : ${pkg.mainZip}`);
  if (pkg.parts.length) {
    console.log(`Split parts  : ${pkg.parts.length} (screenshots ${(pkg.totalBytes / 1048576).toFixed(1)} MB > ${(CFG.splitBytes / 1048576).toFixed(0)} MB)`);
    pkg.parts.forEach((p) => console.log(`   - ${p}`));
  }
  console.log(`\nCaptured ${pages.length} | discovered ${seen.size} | failed ${failedPages.length} | skipped ${manifest.skippedUrls.length}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
