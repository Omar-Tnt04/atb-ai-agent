#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { PAGE_TYPES, searchSiteContext } = require('./lib/site-context');

const DEFAULT_QUERIES = [
  'opening hours',
  'e-banking services',
  'ATB PAY',
  'customer satisfaction survey',
  'recruitment page',
  'credit products',
  'Crédit Sayara',
  'contact',
  'reclamation',
  'documents utiles',
];

const NAV_START_RE = /^(?:assistance entreprises\s+)?espace particuliers\s+espace professionnels|^(?:menu|navigation|skip to content|trouver votre agence\s+nous contacter)\b/i;

function parseArgs(argv) {
  let file = '';
  let minQueryCoverage = 0.7;
  let minCleanRatio = 0.5;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') file = argv[++i] || '';
    else if (argv[i] === '--min-query-coverage') minQueryCoverage = Number(argv[++i]);
    else if (argv[i] === '--min-clean-ratio') minCleanRatio = Number(argv[++i]);
    else if (!argv[i].startsWith('--') && !file) file = argv[i];
  }
  if (!file) throw new Error('Usage: node scripts/validate-site-context.js <context.json>');
  return { file: path.resolve(process.cwd(), file), minQueryCoverage, minCleanRatio };
}

function validateContext(context, { minQueryCoverage = 0.7, minCleanRatio = 0.5, queries = DEFAULT_QUERIES } = {}) {
  const checks = [];
  const add = (name, passed, detail = '') => checks.push({ name, passed, detail });
  add('meta exists', !!context?.meta);
  add('pages array is not empty', Array.isArray(context?.pages) && context.pages.length > 0,
    `${context?.pages?.length || 0} pages`);
  if (!Array.isArray(context?.pages) || !context.pages.length) return { checks, searches: [], passed: false };

  const pages = context.pages;
  const required = ['url', 'path', 'title', 'pagePurpose', 'cleanText', 'sections', 'keyFacts', 'keywords', 'searchText', 'contentQuality'];
  const invalid = pages.filter((page) => required.some((field) => page[field] === undefined || page[field] === null));
  add('all pages have the rich schema', invalid.length === 0, invalid.length ? `${invalid.length} invalid pages` : '');

  const invalidTypes = pages.filter((page) => !PAGE_TYPES.has(page.pageType));
  add('all pageType values are valid', invalidTypes.length === 0, invalidTypes.length ? `${invalidTypes.length} invalid types` : '');

  const cleanPages = pages.filter((page) => String(page.cleanText || '').trim().length >= 40);
  const cleanRatio = cleanPages.length / pages.length;
  add('most pages have cleanText', cleanRatio >= minCleanRatio, `${(cleanRatio * 100).toFixed(1)}%`);

  const noisyStarts = pages.filter((page) => NAV_START_RE.test(String(page.cleanText || '').trim()));
  add('cleanText does not start with global navigation', noisyStarts.length === 0,
    noisyStarts.length ? `${noisyStarts.length} noisy pages` : '');

  const important = pages.filter((page) => page.cleanText.length >= 200 || page.pageType !== 'other');
  const useful = important.filter((page) => Array.isArray(page.keyFacts) && page.keyFacts.length > 0);
  const factRatio = useful.length / Math.max(important.length, 1);
  add('important pages have useful keyFacts', factRatio >= 0.7, `${useful.length}/${important.length}`);

  const meta = context.meta || {};
  add('meta page count matches pages', meta.pagesCrawled === pages.length,
    `meta=${meta.pagesCrawled} actual=${pages.length}`);
  add('meta includes generatedAt and targetUrl', !!meta.generatedAt && !!meta.targetUrl);

  const searches = queries.map((query) => {
    const results = searchSiteContext(query, context, { limit: 3, minScore: 8 });
    return { query, found: results.length > 0, top: results[0] || null };
  });
  const found = searches.filter((result) => result.found).length;
  const queryCoverage = found / Math.max(searches.length, 1);
  add('search queries retrieve relevant pages', queryCoverage >= minQueryCoverage,
    `${found}/${searches.length} (${(queryCoverage * 100).toFixed(0)}%)`);

  return { checks, searches, passed: checks.every((check) => check.passed) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.file)) throw new Error(`context.json not found: ${args.file}`);
  const context = JSON.parse(fs.readFileSync(args.file, 'utf8'));
  const result = validateContext(context, args);

  console.log(`site-context validation: ${args.file}`);
  for (const check of result.checks) console.log(`  ${check.passed ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? ` (${check.detail})` : ''}`);
  console.log('search checks:');
  for (const search of result.searches) {
    const top = search.top ? `${search.top.page.path} score=${search.top.score}` : 'no match';
    console.log(`  ${search.found ? 'PASS' : 'MISS'} ${search.query} -> ${top}`);
  }
  console.log(`validation result: ${result.passed ? 'PASS' : 'FAIL'}`);
  process.exitCode = result.passed ? 0 : 1;
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`Validation failed: ${error.message || error}`); process.exit(1); }
}

module.exports = { DEFAULT_QUERIES, NAV_START_RE, validateContext };
