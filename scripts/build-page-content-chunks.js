#!/usr/bin/env node
'use strict';

/**
 * build-page-content-chunks.js
 *
 * Split the EXACT page text (page-content.json) into overlapping retrieval chunks.
 * No summarizing, no translation, no LLM — chunks are verbatim substrings of cleanText
 * (whitespace normalized only). Prepares content for a future ASK retrieval step; it is
 * NOT wired into ASK here.
 *
 *   node scripts/build-page-content-chunks.js https://atb.tn
 *
 * Input : site-context/<domain>/page-content.json
 * Output: site-context/<domain>/page-content-chunks.json
 *
 * Options:
 *   --chunk-size <n>   target chunk length in chars (default 900)
 *   --overlap <n>      overlap between adjacent chunks (default 120)
 *   --url <pageUrl>    chunk ONLY this page (quick test)
 *   --force            overwrite an existing page-content-chunks.json
 */

const fs = require('fs');
const path = require('path');

// ── args ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { rootUrl: null, chunkSize: 900, overlap: 120, url: null, force: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--force') args.force = true;
    else if (a === '--chunk-size') args.chunkSize = parseInt(rest[++i], 10) || 900;
    else if (a === '--overlap') args.overlap = parseInt(rest[++i], 10) || 0;
    else if (a === '--url') args.url = rest[++i];
    else if (!a.startsWith('--') && !args.rootUrl) args.rootUrl = a;
  }
  return args;
}

const domainOf = (rootUrl) => new URL(rootUrl).hostname.replace(/^www\./, '');
const normalizeWs = (t) => String(t || '').replace(/\s+/g, ' ').trim();

// ── chunking ──────────────────────────────────────────────────────────────────
// Verbatim char windows with overlap. Windows end on a word boundary when possible so
// chunks don't cut mid-word — the text itself is never altered. Returns string[].
function chunkText(text, size, overlap) {
  const clean = normalizeWs(text);
  if (clean.length <= size) return clean ? [clean] : [];
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      // Back off to the last space in the window so a chunk never ENDS mid-word.
      const sp = clean.lastIndexOf(' ', end);
      if (sp > start + Math.floor(size * 0.5)) end = sp;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    // Next start = overlap back from end, snapped FORWARD to a word boundary so the
    // overlap never BEGINS mid-word. Only the split point moves; wording is exact.
    let next = end - overlap;
    if (next <= start) next = end;
    if (next > 0 && next < clean.length && clean[next - 1] !== ' ') {
      const sp = clean.indexOf(' ', next);
      if (sp !== -1 && sp < end) next = sp + 1;
    }
    start = next > start ? next : end; // always make progress
  }
  return chunks;
}

// Defensive: soft error pages that slipped past extraction must not become chunks.
const ERROR_CHUNK_RE = /Not Found The requested URL|was not found on this server/i;

// Drop chunks shorter than 80 chars UNLESS the page produced only one chunk.
function filterChunks(chunks) {
  if (chunks.length <= 1) return chunks;
  const kept = chunks.filter((c) => c.length >= 80);
  return kept.length ? kept : chunks.slice(0, 1);
}

// ── main ──────────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv);
  if (!args.rootUrl) {
    console.error('Usage: node scripts/build-page-content-chunks.js <rootUrl> [--url <pageUrl>] [--chunk-size n] [--overlap n] [--force]');
    process.exit(1);
  }
  if (args.overlap >= args.chunkSize) {
    console.error(`--overlap (${args.overlap}) must be smaller than --chunk-size (${args.chunkSize}).`);
    process.exit(1);
  }

  const domain = domainOf(args.rootUrl);
  const dir = path.join(__dirname, '..', 'site-context', domain);
  const inFile = path.join(dir, 'page-content.json');
  const outFile = path.join(dir, 'page-content-chunks.json');

  if (!fs.existsSync(inFile)) {
    console.error(`Missing ${path.relative(process.cwd(), inFile)} — run build-page-content.js first.`);
    process.exit(1);
  }
  if (fs.existsSync(outFile) && !args.force) {
    console.error(`Refusing to overwrite existing ${path.relative(process.cwd(), outFile)} — pass --force.`);
    process.exit(1);
  }

  let input;
  try { input = JSON.parse(fs.readFileSync(inFile, 'utf-8')); }
  catch (e) { console.error(`Cannot parse page-content.json: ${e.message}`); process.exit(1); }

  let pages = Array.isArray(input.pages) ? input.pages : [];
  if (args.url) {
    const key = args.url.replace(/#.*$/, '');
    pages = pages.filter((p) => p && String(p.url || '').replace(/#.*$/, '') === key);
    if (pages.length === 0) { console.error(`--url ${args.url} not found in page-content.json.`); process.exit(1); }
  }

  const chunks = [];
  let pagesWithChunks = 0;
  let malformed = 0;
  for (let pi = 0; pi < pages.length; pi++) {
    const p = pages[pi];
    try {
      // sourcePageIndex is the index within the input file (stable), not the filtered slice.
      const sourcePageIndex = args.url ? (input.pages.indexOf(p)) : pi;
      const pieces = filterChunks(chunkText(p && p.cleanText, args.chunkSize, args.overlap))
        .filter((t) => !ERROR_CHUNK_RE.test(t));
      if (pieces.length) pagesWithChunks++;
      pieces.forEach((text, chunkIndex) => {
        chunks.push({
          chunkId: `${sourcePageIndex}-${chunkIndex}`,
          url: p.url || '',
          title: p.title || '',
          language: p.language || '',
          text,
          textLength: text.length,
          sourcePageIndex,
          chunkIndex,
        });
      });
    } catch (e) {
      malformed++;
      console.error(`  skip malformed page[${pi}] ${p && p.url || ''}: ${e && e.message}`);
    }
  }

  const output = {
    domain,
    rootUrl: input.rootUrl || args.rootUrl,
    generatedAt: new Date().toISOString(),
    pageCount: pagesWithChunks,
    chunkCount: chunks.length,
    chunks,
  };

  const tmpFile = `${outFile}.tmp`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmpFile, JSON.stringify(output, null, 2), 'utf-8');
  fs.renameSync(tmpFile, outFile);
  console.log(
    `Wrote ${path.relative(process.cwd(), outFile)} — pageCount=${pagesWithChunks} ` +
    `chunkCount=${chunks.length}${malformed ? ` malformedPages=${malformed}` : ''}`);
}

main();
