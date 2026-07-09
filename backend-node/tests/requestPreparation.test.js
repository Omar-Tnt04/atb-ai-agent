'use strict';
// Request preparation — normalization + one-shot embedding.
// Run: node backend-node/tests/requestPreparation.test.js   (needs Ollama+bge-m3 for embed asserts)
require('dotenv').config();
const assert = require('assert');
const { prepareUserRequest } = require('../src/services/requestPreparation.service');

(async () => {
  // A1 — French normalizes + detects fr (no embedding needed).
  const fr = await prepareUserRequest({ message: "Je veux payer un commerçant à ATB", enableEmbedding: false });
  assert.strictEqual(fr.detectedLanguage, 'fr', 'FR detected');
  assert.ok(!/[À-ÿ]/.test(fr.normalizedText), 'accents folded in normalizedText');
  assert.strictEqual(fr.embedding, null, 'no embedding when disabled');

  // A2 — English detects en.
  const en = await prepareUserRequest({ message: 'What documents are needed for an account?', enableEmbedding: false });
  assert.strictEqual(en.detectedLanguage, 'en', 'EN detected');

  // A3 — embedding computed once when enabled (single 1024-d vector).
  const emb = await prepareUserRequest({ message: 'ATB PAY QR code', enableEmbedding: true });
  assert.strictEqual(emb.embeddingOk, true, 'embeddingOk true');
  assert.ok(Array.isArray(emb.embedding) && emb.embedding.length > 0, 'embedding is a vector');

  // A4 — embedding failure does not crash (invalid model → embeddingOk false).
  const prevModel = process.env.ASK_EMBEDDING_MODEL;
  process.env.ASK_EMBEDDING_MODEL = 'definitely-not-a-real-model:v0';
  const bad = await prepareUserRequest({ message: 'test resilience', enableEmbedding: true });
  process.env.ASK_EMBEDDING_MODEL = prevModel;
  assert.strictEqual(bad.embeddingOk, false, 'embeddingOk false on bad model');
  assert.ok(bad.embeddingError, 'embeddingError set');
  assert.ok(typeof bad.normalizedText === 'string' && bad.normalizedText.length > 0, 'still normalized despite embed failure');

  console.log('requestPreparation: all assertions passed');
})().catch((e) => { console.error('requestPreparation FAILED:', e.message); process.exit(1); });
