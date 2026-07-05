#!/usr/bin/env node
'use strict';

/**
 * Build a rich, ASK-oriented context without modifying site-index.json.
 *
 * Example:
 *   node scripts/build-site-context.js --url https://example.com \
 *     --out site-context/example.com/context.json --max-pages 200 --max-depth 5
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  PAGE_TYPES,
  cleanText,
  fold,
  unique,
  enrichPageDeterministically,
} = require('./lib/site-context');

const DOCUMENT_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'zip']);
const ASSET_EXTENSIONS = new Set([
  ...DOCUMENT_EXTENSIONS, 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'css', 'js', 'mjs',
  'json', 'xml', 'woff', 'woff2', 'ttf', 'eot', 'mp3', 'mp4', 'webm', 'avi', 'mov',
]);
const UNSAFE_PATH_RE = /(?:^|\/)(?:login|logout|sign-?in|auth|admin|wp-admin|payment|paiement|checkout|transfer|virement|delete|supprimer|confirm)(?:\/|$)/i;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const [rawKey, inline] = item.slice(2).split('=', 2);
    const value = inline !== undefined ? inline : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    args[rawKey] = value;
  }
  const number = (key, fallback, min, max) => {
    const value = Number(args[key] ?? fallback);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`--${key} must be between ${min} and ${max}`);
    return Math.floor(value);
  };
  if (!args.url) throw new Error('--url is required');
  const target = new URL(args.url);
  if (!/^https?:$/.test(target.protocol)) throw new Error('--url must use http or https');
  const out = args.out || path.join('site-context', target.hostname, 'context.json');
  return {
    target,
    out: path.resolve(process.cwd(), out),
    maxPages: number('max-pages', process.env.SITE_CONTEXT_MAX_PAGES || 250, 1, 100000),
    maxDepth: number('max-depth', process.env.SITE_CONTEXT_MAX_DEPTH || 5, 0, 50),
    concurrency: number('concurrency', process.env.SITE_CONTEXT_CONCURRENCY || 3, 1, 12),
    timeout: number('timeout', process.env.SITE_CONTEXT_TIMEOUT_MS || 30000, 1000, 180000),
    settleMs: number('settle-ms', process.env.SITE_CONTEXT_SETTLE_MS || 500, 0, 10000),
    ollama: String(args.ollama || process.env.SITE_CONTEXT_OLLAMA || 'auto').toLowerCase(),
    model: String(args.model || process.env.INTENT_MODEL || process.env.OLLAMA_MODEL || 'gemma3:4b'),
    ollamaBase: String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
  };
}

function normalizedHost(hostname) { return String(hostname || '').toLowerCase().replace(/^www\./, ''); }

function normalizeUrl(raw) {
  const url = new URL(raw);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_|fbclid|gclid|mc_)/i.test(key)) url.searchParams.delete(key);
  }
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
}

function extensionOf(raw) {
  try {
    const leaf = new URL(raw).pathname.split('/').pop() || '';
    return leaf.includes('.') ? leaf.split('.').pop().toLowerCase() : '';
  } catch { return ''; }
}

function isCrawlable(raw, targetHost) {
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return false;
    if (normalizedHost(url.hostname) !== normalizedHost(targetHost)) return false;
    if (ASSET_EXTENSIONS.has(extensionOf(url.href))) return false;
    let pathname = url.pathname;
    try { pathname = decodeURIComponent(pathname); } catch {}
    return !UNSAFE_PATH_RE.test(pathname);
  } catch { return false; }
}

// Runs in the page. Keep this function self-contained.
function extractRichPage() {
  const tidy = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const tidyMultiline = (value) => String(value || '').replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
  const absolute = (value) => { try { return new URL(value, location.href).href.split('#')[0]; } catch { return ''; } };
  const visible = (element) => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && !element.hidden;
  };
  const filename = (url) => { try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { return ''; } };
  const docRe = /\.(pdf|docx?|xlsx?|pptx?|csv|txt|zip)(?:[?#]|$)/i;
  const unsafeAction = /\b(login|logout|payment|transfer|delete|submit|confirm|connexion|paiement|virement|supprimer)\b/i;

  const title = tidy(document.title);
  const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
  const metaDescription = tidy(meta?.getAttribute('content'));
  const language = tidy(document.documentElement.lang).toLowerCase().split('-')[0] || 'unknown';

  const links = [];
  const documents = [];
  const seenLinks = new Set();
  const seenDocs = new Set();
  for (const anchor of document.querySelectorAll('a[href]')) {
    const url = absolute(anchor.getAttribute('href'));
    if (!url) continue;
    const text = tidy(anchor.innerText || anchor.getAttribute('aria-label') || anchor.title);
    if (docRe.test(url)) {
      if (!seenDocs.has(url)) {
        seenDocs.add(url);
        documents.push({ url, text, fileName: filename(url), fileType: (url.match(docRe)?.[1] || '').toLowerCase() });
      }
    } else if (url.startsWith(location.origin) && !seenLinks.has(url)) {
      seenLinks.add(url);
      links.push({ url, text });
    }
  }

  const forms = [];
  for (const form of document.querySelectorAll('form')) {
    if (form.closest('header, nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]')) continue;
    const fields = [...form.querySelectorAll('input, select, textarea')].map((field) => ({
      name: tidy(field.name || field.id),
      type: tidy(field.type || field.tagName).toLowerCase(),
      label: tidy(field.labels?.[0]?.innerText || field.getAttribute('aria-label') || field.placeholder),
      required: !!field.required,
    })).filter((field) => field.name || field.label);
    const formText = tidy(`${form.getAttribute('aria-label') || ''} ${form.id || ''} ${form.className || ''} ${fields.map((field) => `${field.name} ${field.label}`).join(' ')}`);
    if (/\b(search|recherche)\b/i.test(formText)) continue;
    forms.push({
      title: tidy(form.getAttribute('aria-label') || form.querySelector('legend, h1, h2, h3')?.innerText),
      action: absolute(form.getAttribute('action') || location.href),
      method: tidy(form.method || 'get').toLowerCase(),
      fields: fields.slice(0, 80),
    });
  }

  const buttons = [];
  for (const button of document.querySelectorAll('button, [role="button"], input[type="button"]')) {
    if (!visible(button)) continue;
    const text = tidy(button.innerText || button.value || button.getAttribute('aria-label'));
    if (!text || unsafeAction.test(text)) continue;
    buttons.push({ text, type: tidy(button.getAttribute('type') || 'button').toLowerCase() });
  }

  const selectors = [
    'main', 'article', '[role="main"]', '#main', '#content', '.main-content', '.page-content',
    '.content', '.article', '.post', '.entry-content', '.container', 'body',
  ];
  const removalSelectors = [
    'script', 'style', 'svg', 'noscript', 'template', 'canvas', 'iframe',
    'header', 'nav', 'footer', 'aside', '[role="navigation"]', '[role="banner"]',
    '[role="contentinfo"]', '[role="complementary"]', '[role="dialog"]',
    '[aria-hidden="true"]', '[hidden]',
    '[class*="cookie"]', '[id*="cookie"]', '[class*="breadcrumb"]', '[id*="breadcrumb"]',
    '[class*="sidebar"]', '[id*="sidebar"]', '[class*="navbar"]', '[id*="navbar"]',
    '[class*="menu"]', '[id*="menu"]', '[class*="search"]', '[id*="search"]',
    '[class*="banner"]', '[id*="banner"]', '[class*="popup"]', '[id*="popup"]',
    '[class*="social"]', '[id*="social"]', '[class*="share"]', '[id*="share"]',
  ];
  const candidates = [];
  const candidateSeen = new Set();
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (!visible(element) || candidateSeen.has(element)) continue;
      if (element !== document.body && element.closest('header, nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]')) continue;
      candidateSeen.add(element);
      const probe = element.cloneNode(true);
      for (const node of probe.querySelectorAll(removalSelectors.join(','))) node.remove();
      const textLength = tidy(probe.textContent).length;
      if (textLength < 40) continue;
      const contentLinks = [...probe.querySelectorAll('a[href]')]
        .filter((anchor) => !anchor.closest('nav, header, footer, aside, [role="navigation"]'));
      const linkLength = contentLinks.reduce((sum, anchor) => sum + tidy(anchor.textContent).length, 0);
      const paragraphs = probe.querySelectorAll('p, li, dd, td, label').length;
      const headings = probe.querySelectorAll('h1, h2, h3, h4').length;
      const semanticMain = element.matches([
        'main', 'article', '[role="main"]', '#main', '#content', '.main-content',
        '.page-content', '.entry-content',
      ].join(','));
      const score = textLength + paragraphs * 70 + headings * 90
        + contentLinks.length * 15 - linkLength * 0.35;
      candidates.push({ element, score, textLength, paragraphs, headings, semanticMain });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const bestOverall = candidates[0];
  const bestSemantic = candidates.filter((candidate) => candidate.semanticMain)
    .sort((a, b) => b.score - a.score)[0];
  const semanticIsSubstantial = bestSemantic && (
    bestSemantic.textLength >= 120
    || !bestOverall
    || bestSemantic.score >= bestOverall.score * 0.55
  );
  const selected = (semanticIsSubstantial ? bestSemantic : bestOverall)
    || { element: document.body, score: 0, textLength: 0, paragraphs: 0, headings: 0 };
  const root = selected.element?.cloneNode(true) || document.createElement('div');
  let removedNodes = 0;
  for (const node of root.querySelectorAll(removalSelectors.join(','))) { node.remove(); removedNodes++; }
  const textWithBlockBreaks = (node) => {
    const parts = [];
    const blockTags = new Set([
      'address', 'article', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption',
      'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'main', 'p', 'pre',
      'section', 'table', 'tbody', 'td', 'th', 'thead', 'tr',
    ]);
    const walk = (current) => {
      if (current.nodeType === 3) { parts.push(current.nodeValue || ''); return; }
      if (current.nodeType !== 1) return;
      const block = blockTags.has(current.tagName.toLowerCase());
      if (block) parts.push('\n');
      for (const child of current.childNodes) walk(child);
      if (block) parts.push('\n');
    };
    walk(node);
    return tidyMultiline(parts.join(''));
  };

  const rawBlocks = [...root.querySelectorAll('h1, h2, h3, h4, p, li, dt, dd, figcaption, blockquote, pre, td, th, label, a[href]')]
    .map((element) => ({ tag: element.tagName.toLowerCase(), text: tidy(element.innerText || element.textContent) }))
    .filter((block) => block.text.length >= 2 && block.text.length <= 2000);
  const blocks = [];
  const blockSeen = new Set();
  for (const block of rawBlocks) {
    const key = block.text.toLowerCase();
    if (blockSeen.has(key)) continue;
    blockSeen.add(key);
    blocks.push(block);
  }

  const sections = [];
  let current = { heading: '', lines: [] };
  const flush = () => {
    const text = current.lines.join('\n').trim();
    if (current.heading || text) sections.push({ heading: current.heading, text });
  };
  for (const block of blocks) {
    if (/^h[1-4]$/.test(block.tag)) {
      flush();
      current = { heading: block.text, lines: [] };
    } else {
      current.lines.push(block.text);
    }
  }
  flush();
  const headings = uniqueStrings(sections.map((section) => section.heading).filter(Boolean));
  const cleanLines = uniqueStrings(sections.flatMap((section) => [section.heading, ...section.text.split('\n')]).filter(Boolean));
  const fallbackText = textWithBlockBreaks(root);
  const structuredText = cleanLines.join('\n');
  const useFallbackText = !structuredText
    || structuredText.length < 40
    || (fallbackText.length >= 200 && structuredText.length < fallbackText.length * 0.2);
  const mainText = (useFallbackText ? fallbackText : structuredText).slice(0, 60000);
  if (useFallbackText && mainText) {
    sections.splice(0, sections.length, { heading: headings[0] || '', text: mainText });
  } else if (!sections.length && mainText) {
    sections.push({ heading: '', text: mainText });
  }

  const factLike = (line) => /\d|:|\b(permet|offre|propose|comprend|disponible|allows?|offers?|provides?|includes?|required)\b/i.test(line);
  for (const section of sections) {
    section.facts = uniqueStrings(section.text.split('\n').filter((line) => line.length <= 300 && factLike(line))).slice(0, 12);
  }

  const emails = uniqueStrings((mainText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []));
  const phones = uniqueStrings((mainText.match(/(?:\+?\d[\d .()-]{6,}\d)/g) || []).map(tidy));
  const addresses = uniqueStrings(mainText.split('\n').filter((line) => /\b(address|adresse)\s*:/i.test(line)).map(tidy));
  const globalLines = String(document.body?.innerText || '').split(/\n+/).map(tidy).filter(Boolean);
  const hourSource = [...mainText.split('\n'), ...globalLines];
  for (let i = 0; i < globalLines.length; i++) {
    if (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|horaires?|hours?)\b/i.test(globalLines[i])) {
      const joined = globalLines.slice(i, i + 3).join(' ');
      if (/\b\d{1,2}(?::|h)\d{2}\b/.test(joined)) hourSource.push(joined);
    }
  }
  const hours = uniqueStrings(hourSource.filter((line) =>
    line.length <= 500
    &&
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|horaires?|hours?)\b/i.test(line)
    && /\b\d{1,2}(?::|h)\d{2}\b/.test(line),
  ).map(tidy));

  const hasSemanticMain = /^(main|article)$/i.test(selected.element?.tagName || '')
    || selected.element?.matches?.('[role="main"], #main, #content, .main-content, .page-content, .entry-content');
  const confidence = Math.max(0, Math.min(1,
    (mainText.length >= 200 ? 0.35 : mainText.length >= 60 ? 0.15 : 0)
    + (hasSemanticMain ? 0.3 : 0.12)
    + (sections.length >= 2 ? 0.2 : 0.05)
    + (removedNodes > 0 ? 0.1 : 0),
  ));

  return {
    url: location.href,
    path: location.pathname + location.search,
    title,
    metaDescription,
    language,
    headings,
    cleanText: mainText,
    sections: sections.slice(0, 100),
    keyFacts: [],
    keywords: [],
    searchText: '',
    contactFacts: { emails, phones, addresses },
    hours,
    documents: documents.slice(0, 200),
    forms: forms.slice(0, 40),
    buttons: uniqueObjects(buttons, (item) => item.text.toLowerCase()).slice(0, 80),
    links: links.slice(0, 1000),
    contentQuality: {
      hasMainContent: mainText.length >= 60,
      boilerplateRemoved: removedNodes > 0,
      textLength: mainText.length,
      confidence: Number(confidence.toFixed(3)),
    },
    _extraction: { removedNodes, blockCount: blocks.length, selectedScore: Math.round(selected.score || 0) },
  };

  function uniqueStrings(items) {
    const seen = new Set();
    return items.filter((item) => { const key = tidy(item).toLowerCase(); if (!key || seen.has(key)) return false; seen.add(key); return true; });
  }
  function uniqueObjects(items, keyFn) {
    const seen = new Set();
    return items.filter((item) => { const key = keyFn(item); if (!key || seen.has(key)) return false; seen.add(key); return true; });
  }
}

function lineKey(value) { return fold(value).replace(/\d+/g, '#').slice(0, 220); }

function isGenericChromeLine(line) {
  const value = fold(line);
  return /^(?:trouver votre agence|nous contacter|find a branch|contact us|skip to content|menu|navigation)$/.test(value);
}

function removeRepeatedBoilerplate(pages) {
  const counts = new Map();
  for (const page of pages) {
    const pageKeys = new Set(cleanText(page.cleanText).split('\n').map(lineKey).filter((key) => key.length >= 8));
    for (const key of pageKeys) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.1));
  const repeated = new Set([...counts].filter(([, count]) => count >= threshold).map(([key]) => key));
  let removed = 0;
  for (const page of pages) {
    const isHome = page.path === '/' || page.path === '';
    const identityTokens = fold(`${page.path || ''} ${(page.headings || []).join(' ')}`)
      .replace(/-/g, ' ').split(/\s+/)
      .filter((token) => token.length >= 4 && !/^(?:atb|arab|bank|tunisian|page|service|services|produit|produits|presentation|autres)$/.test(token));
    const keepLine = (line) => {
      if (isGenericChromeLine(line)) { removed++; return false; }
      const key = lineKey(line);
      if (!repeated.has(key)) return true;
      const foldedLine = fold(line);
      const compactLine = foldedLine.replace(/\s+/g, '');
      if (identityTokens.some((token) => foldedLine.includes(token) || compactLine.includes(token.replace(/\s+/g, '')))) return true;
      const valuableGlobalFact = /\b\d{1,2}(?::|h)\d{2}\b|@|\+?\d[\d .()-]{6,}/.test(line);
      if (isHome && valuableGlobalFact) return true;
      removed++;
      return false;
    };
    page.sections = (page.sections || []).map((section) => {
      const lines = section.text.split('\n').filter(keepLine);
      return { ...section, text: lines.join('\n'), facts: (section.facts || []).filter(keepLine) };
    }).filter((section) => section.heading || section.text);
    page.cleanText = cleanText(page.sections.flatMap((section) => [section.heading, section.text]).filter(Boolean).join('\n'));
    page.contentQuality.textLength = page.cleanText.length;
    page.contentQuality.hasMainContent = page.cleanText.length >= 60;
  }
  return removed;
}

function removeRepeatedControls(pages) {
  const threshold = Math.max(3, Math.ceil(pages.length * 0.3));
  const docCounts = new Map();
  const formCounts = new Map();
  for (const page of pages) {
    for (const url of new Set((page.documents || []).map((doc) => doc.url))) docCounts.set(url, (docCounts.get(url) || 0) + 1);
    for (const action of new Set((page.forms || []).map((form) => form.action))) formCounts.set(action, (formCounts.get(action) || 0) + 1);
  }
  let removed = 0;
  for (const page of pages) {
    page.documents = (page.documents || []).filter((doc) => {
      if ((docCounts.get(doc.url) || 0) < threshold) return true;
      removed++; return false;
    });
    page.forms = (page.forms || []).filter((form) => {
      const hiddenOnly = (form.fields || []).length > 0 && form.fields.every((field) => field.type === 'hidden');
      if ((formCounts.get(form.action) || 0) < threshold && !hiddenOnly) return true;
      removed++; return false;
    });
  }
  return removed;
}

function removeRepeatedHours(pages) {
  const threshold = Math.max(3, Math.ceil(pages.length * 0.3));
  const counts = new Map();
  for (const page of pages) {
    for (const hour of new Set((page.hours || []).map(lineKey))) counts.set(hour, (counts.get(hour) || 0) + 1);
  }
  let removed = 0;
  for (const page of pages) {
    const identity = fold(`${page.path || ''} ${page.title || ''} ${(page.headings || []).join(' ')}`);
    const relevantPage = page.path === '/' || /\b(hours?|horaires?|branch|branches|agence|agences|contact)\b/.test(identity);
    page.hours = (page.hours || []).filter((hour) => {
      if ((counts.get(lineKey(hour)) || 0) < threshold || relevantPage) return true;
      removed++; return false;
    });
  }
  return removed;
}

function removeRepeatedContacts(pages) {
  const threshold = Math.max(3, Math.ceil(pages.length * 0.1));
  const groups = ['emails', 'phones', 'addresses'];
  const counts = new Map();
  for (const page of pages) {
    for (const group of groups) {
      for (const value of new Set((page.contactFacts?.[group] || []).map(lineKey))) {
        counts.set(`${group}:${value}`, (counts.get(`${group}:${value}`) || 0) + 1);
      }
    }
  }

  let removed = 0;
  for (const page of pages) {
    const identity = fold(`${page.path || ''} ${page.title || ''} ${(page.headings || []).join(' ')}`);
    const relevantPage = page.path === '/' || /\b(contact|coordonnees|address|adresse|branch|branches|agence|agences)\b/.test(identity);
    page.contactFacts = page.contactFacts || { emails: [], phones: [], addresses: [] };
    for (const group of groups) {
      page.contactFacts[group] = (page.contactFacts[group] || []).filter((value) => {
        if ((counts.get(`${group}:${lineKey(value)}`) || 0) < threshold || relevantPage) return true;
        removed++;
        return false;
      });
    }
  }
  return removed;
}

function addStructuredFallbackSections(pages) {
  let recovered = 0;
  for (const page of pages) {
    if (cleanText(page.cleanText).length >= 40) continue;

    const sections = [];
    const hours = unique((page.hours || []).map(cleanText).filter(Boolean));
    if (hours.length) {
      sections.push({ heading: 'Opening hours', text: hours.join('\n'), facts: hours });
    }

    const contact = page.contactFacts || {};
    const contactLines = unique([
      ...(contact.emails || []).map((value) => `Email: ${cleanText(value)}`),
      ...(contact.phones || []).map((value) => `Phone: ${cleanText(value)}`),
      ...(contact.addresses || []).map((value) => `Address: ${cleanText(value)}`),
    ].filter(Boolean));
    if (contactLines.length) {
      sections.push({ heading: 'Contact', text: contactLines.join('\n'), facts: contactLines });
    }

    const documentLines = unique((page.documents || []).map((document) =>
      cleanText(document.text || document.fileName || ''),
    ).filter(Boolean)).slice(0, 100);
    if (documentLines.length) {
      sections.push({
        heading: 'Documents',
        text: documentLines.join('\n'),
        facts: documentLines.map((value) => `Document: ${value}`).slice(0, 24),
      });
    }

    const formLines = unique((page.forms || []).flatMap((form) => {
      const title = cleanText(form.title || '');
      const fields = (form.fields || []).filter((field) => {
        const type = fold(field.type || '');
        const name = fold(field.name || '');
        return !['hidden', 'submit', 'button', 'reset'].includes(type)
          && !/(?:captcha|csrf|token|formaction|btnsubmit)/.test(name);
      }).map((field) => cleanText(field.label || field.name || '')).filter(Boolean);
      return [title, ...fields];
    }).filter(Boolean)).slice(0, 80);
    if (formLines.length) {
      sections.push({ heading: 'Form', text: formLines.join('\n'), facts: formLines.slice(0, 24) });
    }

    if (!sections.length) continue;
    page.sections = [...(page.sections || []), ...sections];
    page.cleanText = cleanText(page.sections.flatMap((section) => [section.heading, section.text]).filter(Boolean).join('\n'));
    page.contentQuality.textLength = page.cleanText.length;
    page.contentQuality.hasMainContent = page.cleanText.length >= 60;
    page.contentQuality.confidence = Number(Math.max(
      page.contentQuality.confidence || 0,
      page.cleanText.length >= 200 ? 0.7 : 0.55,
    ).toFixed(3));
    recovered++;
  }
  return recovered;
}

async function ollamaAvailable(config) {
  if (config.ollama === 'off' || config.ollama === 'false') return false;
  try {
    const response = await fetch(`${config.ollamaBase}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return true;
  } catch (error) {
    if (config.ollama === 'required') throw new Error(`Ollama is required but unavailable: ${error.message}`);
    return false;
  }
}

function parseJsonObject(raw) {
  const text = String(raw || '').replace(/^```(?:json)?/i, '').replace(/```$/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

async function enrichWithOllama(page, config) {
  const allowed = [...PAGE_TYPES].join('|');
  const prompt = `Return strict JSON only: {"pagePurpose":"...","keyFacts":["..."],"keywords":["..."],"pageType":"..."}.\n`
    + `Use only the cleaned page content below. pageType must be one of ${allowed}. Keep pagePurpose under 240 characters and keyFacts factual.\n\n`
    + JSON.stringify({ title: page.title, metaDescription: page.metaDescription, headings: page.headings,
      sections: page.sections, cleanText: page.cleanText.slice(0, 12000) });
  const response = await fetch(`${config.ollamaBase}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, stream: false, format: 'json',
      messages: [{ role: 'user', content: prompt }], options: { temperature: 0, num_predict: 500 } }),
    signal: AbortSignal.timeout(Math.max(5000, config.timeout)),
  });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
  const payload = await response.json();
  const parsed = parseJsonObject(payload?.message?.content);
  if (!parsed) throw new Error('Ollama returned invalid JSON');
  return {
    pagePurpose: typeof parsed.pagePurpose === 'string' ? cleanText(parsed.pagePurpose).slice(0, 300) : '',
    keyFacts: Array.isArray(parsed.keyFacts) ? unique(parsed.keyFacts.map(cleanText)).slice(0, 20) : [],
    keywords: Array.isArray(parsed.keywords) ? unique(parsed.keywords.map(cleanText)).slice(0, 30) : [],
    pageType: PAGE_TYPES.has(parsed.pageType) ? parsed.pageType : '',
  };
}

async function renderPage(browserContext, entry, config) {
  const page = await browserContext.newPage();
  try {
    await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: config.timeout });
    if (config.settleMs) await page.waitForTimeout(config.settleMs);
    const initialTextLength = await page.evaluate(() => String(document.body?.innerText || '').trim().length).catch(() => 0);
    if (initialTextLength < 80) {
      await page.waitForFunction(
        () => String(document.body?.innerText || '').trim().length >= 80,
        null,
        { timeout: Math.min(4000, config.timeout) },
      ).catch(() => {});
      await page.waitForTimeout(250);
    }
    let extracted = await page.evaluate(extractRichPage);
    if (cleanText(extracted.cleanText).length < 80) {
      await page.waitForLoadState('networkidle', { timeout: Math.min(4000, config.timeout) }).catch(() => {});
      await page.waitForTimeout(500);
      const retried = await page.evaluate(extractRichPage);
      if (cleanText(retried.cleanText).length > cleanText(extracted.cleanText).length) extracted = retried;
    }
    return extracted;
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const startUrl = normalizeUrl(config.target.href);
  const queue = [{ url: startUrl, depth: 0 }];
  const seen = new Set([startUrl]);
  const pages = [];
  const failed = [];
  let active = 0;
  let attempted = 0;
  let pagesSkipped = 0;
  let interrupted = false;

  process.on('SIGINT', () => { interrupted = true; console.log('\nStopping after in-flight pages...'); });
  const useOllama = await ollamaAvailable(config);
  console.log(`Ollama enrichment      : ${useOllama ? `enabled (${config.model})` : 'unavailable; deterministic fallback'}`);

  const browser = await chromium.launch({ headless: true });
  const browserContext = await browser.newContext({ userAgent: 'SiteContextBuilder/1.0 (+Playwright)' });

  async function worker() {
    while (!interrupted) {
      if (attempted >= config.maxPages) return;
      const entry = queue.shift();
      if (!entry) {
        if (active === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      if (attempted >= config.maxPages) return;
      attempted++;
      active++;
      try {
        const extracted = await renderPage(browserContext, entry, config);
        const page = { ...extracted, url: normalizeUrl(extracted.url || entry.url), depth: entry.depth };
        pages.push(page);
        if (entry.depth < config.maxDepth) {
          for (const link of page.links || []) {
            let normalized;
            try { normalized = normalizeUrl(link.url); } catch { pagesSkipped++; continue; }
            if (seen.has(normalized)) continue;
            seen.add(normalized);
            if (!isCrawlable(normalized, config.target.hostname)) { pagesSkipped++; continue; }
            if (seen.size > config.maxPages * 30) { pagesSkipped++; continue; }
            queue.push({ url: normalized, depth: entry.depth + 1 });
          }
        }
        console.log(`[${pages.length}/${config.maxPages}] depth=${entry.depth} ${page.url} text=${page.cleanText.length} sections=${page.sections.length}`);
      } catch (error) {
        failed.push({ url: entry.url, error: String(error.message || error).split('\n')[0] });
        console.log(`[failed] ${entry.url} ${failed.at(-1).error}`);
      } finally {
        active--;
      }
    }
  }

  await Promise.all(Array.from({ length: config.concurrency }, worker));
  await browserContext.close().catch(() => {});
  await browser.close().catch(() => {});

  const repeatedRemoved = removeRepeatedBoilerplate(pages);
  const repeatedControlsRemoved = removeRepeatedControls(pages);
  const repeatedHoursRemoved = removeRepeatedHours(pages);
  const repeatedContactsRemoved = removeRepeatedContacts(pages);
  const structuredFallbackPages = addStructuredFallbackSections(pages);
  let modelFailures = 0;
  for (let i = 0; i < pages.length; i++) {
    let model = null;
    if (useOllama && pages[i].cleanText.length >= 40) {
      try { model = await enrichWithOllama(pages[i], config); } catch { modelFailures++; }
    }
    pages[i] = enrichPageDeterministically({
      ...pages[i],
      pagePurpose: model?.pagePurpose || '',
      keyFacts: model?.keyFacts || [],
      keywords: model?.keywords || [],
      pageType: model?.pageType || '',
    });
    delete pages[i]._extraction;
  }
  pages.sort((a, b) => a.url.localeCompare(b.url));

  const output = {
    meta: {
      targetUrl: config.target.href,
      generatedAt: new Date().toISOString(),
      pagesCrawled: pages.length,
      pagesWithMainContent: pages.filter((page) => page.contentQuality.hasMainContent).length,
      documentsFound: pages.reduce((sum, page) => sum + page.documents.length, 0),
      formsFound: pages.reduce((sum, page) => sum + page.forms.length, 0),
      pagesSkipped,
      failedPages: failed.length,
      boilerplateLinesRemoved: repeatedRemoved,
      repeatedControlsRemoved,
      repeatedHoursRemoved,
      repeatedContactsRemoved,
      structuredFallbackPages,
      enrichment: useOllama ? `ollama:${config.model}` : 'deterministic',
      modelFailures,
      options: { maxPages: config.maxPages, maxDepth: config.maxDepth, concurrency: config.concurrency, timeout: config.timeout },
    },
    pages,
    failedUrls: failed,
  };

  fs.mkdirSync(path.dirname(config.out), { recursive: true });
  const temp = `${config.out}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(output, null, 2), 'utf8');
  fs.renameSync(temp, config.out);

  const weak = pages.filter((page) => !page.contentQuality.hasMainContent || page.contentQuality.confidence < 0.4).length;
  const valid = pages.length > 0 && output.meta.pagesWithMainContent > 0;
  console.log('');
  console.log('pages crawled          :', pages.length);
  console.log('pages skipped          :', pagesSkipped);
  console.log('pages with weak content:', weak);
  console.log('boilerplate lines removed:', repeatedRemoved);
  console.log('repeated controls removed:', repeatedControlsRemoved);
  console.log('repeated hours removed   :', repeatedHoursRemoved);
  console.log('repeated contacts removed:', repeatedContactsRemoved);
  console.log('structured pages recovered:', structuredFallbackPages);
  console.log('documents found        :', output.meta.documentsFound);
  console.log('forms found            :', output.meta.formsFound);
  console.log('output path            :', config.out);
  console.log('validation result      :', valid ? 'PASS' : 'FAIL');
  if (!valid) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fatal: ${error.message || error}`);
    process.exit(1);
  });
}

module.exports = {
  addStructuredFallbackSections,
  isCrawlable,
  normalizeUrl,
  removeRepeatedBoilerplate,
  removeRepeatedControls,
  removeRepeatedHours,
  removeRepeatedContacts,
};
