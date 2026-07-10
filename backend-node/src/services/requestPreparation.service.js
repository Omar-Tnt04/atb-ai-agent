'use strict';
/**
 * REQUEST PREPARATION — one normalization + one bge-m3 embedding per user request.
 * ------------------------------------------------------------------------------
 * Common step BEFORE the ASK/ACT branch. Normalizes the message once (generic cleanup
 * + language detection via queryNormalization.service — no glossary, no per-question
 * rules) and computes ONE query embedding that both ASK semantic retrieval and ACT
 * semantic navigation reuse. Never throws: on embedding failure it returns
 * embeddingOk:false so callers fall back to keyword/deterministic paths.
 */

const { normalizeQuery } = require('./queryNormalization.service');
const { embed } = require('./semanticRetrieval.service');
const { targetDomain } = require('./askContext.service');

const embedModel = () =>
  process.env.ASK_EMBEDDING_MODEL || process.env.ACT_EMBEDDING_MODEL || 'bge-m3';

const flagOn = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));

/**
 * @returns {{originalText, normalizedText, detectedLanguage, responseLanguage,
 *            embedding:number[]|null, embeddingModel, embeddingOk, embeddingError, debug}}
 */
async function prepareUserRequest({ message, domain = targetDomain(), modeHint = null, enableEmbedding } = {}) {
  const norm = normalizeQuery(message);
  const wantEmbed = enableEmbedding != null ? enableEmbedding : flagOn(process.env.REQUEST_PREPARE_EMBEDDING);

  const prepared = {
    originalText: norm.originalQuestion,
    normalizedText: norm.normalizedQuestion,
    detectedLanguage: norm.detectedLanguage,
    responseLanguage: norm.responseLanguage,
    embedding: null,
    embeddingModel: embedModel(),
    embeddingOk: false,
    embeddingError: '',
    embedMs: 0,
    debug: { ...(norm.debug || {}), modeHint, domain, wantEmbed },
  };

  if (!wantEmbed || !norm.originalQuestion.trim()) return prepared;

  const _embedStart = Date.now();
  try {
    // Embed the ORIGINAL text (accents kept) so the vector matches the ASK/ACT chunk
    // embeddings and the standalone retrieve() path exactly.
    const [vec] = await embed(norm.originalQuestion);
    if (Array.isArray(vec) && vec.length) {
      prepared.embedding = vec;
      prepared.embeddingOk = true;
    } else {
      prepared.embeddingError = 'empty_embedding';
    }
  } catch (e) {
    prepared.embeddingError = /timeout/i.test(e && e.message) ? 'embed_timeout' : 'embed_failed';
  }
  prepared.embedMs = Date.now() - _embedStart;
  return prepared;
}

module.exports = { prepareUserRequest };
