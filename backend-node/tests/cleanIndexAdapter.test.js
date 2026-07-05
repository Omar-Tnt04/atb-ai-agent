/**
 * cleanIndexAdapter.test.js — manual checks that the backend reads the clean
 * site-index.json (scripts/clean-site-index.js output: pages/uniqueDocuments/
 * uniqueDocumentActions/uniqueBusinessForms) via siteIndexAdapter.service.js,
 * with no changes needed in siteIndexAgent.service.js's scoring/decision logic.
 *
 * Run: node tests/cleanIndexAdapter.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const A = require('../src/services/siteIndexAgent.service');
const { isCleanFormat, adaptSiteIndex, getPages, getDocuments, getDocumentActions, getForms } =
  require('../src/services/siteIndexAdapter.service');

const DOMAIN = 'atb.tn';
const INDEX = path.resolve(__dirname, '..', '..', 'site-context', DOMAIN, 'site-index.json');

function decide(message, intent) {
  return A.decideAction(message, { intent, allowedDomain: DOMAIN });
}

// ---------------------------------------------------------------------------
// 1 — the on-disk index is the clean shape, and the adapter recognizes it
// ---------------------------------------------------------------------------
function testCleanFormatDetected() {
  const raw = JSON.parse(fs.readFileSync(INDEX, 'utf-8'));
  assert.ok(isCleanFormat(raw), 'site-index.json must be the clean shape (uniqueDocuments present)');
  assert.ok(Array.isArray(raw.uniqueDocuments) && raw.uniqueDocuments.length > 0, 'uniqueDocuments non-empty');
  console.log('  ✓ 1. site-index.json detected as clean format');
}

// ---------------------------------------------------------------------------
// 2 — accessors expose pages/documents/documentActions/forms from the clean index
// ---------------------------------------------------------------------------
function testAccessors() {
  const raw = JSON.parse(fs.readFileSync(INDEX, 'utf-8'));
  assert.strictEqual(getPages(raw), raw.pages, 'getPages must read index.pages');
  assert.strictEqual(getDocuments(raw), raw.uniqueDocuments, 'getDocuments must read index.uniqueDocuments (clean path)');
  assert.strictEqual(getDocumentActions(raw), raw.uniqueDocumentActions, 'getDocumentActions must read index.uniqueDocumentActions');
  assert.strictEqual(getForms(raw), raw.uniqueBusinessForms, 'getForms must read index.uniqueBusinessForms');
  console.log('  ✓ 2. accessors read pages/uniqueDocuments/uniqueDocumentActions/uniqueBusinessForms');
}

// ---------------------------------------------------------------------------
// 3 — adaptSiteIndex reconstructs resources[]/documentOccurrences[] and
//     per-page documentLinks/documentActions/forms from the clean shape
// ---------------------------------------------------------------------------
function testAdaptReconstructsRawShape() {
  const raw = JSON.parse(fs.readFileSync(INDEX, 'utf-8'));
  const adapted = adaptSiteIndex(raw);
  assert.ok(Array.isArray(adapted.resources) && adapted.resources.length > 0, 'resources[] reconstructed');
  assert.ok(Array.isArray(adapted.documentOccurrences) && adapted.documentOccurrences.length > 0, 'documentOccurrences[] reconstructed');
  const contactPage = adapted.pages.find((p) => p.url === 'https://atb.tn/contact');
  assert.ok(contactPage, 'contact page present');
  assert.ok(Array.isArray(contactPage.documentLinks), 'page.documentLinks reattached');
  assert.ok(Array.isArray(contactPage.documentActions), 'page.documentActions reattached');
  assert.ok(Array.isArray(contactPage.forms), 'page.forms reattached');
  console.log(`  ✓ 3. adaptSiteIndex reconstructed resources=${adapted.resources.length} occurrences=${adapted.documentOccurrences.length}`);
}

// ---------------------------------------------------------------------------
// 4 — pass-through: a raw/enriched (non-clean) index is returned unchanged
// ---------------------------------------------------------------------------
function testRawFormatPassThrough() {
  const rawShaped = { meta: {}, resources: [{ type: 'page', url: 'https://x.tn/', title: 'X' }], documentOccurrences: [] };
  const out = adaptSiteIndex(rawShaped);
  assert.strictEqual(out, rawShaped, 'non-clean index must pass through unchanged (fallback path)');
  console.log('  ✓ 4. raw/enriched index format passes through unmodified');
}

// ---------------------------------------------------------------------------
// 5 — the four required end-to-end requests, through the real backend pipeline
// ---------------------------------------------------------------------------
async function testFourRequiredRequests() {
  // "Open the contact page"
  const contact = await decide('Open the contact page', {
    action: 'open_page',
    requestDescription: 'page de contact',
  });
  assert.ok(contact.found, 'contact page must be found');
  assert.strictEqual(contact.action.type, 'navigate');
  assert.ok(/contact/i.test(contact.action.url), `expected contact page, got ${contact.action.url}`);
  console.log(`  ✓ 5a. "Open the contact page" → navigate (${contact.action.url})`);

  // "Find the ATB Messenger subscription form"
  const messenger = await decide('Find the ATB Messenger subscription form', {
    action: 'open_document',
    requestDescription: "formulaire d'abonnement au service ATB Messenger",
  });
  assert.ok(messenger.found, 'messenger form must be found');
  assert.ok(['navigate_then_download', 'download'].includes(messenger.action.type), `expected doc action, got ${messenger.action.type}`);
  const messengerUrl = messenger.action.documentUrl || messenger.action.url;
  assert.ok(/messenger/i.test(`${messenger.action.title} ${messengerUrl}`), `expected messenger doc, got ${messengerUrl}`);
  console.log(`  ✓ 5b. "Find the ATB Messenger subscription form" → ${messenger.action.type} (${messengerUrl})`);

  // "Find the agency list document"
  const agencyDoc = await decide('Find the agency list document', {
    action: 'open_document',
    requestDescription: 'liste des agences ATB par région',
  });
  assert.ok(agencyDoc.found, 'agency list document must be found');
  assert.ok(['navigate_then_download', 'download'].includes(agencyDoc.action.type), `expected doc action, got ${agencyDoc.action.type}`);
  const agencyUrl = agencyDoc.action.documentUrl || agencyDoc.action.url;
  assert.ok(/agence/i.test(`${agencyDoc.action.title} ${agencyUrl}`), `expected agency doc, got ${agencyUrl}`);
  console.log(`  ✓ 5c. "Find the agency list document" → ${agencyDoc.action.type} (${agencyUrl})`);

  // "Open the exchange rates page"
  const rates = await decide('Open the exchange rates page', {
    action: 'open_page',
    requestDescription: 'taux de change devises',
  });
  assert.ok(rates.found, 'exchange rates page must be found');
  assert.strictEqual(rates.action.type, 'navigate');
  assert.ok(/devise/i.test(rates.action.url), `expected devise page, got ${rates.action.url}`);
  console.log(`  ✓ 5d. "Open the exchange rates page" → navigate (${rates.action.url})`);
}

async function run() {
  console.log('cleanIndexAdapter.test.js');
  console.log('');
  if (!fs.existsSync(INDEX)) {
    console.error(`SKIP: ${INDEX} missing.`);
    process.exit(1);
  }
  testCleanFormatDetected();
  testAccessors();
  testAdaptReconstructsRawShape();
  testRawFormatPassThrough();
  await testFourRequiredRequests();
  console.log('\nAll cleanIndexAdapter checks passed.');
}

run().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
