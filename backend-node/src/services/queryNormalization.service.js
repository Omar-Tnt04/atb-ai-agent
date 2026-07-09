'use strict';
/**
 * GENERIC QUERY NORMALIZATION — no banking glossary, no per-question rules.
 * Pure text cleanup + lightweight language detection (fr | en | unknown).
 * Embedding retrieval handles typos/synonyms; this only cleans and labels.
 */

// French-only accented letters + a few frequent function words are the strongest
// generic FR signal; a small English function-word set is the EN signal. No content
// words, no domain terms — this stays generic across any site.
const FR_WORDS = new Set([
  'je', 'tu', 'vous', 'nous', 'le', 'la', 'les', 'des', 'une', 'un', 'du', 'au', 'aux',
  'que', 'qui', 'quel', 'quels', 'quelle', 'quelles', 'pour', 'avec', 'dans', 'sur', 'est',
  'sont', 'comment', 'pourquoi', 'ou', 'où', 'dois', 'avant', 'aller', 'chez', 'mes', 'mon',
  'ma', 'ce', 'cette', 'quoi', 'combien', 'puis', 'peux', 'veux', 'faire', 'y',
]);
const EN_WORDS = new Set([
  'the', 'what', 'which', 'who', 'where', 'when', 'why', 'how', 'is', 'are', 'do', 'does',
  'can', 'i', 'you', 'my', 'a', 'an', 'of', 'for', 'to', 'and', 'with', 'need', 'needed',
  'want', 'about', 'available', 'should',
]);

function foldAccents(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Generic cleanup: lowercase, normalize apostrophes, strip punctuation, collapse spaces. */
function cleanText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’‘‛`´]/g, "'")            // normalize apostrophe variants
    .replace(/\bd'|\bl'|\bqu'|\bj'|\bn'|\bs'|\bc'|\bm'|\bt'/g, ' ') // FR elisions → split
    .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ') // drop punctuation, keep letters/digits/hyphen
    .replace(/\s+/g, ' ')
    .trim();
}

function detectLanguage(cleanedTokens, hasAccents) {
  let fr = hasAccents ? 1 : 0;
  let en = 0;
  for (const t of cleanedTokens) {
    if (FR_WORDS.has(t)) fr++;
    if (EN_WORDS.has(t)) en++;
  }
  if (fr === 0 && en === 0) return { language: 'unknown', fr, en };
  if (fr > en) return { language: 'fr', fr, en };
  if (en > fr) return { language: 'en', fr, en };
  // tie → accents break it toward fr, else unknown
  return { language: hasAccents ? 'fr' : 'unknown', fr, en };
}

/**
 * @returns {{originalQuestion, normalizedQuestion, detectedLanguage, responseLanguage, tokens, debug}}
 * - normalizedQuestion: cleaned + accent-folded (for keyword fallback / tokens)
 * - responseLanguage: language qwen should answer in (unknown → mirror user; default 'en')
 */
function normalizeQuery(question) {
  const originalQuestion = String(question || '');
  const cleaned = cleanText(originalQuestion);              // accents kept
  const hasAccents = cleaned !== foldAccents(cleaned);
  const normalizedQuestion = foldAccents(cleaned);          // accents folded
  const tokens = normalizedQuestion.split(' ').filter((t) => t.length >= 2);
  const { language, fr, en } = detectLanguage(tokens, hasAccents);
  const detectedLanguage = language;
  const responseLanguage = detectedLanguage === 'unknown' ? 'en' : detectedLanguage;
  return {
    originalQuestion,
    normalizedQuestion,
    detectedLanguage,
    responseLanguage,
    tokens,
    debug: { hasAccents, frScore: fr, enScore: en, cleaned },
  };
}

module.exports = { normalizeQuery, cleanText, foldAccents };
