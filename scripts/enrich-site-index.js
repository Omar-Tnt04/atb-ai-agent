#!/usr/bin/env node
'use strict';
/**
 * enrich-site-index.js — post-processing enrichment for site-index.json
 *
 * Usage:
 *   node scripts/enrich-site-index.js site-context/atb.tn/site-index.json
 *
 * Reads the existing site-index.json (produced by build-site-index.js),
 * calls the shared buildResourceIndex builder, and writes the enriched
 * result back to the same file.
 *
 * Does NOT recrawl the website.
 * All resource-building logic lives in scripts/site-index-resources.js.
 */

const fs   = require('fs');
const path = require('path');
const { buildResourceIndex, SCHEMA_VERSION } = require('./site-index-resources');

function main() {
  const inputArg = process.argv[2];
  if (!inputArg) {
    console.error('Usage: node scripts/enrich-site-index.js <path-to-site-index.json>');
    process.exit(1);
  }

  const absPath = path.resolve(process.cwd(), inputArg);
  if (!fs.existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  console.log(`[enrich] reading ${absPath}`);
  const siteIndex = JSON.parse(fs.readFileSync(absPath, 'utf-8'));

  if (!(siteIndex.agentIndex || []).length) {
    console.error('[enrich] No agentIndex found — run build-site-index.js first');
    process.exit(1);
  }
  console.log(`[enrich] ${siteIndex.agentIndex.length} pages in agentIndex`);

  console.log('[enrich] building resource index...');
  const { resources, stats, warnings } = buildResourceIndex(siteIndex);

  if (warnings.length) {
    console.warn(`[enrich] ${warnings.length} validation warning(s):`);
    warnings.slice(0, 10).forEach(w => console.warn('  -', w));
    if (warnings.length > 10) console.warn(`  ... and ${warnings.length - 10} more`);
  }

  siteIndex.schemaVersion = SCHEMA_VERSION;
  siteIndex.resources     = resources;
  siteIndex.stats         = Object.assign(siteIndex.stats || {}, stats);

  fs.writeFileSync(absPath, JSON.stringify(siteIndex, null, 2), 'utf-8');

  // ─── Report ─────────────────────────────────────────────────────────────────
  const docResources = resources.filter(r => r.type === 'document');
  console.log('');
  console.log('='.repeat(60));
  console.log(`total resources      : ${stats.resourceCount}`);
  console.log(`page resources       : ${stats.pageResourceCount}`);
  console.log(`document resources   : ${stats.documentResourceCount}`);
  console.log(`duplicate docs merged: ${stats.duplicateDocumentsMerged}`);
  if (warnings.length) console.log(`validation warnings  : ${warnings.length}`);

  if (docResources.length) {
    console.log('');
    console.log('[sample documents]');
    for (const [i, d] of docResources.slice(0, 3).entries()) {
      console.log(`\n  ${i + 1}. ${d.title}`);
      console.log(`     id             : ${d.id}`);
      console.log(`     url            : ${d.url}`);
      console.log(`     fileType       : ${d.fileType}`);
      console.log(`     sourcePageCount: ${d.sourcePageCount} (showing ${d.sourcePages.length})`);
      console.log(`     description    : ${d.description.slice(0, 120)}`);
      console.log(`     searchText     : ${d.searchText.slice(0, 80)}`);
      d.sourcePages.slice(0, 2).forEach(s =>
        console.log(`       - "${s.linkText}" ← ${s.title || s.url}`));
    }
  }

  console.log('');
  console.log(`[enrich] written: ${absPath}`);
  console.log('='.repeat(60));
}

main();
