'use strict';
const assert = require('node:assert/strict');
const { buildAskContext, chunks } = require('../build-ask-context');
const text = 'Fresh evidence from the updated page. '.repeat(90).trim();
const page = { url: 'https://example.com/new', title: 'Updated service', language: 'en',
  cleanText: text, contentQuality: { hasMainContent: true, confidence: 0.9 } };
const crawl = { meta: { targetUrl: 'https://example.com', generatedAt: '2026-09-17T00:00:00Z' },
  pages: [page, page, { ...page, url: 'https://example.com/empty', cleanText: '' }], failedUrls: [] };
const { ask, exact } = buildAskContext(crawl);
assert.equal(exact.exactBlocks.length, 1);
assert.equal(exact.exactBlocks[0].exactText.cleanText, text);
assert.equal(ask.contextBlocks.map(b => b.richContext).join(' '), text);
assert(ask.contextBlocks.every(b => b.richContext.length <= 1000 && b.url === page.url));
assert.equal(new Set(ask.contextBlocks.map(b => b.id)).size, ask.contextBlocks.length);
assert.equal(ask.meta.generatedAt, crawl.meta.generatedAt);
assert.throws(() => buildAskContext({ ...crawl, failedUrls: [{ url: page.url }] }), /failed crawl/);
assert.throws(() => buildAskContext({ ...crawl, pages: [] }), /nonempty/);
assert.throws(() => buildAskContext({ ...crawl, meta: { ...crawl.meta, status: 'partial' } }), /partial crawl/);
const partial = buildAskContext({ ...crawl, meta: { ...crawl.meta, status: 'partial' }, failedUrls: [{ url: 'https://example.com/unavailable', error: 'HTTP 500' }] }, { allowPartial: true });
assert.equal(partial.ask.meta.status, 'partial');
assert.equal(partial.ask.meta.excludedUrls[0].error, 'HTTP 500');
assert.equal(chunks('x'.repeat(2500)).join('').length, 2500);
console.log('PASS: fresh ASK schemas, provenance, deduplication, complete chunk coverage, failed-crawl protection.');
