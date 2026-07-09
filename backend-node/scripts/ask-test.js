#!/usr/bin/env node
'use strict';
/*
 * Terminal ask-mode diagnostic client.
 * Hits the widget /chat endpoint in ask mode with debug:true and prints a compact
 * trace. The backend only attaches debugTrace when body.debug:true OR ASK_DEBUG_TRACE=true.
 *
 * Usage:
 *   node backend-node/scripts/ask-test.js "What documents are needed for an SME business account?"
 *   node backend-node/scripts/ask-test.js "..." --json     # full raw JSON
 *
 * Env: WIDGET_BASE_URL (default http://localhost:5000)
 */
const http = require('http');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const question = args.filter((a) => !a.startsWith('--')).join(' ').trim();
if (!question) {
  console.error('usage: node scripts/ask-test.js "question" [--json]');
  process.exit(1);
}

const BASE = process.env.WIDGET_BASE_URL || 'http://localhost:5000';
const body = JSON.stringify({ mode: 'ask', message: question, debug: true });
const u = new URL('/api/widget/chat', BASE);

const req = http.request({
  hostname: u.hostname,
  port: u.port || 80,
  path: u.pathname,
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
}, (res) => {
  let buf = '';
  res.on('data', (c) => { buf += c; });
  res.on('end', () => {
    let j;
    try { j = JSON.parse(buf); } catch { console.log(buf); return; }
    if (flags.has('--json')) { console.log(JSON.stringify(j, null, 2)); return; }

    const answer = j.assistantMessage || (j.data && j.data.ai) || '(no answer field)';
    const t = j.debugTrace;
    console.log(`\nquestion:\n${question}\n\nanswer:\n${answer}`);

    const src = t
      ? [
          ...t.retrieval.askContext.matches.map((m) => `ask-context:${m.id}~${(m.score || 0).toFixed(2)}`),
          ...t.retrieval.catalog.matches.map((m) => `catalog:${m.id}~${(m.score || 0).toFixed(2)}`),
        ]
      : [];
    console.log(`\nsources:\n${src.length ? src.join('\n') : '(none)'}`);

    if (t) {
      const qn = t.queryNormalization || {};
      const sr = t.semanticRetrieval || {};
      const rp = t.requestPreparation || {};
      console.log('\ntrace:');
      console.log(`finalPath: ${t.finalPath}`);
      console.log(`requestPreparation: lang=${rp.detectedLanguage || '?'}->${rp.responseLanguage || '?'} model=${rp.embeddingModel || '?'} embeddingOk=${!!rp.embeddingOk} computedOnce=${!!rp.embeddingComputedOnce}`);
      console.log(`queryLanguage: ${qn.detectedLanguage || '?'} -> answerLanguage: ${qn.responseLanguage || '?'}`);
      console.log(`semanticEnabled: ${!!sr.enabled}  reusedPreparedEmbedding: ${!!sr.reusedPreparedEmbedding}  indexBuilt: ${!!sr.indexBuilt}  chunkCount: ${sr.chunkCount || 0}`);
      if (sr.enabled) {
        console.log(`semanticFallbackUsed: ${!!sr.fallbackUsed}${sr.failedReason ? ` (${sr.failedReason})` : ''}`);
        const tm = (sr.topMatches || []).slice(0, 6)
          .map((m) => `  ${m.sourceType}:${m.sourceId}~${(m.score || 0).toFixed(3)} ${m.title || ''}`.trimEnd());
        console.log(`semanticTopMatches:\n${tm.join('\n') || '  (none)'}`);
      }
      console.log(`askContextMatches: ${t.retrieval.askContext.matches.length}`);
      console.log(`catalogMatches: ${t.retrieval.catalog.matches.length}`);
      console.log(`qwenCalled: ${t.synthesis.called}`);
      console.log(`synthesisSuccess: ${t.synthesis.success}`);
      console.log(`fallbackUsed: ${t.synthesis.fallbackUsed}`);
      console.log(`guardRejected: ${t.synthesis.guardRejected}`);
      console.log(`failedReason: ${t.synthesis.failedReason || '(none)'}`);
      console.log(`charsSentToModel: ${t.selectedEvidence.totalCharsSentToModel}`);
      console.log(`actionDeflection: ${t.actionDeflection.triggered}${t.actionDeflection.triggered ? ` (${t.actionDeflection.matchedPattern})` : ''}`);
    } else {
      console.log('\ntrace:\n(no debugTrace — restart the backend so the trace build loads)');
    }
    console.log('');
  });
});
req.on('error', (e) => { console.error('request failed:', e.message); process.exit(1); });
req.write(body);
req.end();
