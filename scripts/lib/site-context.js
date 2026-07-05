'use strict';

const fs = require('fs');
const path = require('path');

const PAGE_TYPES = new Set([
  'home', 'product', 'service', 'contact', 'faq', 'form', 'article', 'listing', 'document_index', 'other',
]);

const SYNONYM_GROUPS = [
  ['opening', 'hours', 'opening hours', 'business hours', 'horaires', 'heures ouverture'],
  ['complaint', 'complaints', 'reclamation', 'reclamations', 'réclamation', 'réclamations'],
  ['contact', 'contacts', 'contacter', 'nous contacter', 'coordonnees', 'coordonnées'],
  ['recruitment', 'jobs', 'careers', 'emploi', 'emplois', 'recrutement', 'offres emploi'],
  ['service', 'services', 'prestation', 'prestations'],
  ['credit', 'credits', 'loan', 'loans', 'crédit', 'crédits', 'pret', 'prêt'],
  ['document', 'documents', 'forms', 'formulaires', 'documents utiles'],
  ['exchange', 'currency', 'currencies', 'change', 'devises', 'taux de change'],
  ['savings', 'saving', 'épargne', 'epargne'],
  ['survey', 'questionnaire', 'satisfaction', 'enquete', 'enquête'],
  ['banking', 'e-banking', 'online banking', 'banque en ligne', 'banque à distance'],
];

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'your', 'you', 'our', 'are', 'is', 'to', 'of',
  'a', 'an', 'in', 'on', 'at', 'or', 'be', 'as', 'by', 'what', 'which', 'where', 'page',
  'le', 'la', 'les', 'de', 'des', 'du', 'un', 'une', 'et', 'pour', 'avec', 'dans', 'sur', 'est',
  'sont', 'au', 'aux', 'ce', 'cette', 'ces', 'votre', 'vos', 'notre', 'nous', 'qui', 'que', 'quoi',
]);

function fold(value = '') {
  return String(value)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[’']/g, ' ').replace(/[^a-z0-9\u0600-\u06ff\s%-]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function cleanText(value = '') {
  return String(value).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function unique(values, keyFn = (value) => fold(value)) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    if (value === null || value === undefined || value === '') continue;
    const key = keyFn(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function tokens(value = '') {
  return fold(value).split(/\s+/).filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function expandTerms(value = '') {
  const base = new Set(tokens(value));
  const folded = fold(value);
  for (const group of SYNONYM_GROUPS) {
    if (group.some((term) => folded.includes(fold(term)))) {
      for (const term of group) for (const token of tokens(term)) base.add(token);
    }
  }
  return [...base];
}

function languageFrom(text = '', declared = '') {
  const lang = String(declared || '').toLowerCase().split(/[-_]/)[0];
  if (['fr', 'en', 'ar'].includes(lang)) return lang;
  const sample = String(text).slice(0, 6000);
  const arabic = (sample.match(/[\u0600-\u06ff]/g) || []).length;
  const latin = (sample.match(/[a-zA-ZÀ-ÿ]/g) || []).length;
  if (arabic > Math.max(20, latin * 0.25)) return 'ar';
  const f = ` ${fold(sample)} `;
  const frHits = [' le ', ' la ', ' les ', ' des ', ' votre ', ' avec ', ' pour '].filter((x) => f.includes(x)).length;
  const enHits = [' the ', ' and ', ' your ', ' with ', ' for ', ' from '].filter((x) => f.includes(x)).length;
  if (frHits > enHits && frHits >= 2) return 'fr';
  if (enHits >= 2) return 'en';
  return 'unknown';
}

function classifyPageType(page = {}) {
  const pathname = fold(page.path || '');
  const hay = fold(`${page.title || ''} ${page.metaDescription || ''} ${(page.headings || []).join(' ')} ${pathname}`);
  if (pathname === '' || pathname === '/') return 'home';
  if (/\b(contact|contacter|coordonnees|adresse)\b/.test(hay)) return 'contact';
  if (/\b(recruitment|recrutement|jobs?|emplois?|offres emploi|careers?|carrieres?)\b/.test(hay)) return 'listing';
  if ((page.forms || []).length || /\b(form|formulaire|questionnaire|application)\b/.test(hay)) return 'form';
  if (/\b(faq|frequently asked|questions frequentes|aide)\b/.test(hay)) return 'faq';
  if (/\b(article|actualite|news|blog|communique)\b/.test(hay)) return 'article';
  if (/\b(product|produit|credit|loan|account|compte|card|carte|pack)\b/.test(hay)) return 'product';
  if (/\b(service|services|solution|solutions)\b/.test(hay)) return 'service';
  if ((page.documents || []).length >= 4 || /\b(documents?|downloads?|telechargements?|formulaires?)\b/.test(hay)) return 'document_index';
  if (/\b(list|listing|catalog|catalogue|directory|annuaire)\b/.test(hay)) return 'listing';
  return 'other';
}

function sentenceCandidates(text = '') {
  return cleanText(text).split(/(?<=[.!?])\s+|\n+/)
    .map((value) => value.trim()).filter((value) => value.length >= 18 && value.length <= 320);
}

function deterministicFacts(page = {}) {
  const facts = [];
  for (const hour of page.hours || []) facts.push(typeof hour === 'string' ? hour : hour.text);
  const contact = page.contactFacts || {};
  for (const email of contact.emails || []) facts.push(`Email: ${email}`);
  for (const phone of contact.phones || []) facts.push(`Phone: ${phone}`);
  for (const address of contact.addresses || []) facts.push(`Address: ${address}`);

  for (const section of page.sections || []) {
    for (const fact of section.facts || []) facts.push(fact);
    const sentences = sentenceCandidates(section.text || '');
    let addedFromSection = false;
    for (const sentence of sentences) {
      const f = fold(sentence);
      if (/\d|:|\b(permet|offre|propose|includes?|provides?|available|disponible|destine|conditions?|required|requis)\b/.test(f)) {
        facts.push(sentence);
        addedFromSection = true;
      }
    }
    if (!addedFromSection && sentences[0]) facts.push(sentences[0]);
  }
  for (const doc of page.documents || []) {
    const label = doc.text || doc.fileName || '';
    if (label) facts.push(`Document: ${label}`);
  }
  for (const form of page.forms || []) {
    if (form.title || form.name) facts.push(`Form: ${form.title || form.name}`);
  }
  return unique(facts.filter((fact) => {
    const value = fold(fact);
    return !(/\btmm\b/.test(value) && value.length <= 80)
      && !/^(?:prix|price|atbchallenge|version arabe|arabic version)\b/.test(value);
  })).slice(0, 24);
}

function deterministicPurpose(page = {}) {
  const meta = cleanText(page.metaDescription || '');
  if (meta.length >= 30 && meta.length <= 280) return meta;
  const firstHeading = (page.headings || []).find((heading) => cleanText(heading).length >= 4);
  const purposeCandidates = sentenceCandidates(page.cleanText || '');
  const firstIndex = purposeCandidates
    .findIndex((sentence) => (!firstHeading || fold(sentence) !== fold(firstHeading))
      && !/\b(?:tmm|taux moyen|opening hours|horaires?|heures? d ouverture)\b/i.test(fold(sentence))
      && !/^(?:prix|price|atbchallenge|version arabe|arabic version)\b/i.test(fold(sentence))
      && !/^\d{1,2}\s+(?:janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\s+\d{4}$/i.test(fold(sentence))
      && !(sentence.length <= 100 && sentence === sentence.toUpperCase() && /[A-ZÀ-ÖØ-Þ]{8}/.test(sentence))
      && !/^(?:les autres|other)\s+(?:services?|produits?|credits?|crédits?)$/i.test(sentence));
  if (firstIndex >= 0) {
    let purpose = purposeCandidates[firstIndex];
    if (/\b(?:and|et|or|ou|with|avec|of|de|du|des|to|a|à|mais)\s*$/i.test(purpose)) {
      purpose = `${purpose} ${purposeCandidates[firstIndex + 1] || ''}`.trim();
    }
    return purpose.slice(0, 280);
  }
  const title = cleanText(page.title || firstHeading || page.path || 'Web page');
  return `Information provided on the ${title} page.`;
}

function deterministicKeywords(page = {}) {
  const counts = new Map();
  const source = `${page.title || ''} ${(page.headings || []).join(' ')} ${(page.keyFacts || []).join(' ')}`;
  for (const token of tokens(source)) counts.set(token, (counts.get(token) || 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([token]) => token);
  const expanded = expandTerms(source);
  return unique([...ranked, ...expanded]).slice(0, 40);
}

function enrichPageDeterministically(page = {}) {
  const enriched = { ...page };
  enriched.language = languageFrom(enriched.cleanText, enriched.language);
  enriched.pageType = PAGE_TYPES.has(enriched.pageType) ? enriched.pageType : classifyPageType(enriched);
  enriched.keyFacts = unique([...(enriched.keyFacts || []), ...deterministicFacts(enriched)]).slice(0, 24);
  enriched.pagePurpose = cleanText(enriched.pagePurpose || deterministicPurpose(enriched)).slice(0, 300);
  enriched.keywords = unique([...(enriched.keywords || []), ...deterministicKeywords(enriched)]).slice(0, 48);
  const headings = (enriched.sections || []).map((section) => section.heading).filter(Boolean);
  enriched.searchText = cleanText([
    enriched.title, enriched.metaDescription, enriched.pagePurpose,
    ...(enriched.headings || []), ...headings, ...(enriched.keyFacts || []),
    ...(enriched.keywords || []), enriched.cleanText,
  ].filter(Boolean).join('\n'));
  return enriched;
}

function loadSiteContext(domain, { rootDir = process.cwd() } = {}) {
  const safeDomain = String(domain || '').toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  if (!safeDomain || !/^[a-z0-9.-]+$/.test(safeDomain)) throw new Error('A valid domain is required');
  const filePath = path.join(rootDir, 'site-context', safeDomain, 'context.json');
  if (!fs.existsSync(filePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!parsed || !Array.isArray(parsed.pages)) throw new Error(`Invalid site context: ${filePath}`);
  return parsed;
}

function fieldScore(terms, value, weight) {
  const hay = ` ${fold(value)} `;
  let score = 0;
  const matched = [];
  for (const term of terms) {
    if (hay.includes(` ${term} `) || hay.includes(term)) {
      score += weight;
      matched.push(term);
    }
  }
  return { score, matched };
}

function searchSiteContext(query, context, { limit = 8, minScore = 1 } = {}) {
  const terms = expandTerms(query);
  if (!terms.length || !context || !Array.isArray(context.pages)) return [];
  const phrase = fold(query);
  return context.pages.map((page) => {
    let score = 0;
    const matched = new Set();
    const add = (value, weight) => {
      const hit = fieldScore(terms, value, weight);
      score += hit.score;
      hit.matched.forEach((term) => matched.add(term));
    };
    add(page.title, 8);
    add(page.path, 7);
    add(page.pagePurpose, 6);
    add((page.headings || []).join(' '), 6);
    add((page.sections || []).map((section) => section.heading).join(' '), 5);
    add((page.keyFacts || []).join(' '), 5);
    add((page.keywords || []).join(' '), 4);
    add(page.cleanText, 1);
    const identity = fold(`${page.title || ''} ${(page.headings || []).join(' ')} ${page.path || ''}`);
    if (phrase.length >= 4 && identity.includes(phrase)) score += 12;
    const coverage = matched.size / Math.max(terms.length, 1);
    score += coverage * 6;
    const contentLength = cleanText(page.cleanText || '').length;
    score += Math.min(8, contentLength / 100);
    if (contentLength < 40) score -= 8;
    return { page, score: Number(score.toFixed(3)), matchedTerms: [...matched], coverage: Number(coverage.toFixed(3)) };
  }).filter((result) => result.score >= minScore)
    .sort((a, b) => b.score - a.score || b.coverage - a.coverage || a.page.url.localeCompare(b.page.url))
    .slice(0, limit);
}

module.exports = {
  PAGE_TYPES,
  SYNONYM_GROUPS,
  fold,
  cleanText,
  unique,
  tokens,
  expandTerms,
  languageFrom,
  classifyPageType,
  deterministicFacts,
  deterministicPurpose,
  deterministicKeywords,
  enrichPageDeterministically,
  loadSiteContext,
  searchSiteContext,
};
