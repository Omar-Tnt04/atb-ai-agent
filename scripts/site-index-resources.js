#!/usr/bin/env node
'use strict';
/**
 * site-index-resources.js — shared resource-index builder v2
 *
 * Converts a site-index.json agentIndex into a flat resources[] array
 * containing page and document resource objects ready for retrieval.
 *
 * Used by:
 *   scripts/build-site-index.js   (called automatically after every crawl)
 *   scripts/enrich-site-index.js  (standalone post-processing on existing file)
 *
 * Public API:
 *   buildResourceIndex(siteIndex)  → { resources, stats, warnings }
 *   validateResources(resources, origin) → string[]
 *   SCHEMA_VERSION
 */

const path   = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = '2.0';

// ─── Utilities ────────────────────────────────────────────────────────────────

function shortId(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
}

function decodeHtmlEntities(s) {
  return (s || '')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g,    (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function normalizeText(s) {
  if (!s) return '';
  let t = decodeHtmlEntities(s);
  t = t.replace(/[''′`´ʼ‹›]/g, "'");
  t = t.toLowerCase();
  t = t.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
  t = t.replace(/\s+/g, ' ').trim();
  const seen = new Set();
  return t.split(' ').filter(w => {
    const had = seen.has(w);
    seen.add(w);
    return !had;
  }).join(' ');
}

const PATH_STOP = new Set([
  'the', 'a', 'an', 'de', 'du', 'la', 'le', 'les', 'en', 'et', 'ou',
  'un', 'une', 'au', 'aux', 'par', 'sur', 'dans', 'avec', 'pour',
  'php', 'html', 'asp', 'aspx', 'page', 'index', 'www', 'http', 'https',
  'tn', 'com', 'org', 'net',
  'presentation', 'detail', 'details', 'view', 'show', 'item', 'single', 'post', 'entry',
]);

function tokenizePath(p) {
  if (!p || p === '/') return [];
  return p.toLowerCase()
    .split(/[/\-_.?=&\s]+/)
    .map(s => s.replace(/[^a-z0-9]/g, ''))
    .filter(s => s.length > 2 && !PATH_STOP.has(s));
}

function filenameToTitle(filename) {
  if (!filename) return '';
  const base = filename.replace(/\.[^.]+$/, '');
  return base.split(/[-_.\s]+/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function getFilename(urlStr) {
  try { return path.posix.basename(new URL(urlStr).pathname) || ''; } catch { return ''; }
}

function getUrlPath(urlStr) {
  try { return new URL(urlStr).pathname; } catch { return urlStr; }
}

function normalizePageUrl(u) {
  try {
    const p = new URL(u);
    p.hash     = '';
    p.pathname = p.pathname.replace(/\/+/g, '/');
    return p.href.replace(/\/$/, '') || p.href;
  } catch { return u; }
}

function normalizeDocUrl(u) {
  try {
    const p = new URL(u);
    p.hash     = '';
    p.pathname = p.pathname.replace(/\/+/g, '/').toLowerCase();
    return p.href.replace(/\/$/, '') || p.href;
  } catch { return u.toLowerCase(); }
}

function isSameHost(urlStr, origin) {
  try {
    const a = new URL(urlStr).hostname.replace(/^www\./, '');
    const b = new URL(origin).hostname.replace(/^www\./, '');
    return a === b;
  } catch { return false; }
}

// True when string contains at least one Latin letter (a-z, À-ö, etc.)
function isLatinScript(s) {
  return /[a-zA-ZÀ-öø-ÿ]/.test(s);
}

// ─── Language detection ───────────────────────────────────────────────────────

const FR_WORDS = new Set([
  'de', 'du', 'la', 'le', 'les', 'et', 'en', 'un', 'une', 'au', 'aux',
  'des', 'pour', 'sur', 'avec', 'dans', 'par', 'ou', 'est', 'son', 'sa',
  'ses', 'ce', 'qui', 'que', 'pas', 'plus', 'mais', 'cette', 'bien',
  'vous', 'nos', 'votre', 'vos', 'notre', 'lui', 'si', 'ne', 'ni',
  'apr', 'avant', 'aussi', 'entre', 'même', 'autre', 'autres',
]);

const FR_CHARS_RE = /[éèêëàâùûîïôçœ]/;

/**
 * Detects language from an array of text signals.
 * Returns 'fr' for French, 'en' otherwise.
 */
function detectLang(textSignals) {
  const sample = (Array.isArray(textSignals) ? textSignals : [textSignals])
    .filter(Boolean)
    .join(' ');
  if (!sample.trim()) return 'en';
  if (FR_CHARS_RE.test(sample)) return 'fr';
  const words  = sample.toLowerCase().split(/[\s,;:.!?()[\]{}'"«»]+/);
  const frHits = words.filter(w => w.length > 1 && FR_WORDS.has(w)).length;
  return frHits >= 2 ? 'fr' : 'en';
}

/**
 * Detects the dominant language of a site by sampling page titles and headings.
 * More reliable than per-page detection because short/unaccented titles mislead per-page logic.
 */
function detectSiteLang(agentIndex) {
  const sample = agentIndex.slice(0, 120);
  let frScore = 0;
  for (const page of sample) {
    const text = [
      page.title || '',
      ...(page.headings || []).slice(0, 3).map(h => h.text || ''),
      (page.textPreview || '').slice(0, 100),
    ].join(' ');
    if (FR_CHARS_RE.test(text)) frScore++;
  }
  return frScore >= Math.max(2, sample.length * 0.12) ? 'fr' : 'en';
}

// ─── Site name detection ──────────────────────────────────────────────────────

// Splits on: pipe, em-dash, en-dash, OR spaced hyphen (e.g. "Title - SiteName")
const TITLE_SEP_RE = /\s*[|—–]\s*|\s+-\s+/;

function findSiteNameFragments(agentIndex) {
  const freq = new Map();
  for (const p of agentIndex) {
    const t = (p.title || '').trim();
    if (!t) continue;
    for (const part of t.split(TITLE_SEP_RE)) {
      const trimmed = part.trim();
      if (trimmed.length >= 3) freq.set(trimmed, (freq.get(trimmed) || 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.floor(agentIndex.length * 0.15));
  const frags = new Set();
  for (const [s, c] of freq) {
    if (c >= threshold) frags.add(s);
  }
  return frags;
}

function cleanPageTitle(rawTitle, siteNameFragments) {
  if (!rawTitle) return '';
  const parts = rawTitle.split(TITLE_SEP_RE);
  if (parts.length === 1) {
    return siteNameFragments.has(rawTitle.trim()) ? '' : rawTitle.trim();
  }
  const useful = parts.filter(p => !siteNameFragments.has(p.trim())).map(p => p.trim()).filter(Boolean);
  return useful.join(' — ');
}

function getEffectiveTitle(page, siteNameFragments) {
  const cleaned = cleanPageTitle(page.title || '', siteNameFragments);
  if (cleaned && cleaned.length >= 4) return cleaned;
  // h3+ headings are often site-wide template sections (e.g. "Un réseau de plus de 100 agences"
  // sidebar widget on ATB) and produce wrong description templates when pattern-matched.
  // Only h1/h2 are reliable indicators of the page's specific topic.
  for (const h of (page.headings || [])) {
    if (h.level <= 2 && h.text && h.text.length >= 4) return h.text;
  }
  const tokens = tokenizePath(page.path);
  if (tokens.length) return tokens.map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(' ');
  return page.title || page.path || page.url;
}

// ─── Page purpose patterns ────────────────────────────────────────────────────

const PAGE_PURPOSE_PATTERNS = [
  {
    re: /simulat(eur|or|ion)/i,
    action_en: 'simulate or estimate values such as monthly payments, interest rates, and repayment costs',
    action_fr: "simuler ou estimer des valeurs financières telles que les mensualités, les taux d'intérêt et les coûts de remboursement",
    synonyms: 'simulation calculator estimate compute calculer estimer montant taux mensualite',
  },
  {
    re: /tarif|tarification|frais|fees|pricing/i,
    action_en: 'consult fees, costs, commissions, and pricing conditions for banking products and services',
    action_fr: 'consulter les tarifs, frais, commissions et conditions tarifaires applicables aux produits et services bancaires',
    synonyms: 'fee cost price charge commission tariff pricing frais cout montant tarification conditions',
  },
  {
    re: /agence|branch|location|store|succursale/i,
    action_en: 'find branch locations, addresses, and opening hours',
    action_fr: "trouver les agences et succursales, consulter leurs adresses, horaires d'ouverture et coordonnées",
    synonyms: 'branch agency office location address hours find nearest agence map horaires',
  },
  {
    re: /contact|nous.contacter|joindre/i,
    action_en: 'contact the organization, find contact details, and reach customer support',
    action_fr: "contacter l'organisation, consulter les moyens de contact et accéder aux informations d'assistance clientèle",
    synonyms: 'contact phone email address support helpdesk reach telephone',
  },
  {
    re: /\bfaq\b|frequemment|frequently[\s-]asked/i,
    action_en: 'find answers to frequently asked questions about available services',
    action_fr: 'trouver des réponses aux questions fréquemment posées et obtenir de l\'aide sur les services proposés',
    synonyms: 'faq question answer help support guide assistance frequent',
  },
  {
    re: /recrut|emploi|career|job|offre[\s-]emploi/i,
    action_en: 'browse job offers and career opportunities',
    action_fr: "parcourir les offres d'emploi disponibles et accéder aux opportunités de carrière au sein de l'organisation",
    synonyms: 'job career employment hiring recruitment offer vacancy offre emploi poste',
  },
  {
    re: /actualit|news|blog|press|presse|communique|article/i,
    action_en: 'read news, articles, and press releases',
    action_fr: "lire les actualités, articles et communiqués de presse liés à l'activité de la banque",
    synonyms: 'news article update press release announcement blog actu communique',
  },
  {
    re: /credit|loan|emprunt|financement|pret|hypothe/i,
    action_en: 'explore credit, loan, and financing options and simulate repayment plans',
    action_fr: 'explorer les options de crédit, prêt et financement disponibles et simuler des plans de remboursement',
    synonyms: 'credit loan borrow mortgage financing interest rate emprunt pret hypotheque',
  },
  {
    re: /epargn|saving|invest|placement|patrimoine/i,
    action_en: 'explore savings and investment products and consult their conditions',
    action_fr: "explorer les produits d'épargne, de placement et d'investissement disponibles et consulter leurs conditions",
    synonyms: 'saving investment deposit interest yield plan placement epargne rendement',
  },
  {
    re: /devise|taux[\s-]change|cours[\s-]devise|forex|currency/i,
    action_en: 'consult exchange rates, currency values, and foreign exchange information',
    action_fr: 'consulter les devises, les taux de change et les informations liées aux opérations de change',
    synonyms: 'exchange rate currency forex devise taux cours dollar euro change money',
  },
  {
    re: /assur/i,
    action_en: 'explore insurance products and coverage options',
    action_fr: "explorer les produits d'assurance disponibles et consulter les options de couverture et de protection",
    synonyms: 'insurance assurance coverage policy premium protection garantie',
  },
  {
    re: /\bcompte\b|\baccount\b/i,
    action_en: 'open or manage bank accounts and access related banking services',
    action_fr: 'ouvrir ou gérer des comptes bancaires et accéder aux services liés à la gestion de compte',
    synonyms: 'account open bank current savings deposit cheque compte bancaire',
  },
  {
    re: /\bcarte\b|\bcard\b/i,
    action_en: 'explore bank card products, payment features, and card benefits',
    action_fr: "explorer les cartes bancaires disponibles, leurs avantages, plafonds et fonctionnalités de paiement",
    synonyms: 'card debit credit visa mastercard contactless payment carte bancaire',
  },
  {
    re: /reclamation|complaint|dispute|plainte/i,
    action_en: 'submit a complaint or request dispute resolution',
    action_fr: 'soumettre une réclamation, signaler un problème ou demander une résolution de litige auprès du service concerné',
    synonyms: 'complaint dispute reclamation claim issue problem plainte litige',
  },
  {
    re: /virement|transfer|payment|paiement/i,
    action_en: 'initiate or consult transfers and bank payments',
    action_fr: 'effectuer ou consulter des virements, paiements et transferts bancaires',
    synonyms: 'transfer payment wire virement paiement send money envoi',
  },
  {
    re: /financ/i,
    action_en: 'access financial services, banking products, and related information',
    action_fr: "accéder aux services financiers, produits bancaires et informations sur l'offre de la banque",
    synonyms: 'finance financial banking product service investissement',
  },
  {
    re: /espace|portail|portal|dashboard|personnel/i,
    action_en: 'access a personal account area or online banking portal',
    action_fr: 'accéder à un espace personnel, consulter son compte en ligne et utiliser les services bancaires à distance',
    synonyms: 'account portal login dashboard profile personal space espace mon compte',
  },
];

function inferPagePurpose(effectiveTitle, pathStr) {
  const combined = `${effectiveTitle} ${pathStr}`.toLowerCase();
  return PAGE_PURPOSE_PATTERNS.find(p => p.re.test(combined)) || null;
}

// ─── Page description generation ─────────────────────────────────────────────

const NAV_LINK_STOP = /^(accueil|home|back|retour|menu|voir|voir tout|voir plus|all|read more|plus|more|ici|here|lien|link|click|\d+|pdf|doc|download|telecharger)$/i;

function buildPageDescription(page, incomingTexts, siteNameFragments, lang) {
  const pathStr = page.path || '';

  // Homepage gets a direct, language-aware description
  if (pathStr === '/' || pathStr === '') {
    let domainLabel = 'this website';
    try { domainLabel = new URL(page.url).hostname.replace(/^www\./, ''); } catch {}
    const usefulLinks = (incomingTexts || [])
      .filter(t => t && t.length > 3 && !NAV_LINK_STOP.test(t.trim()))
      .slice(0, 2);
    let desc;
    if (lang === 'fr') {
      desc = `Cette page est la page d'accueil principale de ${domainLabel}. Elle donne accès à l'ensemble des services, produits et rubriques disponibles sur le site.`;
      if (usefulLinks.length > 0) {
        desc += ` Les visiteurs peuvent notamment accéder à des sections telles que « ${usefulLinks.slice(0, 2).join(' » et « ')} ».`;
      }
    } else {
      desc = `This is the main homepage of ${domainLabel}. It provides access to all services, products, and sections of the website.`;
      if (usefulLinks.length > 0) {
        desc += ` Visitors can navigate to areas such as "${usefulLinks.slice(0, 2).join('" and "')}" from here.`;
      }
    }
    return desc.slice(0, 700);
  }

  const effectiveTitle = getEffectiveTitle(page, siteNameFragments);
  const purpose        = inferPagePurpose(effectiveTitle, pathStr);

  const headings   = (page.headings || []).filter(h => h.text && h.text.length > 4);
  const h1         = headings.find(h => h.level === 1);
  const h2         = headings.find(h =>
    h.level === 2 &&
    h.text !== effectiveTitle &&
    h.text !== (h1 && h1.text),
  );

  const usefulLinks = (incomingTexts || [])
    .filter(t => t && t.length > 3 && !NAV_LINK_STOP.test(t.trim()))
    .slice(0, 3);

  let s1 = '', s2 = '', s3 = '';

  if (lang === 'fr') {
    const action = purpose ? purpose.action_fr : null;
    if (action) {
      // Clean "Cette page permet de [rich action]." — no title repetition
      s1 = `Cette page permet de ${action}.`;
      if (h2) {
        s2 = `Elle inclut des informations sur « ${h2.text} ».`;
      } else if (usefulLinks.length > 0) {
        s2 = `Les visiteurs y accèdent souvent via des liens intitulés « ${usefulLinks[0]} ».`;
      }
    } else {
      s1 = `Cette page présente des informations sur « ${effectiveTitle} ».`;
      if (h2) {
        s2 = `Elle aborde notamment le sujet « ${h2.text} ».`;
      } else if (h1 && h1.text !== effectiveTitle && h1.text.length > 4) {
        s2 = `La page traite de : « ${h1.text} ».`;
      }
      if (usefulLinks.length > 0) {
        s3 = `Les visiteurs arrivent souvent sur cette page via le lien « ${usefulLinks[0]} ».`;
      }
    }
  } else {
    const action = purpose ? purpose.action_en : null;
    if (action) {
      s1 = `This page allows users to ${action}.`;
      if (h2) {
        s2 = `It includes details on "${h2.text}".`;
      } else if (usefulLinks.length > 0) {
        s2 = `Users typically navigate here through links such as "${usefulLinks[0]}".`;
      }
    } else {
      s1 = `This page provides information about "${effectiveTitle}".`;
      if (h2) {
        s2 = `It covers topics such as "${h2.text}".`;
      } else if (h1 && h1.text !== effectiveTitle && h1.text.length > 4) {
        s2 = `The page focuses on: "${h1.text}".`;
      }
      if (usefulLinks.length > 0) {
        s3 = `Visitors often arrive here via links labeled "${usefulLinks[0]}".`;
      }
    }
  }

  let desc = [s1, s2, s3].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  // Pad with textPreview if under 250 chars
  if (desc.length < 250 && page.textPreview) {
    const preview = (page.textPreview || '').replace(/\s+/g, ' ').trim().slice(0, 600 - desc.length);
    if (preview.length > 20) desc = `${desc} ${preview}`.trim();
  }

  return desc.slice(0, 700);
}

function buildPageSearchText(page, incomingTexts, purpose, effectiveTitle, siteNameFragments) {
  const cleanedTitle = cleanPageTitle(page.title || '', siteNameFragments);
  const parts = [
    effectiveTitle,
    cleanedTitle !== effectiveTitle ? cleanedTitle : '',
    page.description || '',
    ...(page.headings || []).map(h => h.text).slice(0, 6),
    ...tokenizePath(page.path),
    ...(incomingTexts || []).slice(0, 8),
    (page.textPreview || '').slice(0, 150),
    purpose ? purpose.synonyms : '',
  ].filter(Boolean);
  return normalizeText(parts.join(' ')).slice(0, 1500);
}

// ─── Document purpose patterns ────────────────────────────────────────────────

const DOC_PATTERNS = [
  {
    re: /formulaire|form/i,
    build_en: (topic) =>
      `This is a form${topic ? ' for ' + topic : ' for the related service'}. ` +
      'Users can download, fill out, and submit this document to initiate or complete the related application or process.',
    build_fr: (topic) =>
      `Formulaire officiel${topic ? ' pour ' + topic : ' lié à ce service'}. ` +
      "L'utilisateur peut le télécharger, le remplir et le soumettre pour compléter la demande ou la démarche correspondante.",
    synonyms: 'form fill submit formulaire demande application document remplir soumettre',
  },
  {
    re: /\bdemande\b|\brequest\b/i,
    build_en: (topic) =>
      `This is an official request document${topic ? ' for ' + topic : ''}. ` +
      'Users can download and complete it to formally request the corresponding service, benefit, or authorization.',
    build_fr: (topic) =>
      `Document officiel de demande${topic ? ' pour ' + topic : ''}. ` +
      "À télécharger et remplir pour formuler une demande formelle auprès du service ou de l'organisme concerné.",
    synonyms: 'request official demand formulaire demande document apply soumettre',
  },
  {
    re: /\bguide\b|\bmanuel\b|\bmanual\b|\bmode[\s-]emploi\b/i,
    build_en: (topic) =>
      `This is a user guide or manual${topic ? ' for ' + topic : ''}. ` +
      'Users can read it to understand how to use, apply for, or navigate the related service or product.',
    build_fr: (topic) =>
      `Guide ou manuel d'utilisation${topic ? ' pour ' + topic : ''}. ` +
      "Permet à l'utilisateur de comprendre comment utiliser ou accéder au service ou produit décrit.",
    synonyms: 'guide manual how-to instructions user-guide tutorial help mode emploi utilisation',
  },
  {
    re: /tarif|tarification|fees?|pricing|commission/i,
    build_en: (topic) =>
      `This document details the fees, costs, commissions, and pricing${topic ? ' for ' + topic : ' applicable to the service'}. ` +
      'Users can consult it to understand the charges and rates that apply before using the service.',
    build_fr: (topic) =>
      `Document officiel qui présente les tarifs, frais, commissions et coûts${topic ? ' liés à ' + topic : ' applicables aux services'}. ` +
      "Il aide l'utilisateur à consulter la tarification appliquée avant d'utiliser le service.",
    synonyms: 'fees costs pricing tariff commission charge rate frais cout tarification montants conditions bareme',
  },
  {
    re: /\bfaq\b/i,
    build_en: (topic) =>
      `This is a frequently asked questions document${topic ? ' about ' + topic : ''}. ` +
      'Users can read it to find answers to common questions and understand how the related service or process works.',
    build_fr: (topic) =>
      `Document de questions-réponses fréquentes${topic ? ' sur ' + topic : ''}. ` +
      "Aide l'utilisateur à trouver des réponses aux interrogations courantes sur le service ou la procédure.",
    synonyms: 'faq questions answers frequently asked help support common',
  },
  {
    re: /rapport|report|\bbilan\b|\bannuel\b|\bannual\b/i,
    build_en: (topic) =>
      `This is a report or summary document${topic ? ' on ' + topic : ''}. ` +
      'Users can download it to review data, results, or key findings related to the subject covered.',
    build_fr: (topic) =>
      `Rapport ou document de synthèse${topic ? ' sur ' + topic : ''}. ` +
      "Peut être téléchargé pour consulter les données, résultats ou conclusions relatifs au sujet traité.",
    synonyms: 'report annual results data financial bilan rapport findings summary review',
  },
];

const GENERIC_LINK_STOP_SET = new Set([
  'telecharger', 'telechargez', 'download', 'cliquez ici', 'click here', 'voir',
  'view', 'ici', 'here', 'lien', 'link', 'fichier', 'file', 'document',
  'consulter', 'access', 'ouvrir', 'open', 'get', 'obtenir', 'pdf', 'doc',
  'voir le document', 'voir le fichier', 'cliquer', 'plus', 'more',
  'telecharger le document', 'download the document',
]);

function isGenericLinkText(t) {
  if (!t || t.trim().length <= 2) return true;
  return GENERIC_LINK_STOP_SET.has(t.trim().toLowerCase());
}

/**
 * Detect document pattern from title, filename, and link texts.
 * Falls through each in order so Arabic/non-Latin titles don't miss the match.
 */
function detectDocPattern(title, filename, linkTexts) {
  return DOC_PATTERNS.find(p => p.re.test(title))
      || DOC_PATTERNS.find(p => p.re.test(filename))
      || DOC_PATTERNS.find(p => (linkTexts || []).slice(0, 4).some(t => p.re.test(t)))
      || null;
}

// Strips leading pattern keyword + French/English prepositions.
// tarif(?:ication)?s? covers: tarif, tarifs, tarification, tarifications
const TOPIC_KEYWORD_RE = /^(?:formulaire|form|demande|request|guide|manuel|manual|tarif(?:ication)?s?|fees?|pricing|rapport|report|bilan|annuel|annual|faq)\s*(?:d(?:es?\s+(?:la\s+|les\s+)?|[''](?:une?\s+)?(?:la\s+|les\s+)?)|pour\s+(?:la\s+|les\s+)?|for\s+(?:the\s+)?|sur\s+(?:la\s+|les\s+)?|on\s+(?:the\s+)?|of\s+(?:the\s+)?)?/i;

// Words so generic they don't make a useful document topic on their own.
const GENERIC_TOPIC_WORDS = new Set([
  'operations', 'operation', 'bancaires', 'bancaire', 'services', 'service',
  'bank', 'banking', 'general', 'generales', 'generale', 'divers', 'diverses', 'atb',
]);

function isGenericTopic(topic) {
  const words = topic.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every(w => GENERIC_TOPIC_WORDS.has(w));
}

function extractDocTopic(title, filename, sourcePages, pat) {
  if (!pat) return '';
  const stripped = (title || '').replace(TOPIC_KEYWORD_RE, '').trim();
  if (stripped.length >= 4 && isLatinScript(stripped) && !isGenericTopic(stripped)) return stripped;
  for (const sp of (sourcePages || [])) {
    if (!sp.linkText || isGenericLinkText(sp.linkText)) continue;
    if (sp.linkText === title || !isLatinScript(sp.linkText)) continue;
    const sl = (sp.linkText || '').replace(TOPIC_KEYWORD_RE, '').trim();
    // Only use if stripped form yields something specific (non-generic, non-trivial)
    if (sl.length >= 4 && !isGenericTopic(sl)) return sl;
  }
  return '';
}

function buildDocDescription(title, filename, topSourcePages, linkTexts, pat, lang) {
  const topic = extractDocTopic(title, filename, topSourcePages, pat);
  if (pat) {
    const builder = lang === 'fr' ? pat.build_fr : pat.build_en;
    return builder(topic || null).slice(0, 700);
  }
  // Generic fallback
  if (lang === 'fr') {
    if (topic && topic !== title) {
      return `Ce document traite de « ${topic} ». Il peut être téléchargé pour consultation ou dans le cadre d'une démarche liée au service concerné.`.slice(0, 700);
    }
    const usefulLink = linkTexts.find(t => !isGenericLinkText(t) && isLatinScript(t));
    if (usefulLink && usefulLink !== title) {
      return `Ce document, référencé sous « ${usefulLink} », peut être téléchargé pour consultation ou dans le cadre d'une demande de service.`.slice(0, 700);
    }
    return `Ce document, intitulé « ${title} », peut être téléchargé pour consultation ou dans le cadre d'une démarche liée au service concerné.`.slice(0, 700);
  }
  if (topic && topic !== title) {
    return `This document covers "${topic}". It can be downloaded for reference or to complete a related process or service request.`.slice(0, 700);
  }
  const usefulLink = linkTexts.find(t => !isGenericLinkText(t));
  if (usefulLink && usefulLink !== title) {
    return `This document, also referenced as "${usefulLink}", can be downloaded for reference. It relates to the service or process described by its title.`.slice(0, 700);
  }
  return `This document, titled "${title}", can be downloaded for reference or as part of a related service or application process.`.slice(0, 700);
}

function buildDocSearchText(title, filename, filePath, topSourcePages, sortedLinkTexts, docPat) {
  const parts = [
    title,
    filename.replace(/\.[^.]+$/, ''),
    ...tokenizePath(filename.replace(/\.[^.]+$/, '')),
    ...tokenizePath(filePath),
    ...sortedLinkTexts.slice(0, 8),
    ...topSourcePages.slice(0, 4).map(s => s.title || '').filter(Boolean),
    docPat ? docPat.synonyms : '',
  ].filter(Boolean);
  return normalizeText(parts.join(' ')).slice(0, 1500);
}

// ─── Source page scoring and capping ─────────────────────────────────────────

const MAX_SOURCE_PAGES = 8;

function scoreSourcePageEntry(occ) {
  let score = 0;
  const linkText  = (occ.linkText || '').trim();
  const pathDepth = (occ.sourcePage.path || '/').split('/').filter(Boolean).length;

  if (!isGenericLinkText(linkText)) score += 4;
  if (linkText.length > 10)         score += 2;
  if (linkText.length > 30)         score += 1;
  score += Math.max(0, 5 - pathDepth);

  return score;
}

function selectSourcePages(allOccurrences) {
  const seenUrls = new Set();
  const deduped  = [];
  for (const occ of allOccurrences) {
    if (!seenUrls.has(occ.sourcePage.url)) {
      seenUrls.add(occ.sourcePage.url);
      deduped.push(occ);
    }
  }
  const totalCount = deduped.length;
  const scored = deduped.map(occ => ({ occ, score: scoreSourcePageEntry(occ) }));
  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, MAX_SOURCE_PAGES).map(({ occ }) => ({
    url:      occ.sourcePage.url,
    path:     occ.sourcePage.path,
    title:    occ.sourcePage.title,
    linkText: occ.linkText,
  }));
  return { selected, totalCount };
}

// ─── Incoming link map ────────────────────────────────────────────────────────

function buildIncomingLinkMap(agentIndex) {
  const map = new Map();
  for (const page of agentIndex) {
    const from = { fromUrl: page.url, fromTitle: page.title };
    for (const link of (page.links || [])) {
      if (!link.href || !link.text) continue;
      const norm = normalizePageUrl(link.href);
      if (!map.has(norm)) map.set(norm, []);
      const bucket = map.get(norm);
      if (!bucket.some(e => e.fromUrl === from.fromUrl && e.text === link.text)) {
        bucket.push({ text: link.text, ...from });
      }
    }
  }
  return map;
}

// ─── Page resources ───────────────────────────────────────────────────────────

function buildPageResources(agentIndex, incomingLinkMap, siteNameFragments, lang) {
  return agentIndex.map(page => {
    const normUrl        = normalizePageUrl(page.url);
    const incoming       = incomingLinkMap.get(normUrl) || [];
    const incomingTexts  = [...new Set(incoming.map(e => e.text).filter(Boolean))];

    const effectiveTitle = getEffectiveTitle(page, siteNameFragments);
    const purpose        = inferPagePurpose(effectiveTitle, page.path || '');

    const description = buildPageDescription(page, incomingTexts, siteNameFragments, lang);
    const searchText  = buildPageSearchText(page, incomingTexts, purpose, effectiveTitle, siteNameFragments);

    return {
      id:          'page_' + shortId(page.url),
      type:        'page',
      title:       page.title || filenameToTitle(page.path) || page.url,
      url:         page.url,
      path:        page.path,
      description: description || `This page is located at ${page.path}.`,
      searchText:  searchText  || normalizeText(page.title || page.path || page.url),
    };
  });
}

// ─── Document resources ───────────────────────────────────────────────────────

function buildDocumentResources(agentIndex, origin, lang) {
  const docMap = new Map();
  let totalOccurrences = 0;

  for (const page of agentIndex) {
    for (const dl of (page.downloads || [])) {
      if (!dl.href) continue;
      if (!isSameHost(dl.href, origin)) continue;
      totalOccurrences++;

      const norm = normalizeDocUrl(dl.href);
      if (!docMap.has(norm)) {
        const fn = getFilename(dl.href);
        docMap.set(norm, {
          href:        dl.href,
          fileType:    dl.fileType || (fn.split('.').pop() || '').toLowerCase(),
          occurrences: [],
        });
      }
      docMap.get(norm).occurrences.push({
        linkText:   dl.text || '',
        sourcePage: { url: page.url, path: page.path, title: page.title },
      });
    }

    // Download-action buttons: file URL unknown at crawl time; browser must click.
    for (const act of (page.downloadActions || [])) {
      if (!act.text || isGenericLinkText(act.text)) continue;
      // Key: normalized text + sourcePage URL (deduplicate same button text per page)
      const norm = `action::${normalizeText(act.text)}::${normalizePageUrl(page.url)}`;
      if (!docMap.has(norm)) {
        docMap.set(norm, {
          href:        null,
          fileType:    'action',
          occurrences: [],
          isAction:    true,
          actionText:  act.text,
        });
      }
      docMap.get(norm).occurrences.push({
        linkText:   act.text,
        sourcePage: { url: page.url, path: page.path, title: page.title },
      });
      totalOccurrences++;
    }
  }

  const docs = [];
  for (const [normUrl, doc] of docMap) {
    // Action document: no known file URL; browser navigates to sourcePage and clicks linkText.
    if (doc.isAction) {
      const { selected: sourcePages, totalCount: sourcePageCount } = selectSourcePages(doc.occurrences);
      const searchText = normalizeText(doc.actionText || '');
      if (!searchText) continue;
      const firstSrc = doc.occurrences[0]?.sourcePage || {};
      docs.push({
        id:              'act_' + shortId(normUrl),
        type:            'document',
        title:           doc.actionText,
        url:             firstSrc.url || '',
        path:            firstSrc.path || '',
        filename:        '',
        fileType:        'action',
        description:     `Ce lien ouvre un document en cliquant sur le bouton « ${doc.actionText} » présent sur la page source.`,
        searchText,
        sourcePageCount,
        sourcePages,
        documentUrl:     null,
        executionType:   'click_visible_document_button',
      });
      continue;
    }

    const filename = getFilename(doc.href);
    const filePath = getUrlPath(doc.href);

    // Frequency map of link texts
    const textFreq = new Map();
    for (const o of doc.occurrences) {
      if (o.linkText) textFreq.set(o.linkText, (textFreq.get(o.linkText) || 0) + 1);
    }

    // Sort: frequency DESC, Latin-script preferred, length ASC
    const sortedTexts = [...textFreq.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        const aLatin = isLatinScript(a[0]) ? 0 : 1;
        const bLatin = isLatinScript(b[0]) ? 0 : 1;
        if (aLatin !== bLatin) return aLatin - bLatin;
        return a[0].length - b[0].length;
      })
      .map(([t]) => t);

    const title = sortedTexts[0] || filenameToTitle(filename) || filename || filePath;

    // Score and cap source pages
    const { selected: sourcePages, totalCount: sourcePageCount } = selectSourcePages(doc.occurrences);

    // Detect pattern from title → filename → link texts
    const pat = detectDocPattern(title, filename, sortedTexts);

    const description = buildDocDescription(title, filename, sourcePages, sortedTexts, pat, lang);
    const searchText  = buildDocSearchText(title, filename, filePath, sourcePages, sortedTexts, pat);

    if (!searchText) continue;

    docs.push({
      id:              'doc_' + shortId(normUrl),
      type:            'document',
      title,
      url:             doc.href,
      path:            filePath,
      filename,
      fileType:        doc.fileType,
      description,
      searchText,
      sourcePageCount,
      sourcePages,
    });
  }

  return { docs, totalOccurrences };
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateResources(resources, origin) {
  const errors      = [];
  const docUrlsSeen = new Set();

  for (const r of resources) {
    if (!r.id)          errors.push(`Missing id: ${String(r.url).slice(0, 60)}`);
    if (!r.type)        errors.push(`Missing type: ${r.id}`);
    if (!r.url)         errors.push(`Missing url: ${r.id}`);
    if (!r.title)       errors.push(`Missing title: ${r.id} — ${r.url}`);
    if (!r.description) errors.push(`Empty description: ${r.id} — ${r.url}`);
    if (!r.searchText)  errors.push(`Empty searchText: ${r.id} — ${r.url}`);

    if (r.type === 'document') {
      const isAction = r.fileType === 'action';
      if (!isAction) {
        if (!isSameHost(r.url, origin))  errors.push(`Cross-origin document: ${r.url}`);
        if (docUrlsSeen.has(r.url))      errors.push(`Duplicate document URL: ${r.url}`);
        docUrlsSeen.add(r.url);
        if (!r.filename)                 errors.push(`Missing filename: ${r.id}`);
        if (!r.fileType)                 errors.push(`Missing fileType: ${r.id}`);
      }
      if (typeof r.sourcePageCount !== 'number')                 errors.push(`Missing sourcePageCount: ${r.id}`);
      if (!Array.isArray(r.sourcePages) || !r.sourcePages.length) errors.push(`Empty sourcePages: ${r.id}`);
    }
  }

  return errors;
}

// ─── Main entry ───────────────────────────────────────────────────────────────

function buildResourceIndex(siteIndex) {
  const agentIndex = siteIndex.agentIndex || [];
  const origin     = siteIndex.meta?.origin || '';

  const siteLang          = detectSiteLang(agentIndex);
  const siteNameFragments = findSiteNameFragments(agentIndex);
  const incomingLinkMap   = buildIncomingLinkMap(agentIndex);
  const pageResources     = buildPageResources(agentIndex, incomingLinkMap, siteNameFragments, siteLang);
  const { docs: docResources, totalOccurrences } = buildDocumentResources(agentIndex, origin, siteLang);

  const resources   = [...pageResources, ...docResources];
  const mergedCount = totalOccurrences - docResources.length;

  const warnings = validateResources(resources, origin);

  const stats = {
    resourceCount:            resources.length,
    pageResourceCount:        pageResources.length,
    documentResourceCount:    docResources.length,
    duplicateDocumentsMerged: mergedCount,
  };

  return { resources, stats, warnings };
}

module.exports = {
  buildResourceIndex,
  buildIncomingLinkMap,
  buildPageResources,
  buildDocumentResources,
  validateResources,
  normalizeText,
  tokenizePath,
  filenameToTitle,
  isSameHost,
  SCHEMA_VERSION,
};
