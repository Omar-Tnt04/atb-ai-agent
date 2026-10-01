'use strict';
/**
 * warm-demo.js — pre-load the Ollama models so the FIRST demo request is not cold.
 *
 * IMPORTANT (VRAM ceiling): the ASK synthesis model (qwen3:14b, ~9GB) and the ACT intent
 * model (gemma4:e4b, ~9GB) do NOT co-reside in VRAM — loading one evicts the other, even
 * with keep_alive set. So warm ONE mode at a time. Default warms the ASK path (bge + qwen).
 *
 *   node backend-node/scripts/warm-demo.js        # warm ASK (bge-m3 + qwen3:14b)
 *   node backend-node/scripts/warm-demo.js act    # warm ACT (bge-m3 + gemma4:e4b)
 *
 * Warm the mode you will START the demo with. bge-m3 is small and co-resides with either.
 * Reads the same env as the services (OLLAMA_BASE_URL, ASK_EMBEDDING_MODEL,
 * ASK_SYNTHESIS_MODEL, INTENT_MODEL, OLLAMA_KEEP_ALIVE).
 */
require('dotenv').config();
const http = require('http');

const BASE = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';
const EMBED_MODEL = process.env.ASK_EMBEDDING_MODEL || 'bge-m3';
const mode = String(process.argv[2] || 'ask').toLowerCase();
// ponytail: one chat model per run — qwen and gemma can't co-reside in VRAM (see header).
const CHAT_MODELS = mode === 'act'
  ? [process.env.INTENT_MODEL || process.env.OLLAMA_MODEL || 'gemma4:e4b']
  : [process.env.ASK_SYNTHESIS_MODEL || 'qwen3:14b'];

function post(pathname, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, BASE);
    const req = http.request({
      hostname: u.hostname, port: parseInt(u.port || '80', 10), path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)); });
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function warm(label, fn) {
  const t = Date.now();
  try { await fn(); console.log(`  ✓ ${label} warm in ${((Date.now() - t) / 1000).toFixed(1)}s`); }
  catch (e) { console.log(`  ✗ ${label} FAILED: ${e.message}`); process.exitCode = 1; }
}

(async () => {
  console.log(`Warming ${mode.toUpperCase()} path at ${BASE} (keep_alive=${KEEP_ALIVE})`);
  await warm(`embed ${EMBED_MODEL}`, () =>
    post('/api/embed', { model: EMBED_MODEL, input: 'warmup', keep_alive: KEEP_ALIVE }));
  for (const model of CHAT_MODELS) {
    await warm(`chat ${model}`, () =>
      post('/api/chat', {
        model,
        messages: [{ role: 'user', content: 'ok' }],
        stream: false, keep_alive: KEEP_ALIVE, options: { num_predict: 1 },
      }));
  }
  console.log('Done. Models resident — first demo request will be fast.');
})();
