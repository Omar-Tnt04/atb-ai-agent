'use strict';

const _norm = (text) =>
  String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Generic current-page intent patterns — no site-specific names.
const CURRENT_PAGE_PATTERNS = [
  /\b(this|current|active)\s+page\b/i,
  /\bwhat\s+page\s+(am\s+i\s+(on|looking\s+at)|is\s+this)\b/i,
  /\bwhat('?s|\s+is)\s+(on|visible|showing|displayed).{0,30}\b(page|screen)\b/i,
  /\bwhat\s+information\s+(is\s+)?(visible|on\s+this)\b/i,
  /\bwhat\s+links?\s+(are\s+)?(visible|available|on(\s+this(\s+page)?)?)\b/i,
  /\bwhat\s+documents?\s+(are\s+)?(visible|available|on(\s+this(\s+page)?)?)\b/i,
  /\bwhat\s+(do\s+i\s+see|can\s+i\s+see)\s+(here|on\s+this)\b/i,
  /\bwhat('?s|\s+is)\s+(visible|available|showing|here)\s+(on\s+this|here)\b/i,
  // French
  /\bcette\s+page\b/i,
  /\bpage\s+actuelle\b/i,
  /\bvisible\s+sur\s+(cette|la)\s+page\b/i,
  /\bsur\s+(cette|la)\s+page\b/i,
  /\bquels?\s+liens?\s+(sont\s+)?(visibles?|disponibles?)\b/i,
  /\bquels?\s+documents?\s+(sont\s+)?(visibles?|disponibles?)\b/i,
  /\bquelle\s+(est\s+cette\s+)?page\b/i,
];

function isCurrentPageQuestion(message) {
  return CURRENT_PAGE_PATTERNS.some((p) => p.test(message));
}

// Site-wide questions refer to the whole site, not the current page.
// Used to block current-page routing when the user asks about the whole site.
const SITE_WIDE_PATTERNS = [
  /\bon\s+(the|your|this)\s+site\b/i,
  /\bon\s+the\s+website\b/i,
  /\bavailable\s+on\s+(the\s+)?(site|website)\b/i,
  /\bsur\s+le\s+site\b/i,
  /\bsur\s+(votre|le)\s+site\b/i,
  /\bdu\s+site\b/i,
  /\bon\s+your\s+website\b/i,
];

function isSiteWideQuestion(message) {
  return SITE_WIDE_PATTERNS.some((p) => p.test(message));
}

function normalizeSiteContext(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ctx = {
    source: String(raw.source || 'dom'),
    url: String(raw.url || '').slice(0, 500),
    origin: String(raw.origin || '').slice(0, 200),
    title: String(raw.title || '').slice(0, 300),
    language: String(raw.language || ''),
    timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : null,
    headings: Array.isArray(raw.headings) ? raw.headings.slice(0, 30) : [],
    textBlocks: Array.isArray(raw.textBlocks) ? raw.textBlocks.slice(0, 40) : [],
    links: Array.isArray(raw.links) ? raw.links.slice(0, 80) : [],
    downloadLinks: Array.isArray(raw.downloadLinks) ? raw.downloadLinks.slice(0, 40) : [],
    buttons: Array.isArray(raw.buttons) ? raw.buttons.slice(0, 40) : [],
    forms: Array.isArray(raw.forms) ? raw.forms.slice(0, 10) : [],
    contactFacts: raw.contactFacts && typeof raw.contactFacts === 'object' ? {
      emails: Array.isArray(raw.contactFacts.emails) ? raw.contactFacts.emails.slice(0, 10) : [],
      phones: Array.isArray(raw.contactFacts.phones) ? raw.contactFacts.phones.slice(0, 10) : [],
    } : { emails: [], phones: [] },
    stats: raw.stats && typeof raw.stats === 'object' ? raw.stats : {},
  };
  return ctx;
}

function siteContextHasUsefulContent(ctx) {
  if (!ctx) return false;
  return (
    ctx.title.length > 0 ||
    ctx.headings.length > 0 ||
    ctx.textBlocks.length > 0 ||
    ctx.links.length > 0 ||
    ctx.downloadLinks.length > 0
  );
}

function scoreSiteContextRelevance(message, ctx) {
  if (!siteContextHasUsefulContent(ctx)) return 0;
  let score = 0;
  if (isCurrentPageQuestion(message)) score += 0.8;
  if (ctx.url) score += 0.1;
  if (ctx.title) score += 0.05;
  if (ctx.textBlocks.length > 0) score += 0.05;
  return Math.min(score, 1.0);
}

function summarizeSiteContext(ctx) {
  if (!ctx) return '';
  const parts = [];
  if (ctx.title) parts.push(`**${ctx.title}**`);
  if (ctx.url) parts.push(ctx.url);
  const stats = ctx.stats || {};
  const details = [];
  if (stats.headings > 0) details.push(`${stats.headings} heading(s)`);
  if (stats.textBlocks > 0) details.push(`${stats.textBlocks} text block(s)`);
  if (stats.links > 0) details.push(`${stats.links} link(s)`);
  if (stats.downloadLinks > 0) details.push(`${stats.downloadLinks} downloadable file(s)`);
  if (stats.buttons > 0) details.push(`${stats.buttons} button(s)`);
  if (details.length) parts.push(details.join(', '));
  return parts.join(' — ');
}

function formatSiteContextForPrompt(ctx) {
  if (!ctx) return '';
  const lines = ['[CURRENT PAGE CONTEXT]'];
  if (ctx.url) lines.push(`URL: ${ctx.url}`);
  if (ctx.title) lines.push(`Title: ${ctx.title}`);
  if (ctx.language) lines.push(`Language: ${ctx.language}`);
  if (ctx.headings.length > 0) {
    lines.push('\nHeadings:');
    ctx.headings.slice(0, 10).forEach((h) => lines.push(`  H${h.level}: ${h.text}`));
  }
  if (ctx.textBlocks.length > 0) {
    lines.push('\nVisible text:');
    ctx.textBlocks.slice(0, 8).forEach((t) => lines.push(`  - ${t}`));
  }
  if (ctx.links.length > 0) {
    lines.push(`\nNavigation links (${ctx.links.length} total):`);
    ctx.links.slice(0, 10).forEach((l) => lines.push(`  - ${l.text}: ${l.href}`));
  }
  if (ctx.downloadLinks.length > 0) {
    lines.push(`\nDownloadable files (${ctx.downloadLinks.length} total):`);
    ctx.downloadLinks.slice(0, 5).forEach((dl) =>
      lines.push(`  - ${dl.text} (${dl.fileType}): ${dl.href}`),
    );
  }
  if (ctx.contactFacts?.emails?.length > 0)
    lines.push(`\nEmails: ${ctx.contactFacts.emails.join(', ')}`);
  if (ctx.contactFacts?.phones?.length > 0)
    lines.push(`Phones: ${ctx.contactFacts.phones.join(', ')}`);
  return lines.join('\n');
}

// Build a concise template-based answer from siteContext for current-page questions.
// No AI call — purely from structured DOM data.
function buildSiteContextAnswer(message, ctx) {
  if (!ctx) return null;
  const text = _norm(message);

  // "what page am I on?" / "quelle page"
  if (/what\s+page\s+(am\s+i|is\s+this)|quelle.{0,10}page/.test(text)) {
    const titlePart = ctx.title ? ` — ${ctx.title}` : '';
    return ctx.url
      ? `You are on **${ctx.url}**${titlePart}.`
      : `Page: **${ctx.title || 'unknown'}**.`;
  }

  // "what documents/downloads are visible?"
  if (/documents?|downloads?|t[eé]l[eé]charger|fichiers?/.test(text)) {
    if (ctx.downloadLinks.length === 0) {
      return 'No downloadable files found on this page.';
    }
    const lines = [`I can see **${ctx.downloadLinks.length}** downloadable file(s) on this page:`];
    ctx.downloadLinks.slice(0, 5).forEach((dl) => {
      lines.push(`- **${dl.text}** (${dl.fileType.toUpperCase()})`);
    });
    return lines.join('\n');
  }

  // "what links are visible?"
  if (/\blinks?\b|\bliens?\b/.test(text)) {
    if (ctx.links.length === 0) return 'No navigation links found on this page.';
    const lines = [`This page has **${ctx.links.length}** navigation link(s).`];
    if (ctx.downloadLinks.length > 0)
      lines.push(`There are also **${ctx.downloadLinks.length}** downloadable file(s).`);
    return lines.join(' ');
  }

  // Default: general page summary
  const titlePart = ctx.title ? `**${ctx.title}**` : 'this page';
  const urlPart = ctx.url ? ` (${ctx.url})` : '';
  const stats = ctx.stats || {};
  const details = [];
  if (stats.headings > 0) details.push(`${stats.headings} section heading(s)`);
  if (stats.textBlocks > 0) details.push(`${stats.textBlocks} text block(s)`);
  if (stats.links > 0) details.push(`${stats.links} navigation link(s)`);
  if (stats.downloadLinks > 0) details.push(`${stats.downloadLinks} downloadable file(s)`);
  const suffix = details.length > 0 ? ` It includes ${details.join(', ')}.` : '';
  return `This page is ${titlePart}${urlPart}.${suffix}`;
}

module.exports = {
  normalizeSiteContext,
  formatSiteContextForPrompt,
  summarizeSiteContext,
  siteContextHasUsefulContent,
  isCurrentPageQuestion,
  isSiteWideQuestion,
  scoreSiteContextRelevance,
  buildSiteContextAnswer,
};
