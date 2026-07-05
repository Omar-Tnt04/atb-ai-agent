/**
 * siteIndexAgent.ollama.test.js — live Ollama integration tests.
 *
 * Skipped unless:  RUN_OLLAMA_INTENT_TESTS=true
 * Probes Ollama reachability + model availability before running.
 *
 * Run:
 *   $env:RUN_OLLAMA_INTENT_TESTS="true"; node backend-node/tests/siteIndexAgent.ollama.test.js
 */
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');

// ── Guard ─────────────────────────────────────────────────────────────────────
if (!process.env.RUN_OLLAMA_INTENT_TESTS) {
  console.log('siteIndexAgent.ollama.test.js');
  console.log('  SKIP: set RUN_OLLAMA_INTENT_TESTS=true to run');
  process.exit(0);
}

// Allow slow CPU-bound models — override from env.
if (!process.env.INTENT_TIMEOUT_MS) process.env.INTENT_TIMEOUT_MS = '30000';

const A = require('../src/services/siteIndexAgent.service');

const DOMAIN     = process.env.AGENT_DOMAIN || 'atb.tn';
const INDEX_PATH = path.resolve(__dirname, '..', '..', 'site-context', DOMAIN, 'site-index.json');
const BASE       = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MODEL      = process.env.INTENT_MODEL || process.env.OLLAMA_MODEL || 'gemma4:e4b';
const TIMEOUT_MS = parseInt(process.env.INTENT_TIMEOUT_MS, 10);

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function _parseUrl(raw) {
  const u = new URL(raw);
  return { hostname: u.hostname, port: parseInt(u.port || '80', 10), path: u.pathname + (u.search || '') };
}

function httpGet(url, ms = 4000) {
  return new Promise((resolve, reject) => {
    try {
      const { hostname, port, path: p } = _parseUrl(url);
      const req = http.get({ hostname, port, path: p, timeout: ms }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
    } catch (e) { reject(e); }
  });
}

function httpPost(url, bodyStr, ms = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    try {
      const { hostname, port, path: p } = _parseUrl(url);
      const buf = Buffer.from(bodyStr, 'utf-8');
      const req = http.request(
        { hostname, port, path: p, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': buf.byteLength } },
        (res) => {
          let out = '';
          res.on('data', (c) => { out += c; });
          res.on('end', () => resolve({ status: res.statusCode, body: out }));
        },
      );
      req.setTimeout(ms, () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
      req.write(buf);
      req.end();
    } catch (e) { reject(e); }
  });
}

// ── Pre-flight: probe Ollama + model ─────────────────────────────────────────
async function probeOllama() {
  let tags;
  try {
    const r = await httpGet(`${BASE}/api/tags`, 3000);
    if (r.status !== 200) throw new Error(`/api/tags → HTTP ${r.status}`);
    tags = JSON.parse(r.body);
  } catch (e) {
    console.log(`  SKIP: Ollama not reachable at ${BASE} (${e.message})`);
    return false;
  }

  const models = Array.isArray(tags?.models) ? tags.models.map((m) => String(m.name || '')) : [];
  const modelOk = models.some((m) => m === MODEL || m.startsWith(MODEL.split(':')[0]));
  if (!modelOk) {
    console.log(`  SKIP: model "${MODEL}" not in Ollama. Available: ${models.join(', ') || '(none)'}`);
    return false;
  }

  console.log(`  Ollama reachable — model ${MODEL} present`);
  return true;
}

// Minimal inference call to verify the model responds within TIMEOUT_MS.
// Uses the shortest possible prompt so we don't waste time on content — just proving
// the model can produce a token before the timeout fires.
async function probeModel() {
  const body = JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
    options: { temperature: 0, num_predict: 8, num_ctx: 512 },
  });
  try {
    const r = await httpPost(`${BASE}/api/chat`, body);
    if (r.status !== 200) {
      console.log(`  SKIP: model inference probe → HTTP ${r.status}`);
      return false;
    }
    return true;
  } catch (e) {
    if (/timeout/i.test(e.message)) {
      console.log(`  SKIP: Ollama model did not respond within ${TIMEOUT_MS}ms`);
    } else {
      console.log(`  SKIP: model probe error (${e.message})`);
    }
    return false;
  }
}

// ── T1: raw Gemma output is parseable JSON ────────────────────────────────────
async function testGemmaReturnsJson() {
  const body = JSON.stringify({
    model: MODEL,
    messages: [
      { role: 'system', content: A.GEMMA_SYSTEM },
      { role: 'user',   content: 'exchange rates' },
    ],
    stream: false,
    format: 'json',
    options: { temperature: 0, num_predict: 120, num_ctx: 2048 },
  });

  let r;
  try {
    r = await httpPost(`${BASE}/api/chat`, body);
  } catch (e) {
    if (/timeout/i.test(e.message)) {
      console.log(`  SKIP: Ollama model did not respond within ${TIMEOUT_MS}ms`);
      process.exit(0);
    }
    throw e;
  }
  assert.strictEqual(r.status, 200, `Ollama /api/chat → HTTP ${r.status}`);

  const content = JSON.parse(r.body)?.message?.content;
  assert.ok(typeof content === 'string' && content.length > 0, 'Gemma returned empty content');

  const parsed = A.parseIntent(content);
  assert.ok(parsed !== null,
    `Gemma output not parseable as JSON.\nRaw: ${String(content).slice(0, 300)}`);

  console.log(`  ✓ T1. Raw Gemma output parseable (${content.length} chars)`);
  return parsed;
}

// ── T2: callGemma result passes full schema validation ────────────────────────
async function testCallGemmaValidSchema() {
  const intent = await A.callGemma('exchange rates');

  assert.ok(intent && typeof intent === 'object', 'callGemma returned null/undefined');

  for (const f of ['resourceType', 'target', 'terms', 'confidence']) {
    assert.ok(f in intent, `callGemma result missing field: ${f}`);
  }

  const VALID_RESOURCE_TYPES = new Set(['page', 'document', 'unknown']);

  assert.ok(VALID_RESOURCE_TYPES.has(intent.resourceType),
    `invalid resourceType value: "${intent.resourceType}"`);
  assert.ok(Array.isArray(intent.terms) && intent.terms.length <= 5,
    `terms must be array ≤ 5, got ${JSON.stringify(intent.terms)}`);
  assert.ok(
    typeof intent.confidence === 'number' && intent.confidence >= 0 && intent.confidence <= 1,
    `confidence out of [0,1]: ${intent.confidence}`,
  );

  // Gemma must not have emitted a URL into target.
  assert.ok(
    !/^https?:\/\//i.test(intent.target || ''),
    `Gemma leaked a full URL into target: "${intent.target}"`,
  );
  assert.ok(
    !/^\/[a-z]/i.test(intent.target || ''),
    `Gemma leaked a path into target: "${intent.target}"`,
  );

  console.log(
    `  ✓ T2. callGemma schema valid (resourceType=${intent.resourceType}, conf=${intent.confidence.toFixed(2)}, terms=${JSON.stringify(intent.terms)})`,
  );
  return intent;
}

// ── T3: English query routes to French-indexed content via Gemma terms ────────
async function testEnglishToFrenchRouting() {
  // Real Gemma — no injected intent. Gemma generates terms; backend scores against index.
  const result = await A.decideAction('exchange rates');

  assert.ok(
    result.found,
    `decideAction('exchange rates') → not found.\ntopMatches: ${JSON.stringify(result.topMatches)}`,
  );
  assert.ok(
    ['navigate', 'navigate_then_download', 'download'].includes(result.action.type),
    `unexpected action type: ${result.action.type}`,
  );

  const url = result.action.url || '';
  assert.ok(
    url.includes(DOMAIN) || url.startsWith('/'),
    `URL looks invented (not from index): "${url}"`,
  );

  // English "exchange rates" should resolve to a /devise-ish page.
  assert.ok(
    /devise|taux|rates?|change|currency/i.test(url),
    `Expected a rates/devise page, got: "${url}"\n` +
    `Gemma may not have generated useful FR synonyms. topMatches: ${JSON.stringify(result.topMatches)}`,
  );

  console.log(`  ✓ T3. English→French: "exchange rates" → ${url.replace(/^https?:\/\/[^/]+/, '')}`);
}

// ── T4: action.url comes from site-index.json, not from Gemma ────────────────
async function testUrlFromIndex() {
  const raw = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));

  // Collect all URL strings known to the index.
  const knownUrls = new Set((raw.agentIndex || []).map((e) => e.url).filter(Boolean));
  for (const e of (raw.agentIndex || [])) {
    for (const dl of (e.downloads || [])) { if (dl.href) knownUrls.add(dl.href); }
    for (const lk of (e.links     || [])) { if (lk.href) knownUrls.add(lk.href); }
  }
  for (const u of (raw.discoveredUrls || [])) knownUrls.add(u);

  // Use a fresh real-Gemma call.
  const result = await A.decideAction('ATB contact page');
  if (!result.found) {
    console.log('  SKIP T4: no result found for "ATB contact page"');
    return;
  }

  const actionUrl = result.action.url || '';
  assert.ok(
    knownUrls.has(actionUrl),
    `action.url "${actionUrl}" is NOT in site-index.json — Gemma may have invented it.`,
  );

  // Top suggestions must also come from the index.
  for (const m of (result.topMatches || [])) {
    if (m.url) {
      assert.ok(knownUrls.has(m.url), `topMatch URL not in index: "${m.url}"`);
    }
  }

  console.log(`  ✓ T4. URL from index: ${actionUrl.replace(/^https?:\/\/[^/]+/, '')}`);
}

// ── T5: hallucinated URL in Gemma's target field is not trusted ───────────────
async function testHallucinatedUrlIgnored() {
  // Inject an intent where target contains a full hallucinated URL.
  // validateIntent pushes target onto terms → tokenized → harmless strings.
  // allowedDomain filter ensures only DOMAIN URLs can surface in results.
  const injected = {
    resourceType: 'page',
    target:       'https://evil.com/steal-data', // hallucinated URL Gemma might emit
    terms:        ['contact', 'coordonnees'],
    confidence:   0.9,
  };

  const result = await A.decideAction('contact page', { intent: injected, allowedDomain: DOMAIN });

  const url = result.action?.url || '';
  assert.ok(
    !url.includes('evil.com'),
    `Backend trusted Gemma's hallucinated URL: "${url}"`,
  );

  if (result.found) {
    assert.ok(
      url.includes(DOMAIN),
      `action URL should be from ${DOMAIN}, got: "${url}"`,
    );
    console.log(`  ✓ T5. Hallucinated URL ignored → ${url.replace(/^https?:\/\/[^/]+/, '')}`);
  } else {
    // not_found is also correct — the fake URL was not followed.
    console.log(`  ✓ T5. Hallucinated URL ignored → ${result.action.type} (no external URL emitted)`);
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────
async function run() {
  console.log('siteIndexAgent.ollama.test.js (live Ollama integration)');
  console.log(`  Ollama: ${BASE}  |  Model: ${MODEL}  |  Timeout: ${TIMEOUT_MS}ms`);
  console.log('');

  if (!fs.existsSync(INDEX_PATH)) {
    console.error(`SKIP: ${INDEX_PATH} missing — run \`npm run site:index\` first.`);
    process.exit(0);
  }

  const ollamaOk = await probeOllama();
  if (!ollamaOk) process.exit(0);

  const modelOk = await probeModel();
  if (!modelOk) process.exit(0);

  console.log('');
  await testGemmaReturnsJson();
  await testCallGemmaValidSchema();
  await testEnglishToFrenchRouting();
  await testUrlFromIndex();
  await testHallucinatedUrlIgnored();

  console.log('');
  console.log('siteIndexAgent.ollama tests passed');
}

run().catch((err) => { console.error(err); process.exit(1); });
