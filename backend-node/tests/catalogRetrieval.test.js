'use strict';
// ASK-mode catalog.json retrieval + combined (ask-context + catalog) answer.
// Pure: no server, no model, no Ollama, no Laragon — catalog is injected.
// Run: node backend-node/tests/catalogRetrieval.test.js
const assert = require('assert');
const { retrieveCatalogEntries } = require('../src/services/catalogRetrieval.service');
const { buildCombinedAnswer, NOT_ENOUGH_INFO } = require('../src/services/askContext.service');

// Injected catalog (generic resources; description-only schema like the real one).
const catalog = [
  {
    id: 'sme_current_account', title: 'SME Current Account Product Sheet',
    category: 'business_accounts',
    description: 'Fees, overdraft terms and eligibility for the small and medium enterprise current account.',
    exampleQueries: ['sme current account fees', 'business account overdraft'],
    files: [{ folder: 'json', fileName: 'sme_current_account.json', fileType: 'json' }],
  },
  {
    id: 'student_pack', title: 'Student Pack',
    category: 'youth',
    description: 'Youth banking pack with free card and mobile banking for students.',
    exampleQueries: ['student pack', 'youth account'],
    files: [{ folder: 'json', fileName: 'student_pack.json', fileType: 'json' }],
  },
  {
    id: 'branch_queue_ticket', title: 'Branch Queue Ticket',
    category: 'branch',
    description: 'Image of a branch queue ticket with queue number and estimated wait.',
    exampleQueries: ['branch queue ticket', 'queue number estimated wait'],
    files: [{ folder: 'images', fileName: 'branch_queue_ticket.png', fileType: 'image', mimeType: 'image/png' }],
  },
];

(async () => {
  // ── catalog retrieval selects the on-topic entry ─────────────────────────────
  const smeHits = await retrieveCatalogEntries('what are the fees and overdraft for an SME current account?', { catalog });
  assert.ok(smeHits.length > 0, 'should retrieve at least one catalog entry');
  assert.strictEqual(smeHits[0].id, 'sme_current_account', 'top entry should be the SME account');
  assert.strictEqual(smeHits[0].source, 'catalog.json', 'entries are labeled source=catalog.json');
  assert.ok(smeHits[0].evidence && /overdraft/i.test(smeHits[0].evidence), 'evidence carries the description');

  const studentHits = await retrieveCatalogEntries('is there a student youth pack?', { catalog });
  assert.strictEqual(studentHits[0].id, 'student_pack');
  assert.strictEqual((await retrieveCatalogEntries('what is my queue number on the branch queue ticket?', { catalog })).length, 0);

  // Unrelated query → no catalog match.
  assert.strictEqual((await retrieveCatalogEntries('lattice gauge chromodynamics', { catalog })).length, 0);

  // Missing/offline catalog (no override, env path absent in test) → [] not throw.
  const offline = await retrieveCatalogEntries('sme current account');
  assert.ok(Array.isArray(offline), 'offline catalog returns an array (empty), never throws');

  // ── combined answer merges ask-context + catalog with labeled sources ────────
  const askBlocks = [{
    block: {
      id: 'comptes', url: 'https://example.tn/comptes', title: 'Accounts',
      richContext: 'Accounts page listing account types.',
      keyPoints: [{ point: 'Offers a business current account', evidence: 'compte courant entreprise' }],
      usefulForQuestionsAbout: ['accounts'],
    },
    score: 0.5,
  }];

  // Both sources contribute.
  const both = buildCombinedAnswer('SME current account fees and page', { askBlocks, catalogEntries: smeHits });
  assert.strictEqual(both.answered, true);
  assert.ok(/Source: ask-context\.json —/.test(both.answer), 'labels the ask-context source');
  assert.ok(/Source: catalog\.json/.test(both.answer), 'labels the catalog source');
  assert.ok(/id=sme_current_account/.test(both.answer), 'catalog source includes id');

  // ask-context only.
  const webOnly = buildCombinedAnswer('accounts page', { askBlocks, catalogEntries: [] });
  assert.ok(webOnly.answered && /ask-context\.json/.test(webOnly.answer) && !/catalog\.json/.test(webOnly.answer));

  // catalog only.
  const catOnly = buildCombinedAnswer('sme fees', { askBlocks: [], catalogEntries: smeHits });
  assert.ok(catOnly.answered && /catalog\.json/.test(catOnly.answer) && !/ask-context\.json/.test(catOnly.answer));

  // neither → not-enough-info (mentions both site context and catalog).
  const none = buildCombinedAnswer('unrelated', { askBlocks: [], catalogEntries: [] });
  assert.strictEqual(none.answered, false);
  assert.strictEqual(none.answer, NOT_ENOUGH_INFO);
  assert.ok(/site context or catalog/.test(none.answer), 'not-enough message mentions catalog');

  console.log('catalogRetrieval: all assertions passed');
})().catch((err) => { console.error(err); process.exit(1); });
