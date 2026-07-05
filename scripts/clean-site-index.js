#!/usr/bin/env node
'use strict';

/**
 * clean-site-index.js
 *
 * Standalone utility: reads an existing raw crawler dump and writes a
 * deduplicated index for the AI agent. The crawler is never invoked here.
 *
 * build-site-index.js no longer needs this — it deduplicates in memory and
 * writes the clean index directly. This script stays for cleaning an old raw
 * dump you already have on disk, reusing the same dedup logic via
 * scripts/lib/site-index-clean.js.
 *
 *   node scripts/clean-site-index.js
 *
 * Reads:  site-context/atb.tn/site-index.json
 * Writes: site-context/atb.tn/site-index.clean.json  (raw file is left untouched)
 */

const fs = require('fs');
const path = require('path');
const { cleanSiteIndex } = require('./lib/site-index-clean');

const RAW_PATH = path.join(process.cwd(), 'site-context', 'atb.tn', 'site-index.json');
const CLEAN_PATH = path.join(process.cwd(), 'site-context', 'atb.tn', 'site-index.clean.json');

function main() {
  if (!fs.existsSync(RAW_PATH)) {
    console.error('Raw index not found:', RAW_PATH);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(RAW_PATH, 'utf8'));

  const output = cleanSiteIndex({
    meta: {
      domain: raw.meta ? raw.meta.domain : '',
      targetUrl: raw.meta ? raw.meta.targetUrl : '',
      sourceFile: path.relative(process.cwd(), RAW_PATH),
      rawGeneratedAt: raw.meta ? raw.meta.generatedAt : '',
      generatedAt: new Date().toISOString(),
      status: raw.meta ? raw.meta.status : '',
    },
    pages: raw.pages,
    failedUrls: raw.failedUrls,
    urlsDiscovered: raw.stats ? raw.stats.urlsDiscovered : undefined,
  });

  fs.writeFileSync(CLEAN_PATH, JSON.stringify(output, null, 2), 'utf8');

  console.log('raw file             :', RAW_PATH, '(unchanged)');
  console.log('clean file           :', CLEAN_PATH);
  console.log('pages                :', output.pages.length);
  console.log('unique documents     :', output.uniqueDocuments.length, `(from ${output.cleanStats.documentOccurrencesFound} occurrences)`);
  console.log('unique doc actions   :', output.uniqueDocumentActions.length, `(from ${output.cleanStats.documentActionOccurrencesFound} occurrences)`);
  console.log('unique forms         :', output.uniqueForms.length, `(from ${output.cleanStats.formOccurrencesFound} occurrences)`);
  console.log('unique business forms:', output.uniqueBusinessForms.length);
}

main();
