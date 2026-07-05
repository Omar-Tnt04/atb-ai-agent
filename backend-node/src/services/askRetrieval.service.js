'use strict';
/**
 * Ask mode retrieval pipeline — source-type fit scorer.
 *
 * Classifies a user query into a source type so that Ask mode can:
 *  - Answer contact/address queries directly from static facts (no catalog)
 *  - Redirect form/document/site-navigation queries to Act mode
 *  - Pass catalog/product/branch/general queries through to handleChatMessage
 *
 * Add a new entry to SOURCE_TYPE_PATTERNS to extend coverage.
 */

const SOURCE_TYPES = {
  CONTACT_FACTS:    'contact_facts',
  BRANCH_DIRECTORY: 'branch_directory',
  CATALOG_PRODUCT:  'catalog',
  WEBSITE_PAGE:     'website_page',
  DOCUMENT_INDEX:   'document_index',
  GENERAL:          'general',
};

// Static ATB contact facts — authoritative public info, rarely changes.
const ATB_CONTACT_FACTS = {
  headOffice:    '9 Rue Hédi Nouira, 1001 Tunis',
  phoneStandard: '71 351 155',
  phoneCRC:      '+216 70 026 267',
};

// Fold accents (NFD) so French matches ASCII patterns generically:
// "médiateur" → "mediateur", "téléphone" → "telephone". Not a per-word table.
const _norm = (text) =>
  String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[_\-'`]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Patterns ordered by specificity: first match wins.
const SOURCE_TYPE_PATTERNS = [
  {
    // ATB public contact info — phone/address ADJACENT to "ATB"/"bank", or standalone "head office".
    // Requires ATB-proximity so "phone on my profile" or "support phone for branches" do NOT match.
    sourceType: SOURCE_TYPES.CONTACT_FACTS,
    pattern: /\b(atb|bank).{0,25}\b(phone|tel|number|address|adresse|email|contact|reach|locate)\b|\b(phone|tel|number|address|adresse|email|contact|reach).{0,25}\b(atb|bank)\b|\b(head\s+office|siege\s+social|siege|headquarter|atb\s+hotline)\b/i,
    confidence: 0.90,
  },
  {
    // Form/PDF/subscription — requires site navigation → redirect to Act.
    sourceType: SOURCE_TYPES.DOCUMENT_INDEX,
    pattern: /\b(messenger\s+form|abonnement\s+messenger|t[eé]l[eé]charger|formulaire|form\b|pdf\b|subscription form|subscribe\s+form)\b/i,
    confidence: 0.85,
  },
  {
    // Browser simulator / calculator tool — requires site navigation → redirect to Act.
    sourceType: SOURCE_TYPES.WEBSITE_PAGE,
    pattern: /\b(simulator|simulateur|calculat(or|rice|eur)|credit simulator|simulateur\s+cr[eé]dit)\b/i,
    confidence: 0.80,
  },
  {
    // Branch / agency directory — catalog will handle (branch_directory resource).
    sourceType: SOURCE_TYPES.BRANCH_DIRECTORY,
    pattern: /\b(branch|branches|agency|agencies|agence|agences|nearest\s+branch|closest\s+branch|opening hours|horaires)\b/i,
    confidence: 0.85,
  },
  {
    // Named ATB product / service info — catalog will handle.
    sourceType: SOURCE_TYPES.CATALOG_PRODUCT,
    pattern: /\b(atb\s+connect|atb\s+messenger|atb\s+(?:mobile|digital)|connect\s+activ|cr[eé]dit|loan|produit|product|sme|student\s+pack|savings\s+account|current\s+account|digital\s+banking)\b/i,
    confidence: 0.75,
  },
];

/**
 * Classify a user query into a source type.
 * Returns { sourceType, confidence }.
 */
function detectSourceType(message) {
  const text = _norm(message);
  for (const { sourceType, pattern, confidence } of SOURCE_TYPE_PATTERNS) {
    if (pattern.test(text)) return { sourceType, confidence };
  }
  return { sourceType: SOURCE_TYPES.GENERAL, confidence: 0.50 };
}

/**
 * Build a concise answer (<= 3 lines) from ATB_CONTACT_FACTS.
 */
function buildContactFactsAnswer(message) {
  const text = _norm(message);
  const wantsPhone   = /\b(phone|t[eé]l[eé]|call|number|num[eé]ro|contact|reach|joindre)\b/.test(text);
  const wantsAddress = /\b(address|adresse|head office|si[eè]ge|headquarter|location|where|situated|located)\b/.test(text);

  if (wantsPhone && wantsAddress) {
    return (
      `**ATB contact:** standard line **${ATB_CONTACT_FACTS.phoneStandard}** | CRC **${ATB_CONTACT_FACTS.phoneCRC}**.\n` +
      `Head office: **${ATB_CONTACT_FACTS.headOffice}**.`
    );
  }
  if (wantsAddress) {
    return `ATB head office: **${ATB_CONTACT_FACTS.headOffice}**.`;
  }
  // Default: phone query
  return (
    `**ATB** — standard line: **${ATB_CONTACT_FACTS.phoneStandard}** | CRC: **${ATB_CONTACT_FACTS.phoneCRC}**.`
  );
}

module.exports = {
  SOURCE_TYPES,
  ATB_CONTACT_FACTS,
  detectSourceType,
  buildContactFactsAnswer,
};
