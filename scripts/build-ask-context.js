#!/usr/bin/env node
'use strict';

// Convert a reviewed rendered crawl into the schemas consumed by ASK retrieval.
// No model-generated facts or stale curated text are carried into a refresh.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isCrawlable } = require('./build-site-context');

function chunks(text, size = 1000) {
  const result = [];
  let rest = String(text || '').trim();
  while (rest.length > size) {
    let end = rest.lastIndexOf(' ', size);
    if (end < size / 2) end = size;
    result.push(rest.slice(0, end));
    rest = rest.slice(end).trim();
  }
  if (rest) result.push(rest);
  return result;
}

function buildAskContext(crawl, { allowPartial = false } = {}) {
  if (!crawl.meta?.generatedAt || !crawl.pages?.length) throw new Error('A nonempty rendered crawl is required');
  const partial = crawl.meta.status === 'partial' || crawl.failedUrls?.some(failure => !/^HTTP (404|410)$/.test(failure.error));
  if (!allowPartial && crawl.failedUrls?.some(failure => !/^HTTP (404|410)$/.test(failure.error))) throw new Error('Resolve failed crawl URLs before publishing ASK context');
  if (!allowPartial && crawl.meta.status === 'partial') throw new Error('Complete the partial crawl before publishing ASK context');
  const seen = new Set();
  const contextBlocks = [];
  const exactBlocks = [];
  for (const page of crawl.pages) {
    if (!isCrawlable(page.url, new URL(crawl.meta.targetUrl).hostname)) continue;
    if (seen.has(page.url)) continue;
    seen.add(page.url);
    if (!page.contentQuality?.hasMainContent || !page.cleanText?.trim()) continue;
    const id = crypto.createHash('sha256').update(page.url).digest('hex').slice(0, 16);
    const common = {
      type: 'page', url: page.url, title: page.title, language: page.language,
      confidence: page.contentQuality.confidence,
      // Leave room for the evidence itself in the backend's 1,500-character embedding cap.
      usefulForQuestionsAbout: [page.title, ...(page.headings || [])].filter(Boolean).slice(0, 3).map(text => text.slice(0, 64)),
    };
    const pieces = chunks(page.cleanText);
    for (const [index, text] of pieces.entries()) {
      contextBlocks.push({
        ...common, id: `${id}-${index}`, richContext: text, promptText: text,
        keyPoints: [], documents: page.documents || [], forms: page.forms || [],
      });
    }
    exactBlocks.push({
      ...common, id, sourceContextId: `${id}-0`, sourceConfidence: common.confidence,
      exactText: { cleanText: page.cleanText, textLength: page.cleanText.length,
        source: 'rendered-html', indexedAt: crawl.meta.generatedAt },
      exactChunks: pieces.map((text, index) => ({ chunkId: `${id}-${index}`, text,
        textLength: text.length, chunkIndex: index })),
    });
  }
  if (!contextBlocks.length) throw new Error('No usable main content; existing runtime context must be preserved');
  const meta = {
    version: '1.0', targetUrl: crawl.meta.targetUrl,
    domain: new URL(crawl.meta.targetUrl).hostname.replace(/^www\./, ''),
    generatedAt: crawl.meta.generatedAt, generator: 'build-ask-context',
    sourceFile: 'context.json', pages: exactBlocks.length,
    status: partial ? 'partial' : 'complete',
    excludedUrls: crawl.failedUrls || [],
  };
  return {
    ask: { meta: { ...meta, purpose: 'ask_mode_context' }, contextBlocks },
    exact: { meta: { ...meta, purpose: 'ask_exact_context' }, exactBlocks },
  };
}

if (require.main === module) {
  try {
    const [input, output] = process.argv.slice(2);
    if (!input || !output) throw new Error('Usage: node scripts/build-ask-context.js <context.json> <output-directory>');
    const { ask, exact } = buildAskContext(JSON.parse(fs.readFileSync(input, 'utf8')), { allowPartial: process.argv.includes('--allow-partial') });
    fs.mkdirSync(output, { recursive: true });
    for (const [name, value] of [['ask-context.json', ask], ['ask-exact-context.json', exact]]) {
      const destination = path.join(output, name);
      fs.writeFileSync(`${destination}.tmp`, JSON.stringify(value, null, 2) + '\n');
      fs.renameSync(`${destination}.tmp`, destination);
    }
    console.log(`Built ${ask.contextBlocks.length} ASK chunks from ${exact.exactBlocks.length} rendered pages.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { buildAskContext, chunks };
