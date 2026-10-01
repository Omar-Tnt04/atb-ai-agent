#!/usr/bin/env node
'use strict';
/**
 * validate-site-index.js — validates the enriched site-index.json
 *
 * Checks:
 *  1. schemaVersion exists
 *  2. meta exists
 *  3. stats exists
 *  4. resources exists
 *  5. every resource has id, type, title, url, path, description, searchText
 *  6. type is only page or document
 *  7. document resources have filename, fileType, sourcePageCount, sourcePages
 *  8. no duplicate document URLs
 *  9. all URLs belong to the indexed domain
 * 10. description is not empty
 * 11. searchText is not empty
 * 12. sourcePages is capped (≤10), sourcePageCount preserves true total
 *
 * Usage:
 *   node scripts/validate-site-index.js site-context/atb.tn/site-index.json
 */

const fs   = require('fs');
const path = require('path');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isSameHost(urlStr, origin) {
  try {
    const a = new URL(urlStr).hostname.replace(/^www\./, '');
    const b = new URL(origin).hostname.replace(/^www\./, '');
    return a === b;
  } catch { return false; }
}

const PASS = '✓';
const FAIL = '✗';
const WARN = '⚠';

function check(label, passed, detail = '') {
  const mark = passed ? PASS : FAIL;
  const line = `  ${mark}  ${label}${detail ? `  (${detail})` : ''}`;
  return { passed, line };
}

// ─── Validators ───────────────────────────────────────────────────────────────

function validateStructure(idx) {
  const results = [];
  results.push(check('schemaVersion field present',  !!idx.schemaVersion,
    idx.schemaVersion ? `"${idx.schemaVersion}"` : 'missing — run enrich or rebuild'));
  results.push(check('meta field present',           !!idx.meta));
  results.push(check('stats field present',          !!idx.stats));
  results.push(check('resources field present',      Array.isArray(idx.resources),
    idx.resources ? '' : 'run enrich-site-index.js first'));
  return results;
}

function validateStats(stats, resources) {
  if (!stats || !Array.isArray(resources)) return [];
  const results = [];

  const pages = resources.filter(r => r.type === 'page');
  const docs  = resources.filter(r => r.type === 'document');

  results.push(check(
    'stats.resourceCount matches resources.length',
    stats.resourceCount === resources.length,
    `expected ${resources.length}, got ${stats.resourceCount}`,
  ));
  results.push(check(
    'stats.pageResourceCount matches page count',
    stats.pageResourceCount === pages.length,
    `expected ${pages.length}, got ${stats.pageResourceCount}`,
  ));
  results.push(check(
    'stats.documentResourceCount matches document count',
    stats.documentResourceCount === docs.length,
    `expected ${docs.length}, got ${stats.documentResourceCount}`,
  ));
  results.push(check(
    'stats.duplicateDocumentsMerged present',
    typeof stats.duplicateDocumentsMerged === 'number',
    `got ${typeof stats.duplicateDocumentsMerged}`,
  ));
  return results;
}

function validateResources(resources, origin) {
  if (!Array.isArray(resources)) return { results: [], itemErrors: [] };

  const results    = [];
  const itemErrors = [];

  const REQUIRED_FIELDS     = ['id', 'type', 'title', 'url', 'path', 'description', 'searchText'];
  const REQUIRED_DOC_FIELDS = ['filename', 'fileType', 'sourcePageCount', 'sourcePages'];
  const VALID_TYPES         = new Set(['page', 'document']);
  const MAX_SOURCE_PAGES    = 10;

  const docUrls    = new Map();
  let typeErrors   = 0;
  let missingFields = 0;
  let emptyDesc    = 0;
  let emptySearch  = 0;
  let crossOrigin  = 0;
  let duplicateDocs = 0;
  let sourceCapViolations = 0;

  for (let i = 0; i < resources.length; i++) {
    const r      = resources[i];
    const errors = [];

    // Required fields (checks both missing and empty)
    for (const f of REQUIRED_FIELDS) {
      if (!r[f]) errors.push(`missing/empty field: ${f}`);
    }

    // Valid type
    if (r.type && !VALID_TYPES.has(r.type)) {
      errors.push(`invalid type: "${r.type}"`);
      typeErrors++;
    }

    // description not empty
    if (r.description !== undefined && String(r.description).trim() === '') {
      errors.push('description is empty string');
      emptyDesc++;
    }

    // searchText not empty
    if (r.searchText !== undefined && String(r.searchText).trim() === '') {
      errors.push('searchText is empty string');
      emptySearch++;
    }

    // URL belongs to indexed domain
    if (r.url && !isSameHost(r.url, origin)) {
      errors.push(`cross-origin URL: ${r.url}`);
      crossOrigin++;
    }

    // Document-specific checks
    if (r.type === 'document') {
      for (const f of REQUIRED_DOC_FIELDS) {
        const val = r[f];
        const missing = val === undefined || val === null || val === '' ||
                        (typeof val === 'number' && isNaN(val)) ||
                        (Array.isArray(val) && val.length === 0);
        if (missing) {
          errors.push(`missing/empty document field: ${f}`);
          missingFields++;
        }
      }

      // No duplicate document URLs
      if (r.url) {
        if (docUrls.has(r.url)) {
          errors.push(`duplicate document URL (first seen at index ${docUrls.get(r.url)})`);
          duplicateDocs++;
        } else {
          docUrls.set(r.url, i);
        }
      }

      // sourcePages capped
      if (Array.isArray(r.sourcePages) && r.sourcePages.length > MAX_SOURCE_PAGES) {
        errors.push(`sourcePages has ${r.sourcePages.length} entries — exceeds cap of ${MAX_SOURCE_PAGES}`);
        sourceCapViolations++;
      }

      // sourcePageCount >= sourcePages.length
      if (
        typeof r.sourcePageCount === 'number' &&
        Array.isArray(r.sourcePages) &&
        r.sourcePageCount < r.sourcePages.length
      ) {
        errors.push(`sourcePageCount (${r.sourcePageCount}) < sourcePages.length (${r.sourcePages.length})`);
      }
    }

    if (errors.length) {
      missingFields += errors.filter(e => e.startsWith('missing/empty field')).length;
      itemErrors.push({ index: i, id: r.id || '(no id)', errors });
    }
  }

  const pages = resources.filter(r => r.type === 'page');
  const docs  = resources.filter(r => r.type === 'document');

  results.push(check('all resources have required fields',         missingFields === 0,
    missingFields ? `${missingFields} violation(s)` : ''));
  results.push(check('all types are page or document',            typeErrors === 0,
    typeErrors ? `${typeErrors} invalid type(s)` : ''));
  results.push(check('no empty description',                      emptyDesc === 0,
    emptyDesc ? `${emptyDesc} resource(s)` : ''));
  results.push(check('no empty searchText',                       emptySearch === 0,
    emptySearch ? `${emptySearch} resource(s)` : ''));
  results.push(check('all URLs belong to indexed domain',         crossOrigin === 0,
    crossOrigin ? `${crossOrigin} cross-origin URL(s)` : ''));
  results.push(check('no duplicate document URLs',                duplicateDocs === 0,
    duplicateDocs ? `${duplicateDocs} duplicate(s)` : ''));
  results.push(check('document resources have required doc fields',
    !itemErrors.some(e => e.errors.some(s => s.includes('document field'))), ''));
  results.push(check(`sourcePages capped at ≤${MAX_SOURCE_PAGES}`,  sourceCapViolations === 0,
    sourceCapViolations ? `${sourceCapViolations} document(s) exceed cap` : ''));
  results.push(check(`${pages.length} page resources`,     pages.length > 0));
  results.push(check(`${docs.length} document resources`,  docs.length > 0));

  return { results, itemErrors };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const inputArg = process.argv[2];
  if (!inputArg) {
    console.error('Usage: node scripts/validate-site-index.js <path-to-site-index.json>');
    process.exit(1);
  }

  const absPath = path.resolve(process.cwd(), inputArg);
  if (!fs.existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  let siteIndex;
  try {
    siteIndex = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
  } catch (e) {
    console.error(`Failed to parse JSON: ${e.message}`);
    process.exit(1);
  }

  // Validate the clean format directly, retaining the legacy enriched validator below.
  if (Array.isArray(siteIndex.pages) && Array.isArray(siteIndex.uniqueDocuments)) {
    const { validateCleanIndex } = require('./validate-clean-site-index');
    const errors = validateCleanIndex(siteIndex);
    console.log(`Clean index: ${siteIndex.pages.length} pages, ${siteIndex.uniqueDocuments.length} documents`);
    errors.slice(0, 20).forEach(error => console.error(error));
    console.log(errors.length ? `${errors.length} validation errors` : 'Clean index validation passed');
    process.exit(errors.length ? 1 : 0);
  }

  const origin    = siteIndex.meta?.origin || '';
  const resources = siteIndex.resources;
  const stats     = siteIndex.stats;

  console.log('');
  console.log('='.repeat(60));
  console.log(' site-index validation');
  console.log(`  file          : ${absPath}`);
  console.log(`  origin        : ${origin || '(unknown)'}`);
  console.log(`  schemaVersion : ${siteIndex.schemaVersion || '(missing)'}`);
  console.log('='.repeat(60));

  // ── 1. Structure ──────────────────────────────────────────────────────────
  console.log('\n[1] Top-level structure');
  const structResults = validateStructure(siteIndex);
  structResults.forEach(r => console.log(r.line));

  // ── 2. Stats coherence ────────────────────────────────────────────────────
  console.log('\n[2] Stats coherence');
  const statsResults = validateStats(stats, resources);
  if (statsResults.length === 0) {
    console.log(`  ${WARN}  skipped — resources array missing or stats absent`);
  } else {
    statsResults.forEach(r => console.log(r.line));
  }

  // ── 3. Resource entries ───────────────────────────────────────────────────
  console.log('\n[3] Resource entries');
  const { results: resResults, itemErrors } = validateResources(resources, origin);
  if (!Array.isArray(resources)) {
    console.log(`  ${WARN}  skipped — resources array not present`);
  } else {
    resResults.forEach(r => console.log(r.line));
  }

  // ── Item-level errors (first 10) ──────────────────────────────────────────
  if (itemErrors.length > 0) {
    console.log(`\n[!] First ${Math.min(itemErrors.length, 10)} resource error(s):`);
    itemErrors.slice(0, 10).forEach(({ index, id, errors }) => {
      console.log(`  index ${index}  id=${id}`);
      errors.forEach(e => console.log(`    - ${e}`));
    });
    if (itemErrors.length > 10) {
      console.log(`  ... and ${itemErrors.length - 10} more`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const allChecks = [...structResults, ...statsResults, ...resResults];
  const totalFail = allChecks.filter(r => !r.passed).length;
  const totalPass = allChecks.filter(r =>  r.passed).length;

  console.log('');
  console.log('─'.repeat(60));
  console.log(`  ${totalPass} passed   ${totalFail} failed   ${allChecks.length} total checks`);

  if (totalFail === 0) {
    console.log(`\n  ${PASS}  ALL CHECKS PASSED`);
  } else {
    console.log(`\n  ${FAIL}  VALIDATION FAILED — ${totalFail} check(s) did not pass`);
  }
  console.log('='.repeat(60));
  console.log('');

  process.exit(totalFail > 0 ? 1 : 0);
}

main();
