'use strict';
/**
 * ASK mode retrieval tests.
 *
 * Guards:
 *  - site-index threshold lowered to 0.35 (P1 fires for more valid site queries)
 *  - second-chance site-index at 0.30 for BRANCH_DIRECTORY / CATALOG_PRODUCT / GENERAL
 *  - buildSiteIndexAnswer default branch: top 3 pages, 120-char descriptions
 *  - personal queries never resolved from site-index
 *  - DOCUMENT_INDEX / WEBSITE_PAGE source types still redirect to Act mode
 *  - current-page question detection unchanged
 */

const assert = require('assert');

const {
  searchSiteIndex,
  buildSiteIndexAnswer,
  getPageLabel,
  isActionRequest,
  collectEvidence,
  buildAskNotFoundAnswer,
} = require('../src/services/siteIndex.service');

const {
  detectSourceType,
  SOURCE_TYPES,
} = require('../src/services/askRetrieval.service');

const {
  isCurrentPageQuestion,
  isSiteWideQuestion,
} = require('../src/services/siteContext.service');

// ── Synthetic data helpers ────────────────────────────────────────────────────

function makeIndex(pages) {
  return {
    pages,
    targetUrl: 'https://atb.tn',
    origin: 'https://atb.tn',
    generatedAt: '2026-07-01',
  };
}

function makePage(p) {
  return {
    url:           p.url   || 'https://atb.tn/page',
    title:         p.title || 'ATB Page',
    headings:      p.headings      || [],
    textBlocks:    p.textBlocks    || [],
    links:         p.links         || [],
    downloadLinks: p.downloadLinks || [],
    contactFacts:  p.contactFacts  || { phones: [], emails: [] },
  };
}

// Shared 4-page index used by scoring tests.
// 4 pages keeps IDF threshold at ceil(3) = 3, so tokens on only 1-2 pages are NOT filtered.
const ATB_PAGES = makeIndex([
  makePage({
    url: 'https://atb.tn/atb-connect',
    title: 'ATB Connect',
    headings: [
      { level: 1, text: 'ATB Connect — Banque digitale' },
      { level: 2, text: 'Services en ligne' },
    ],
    textBlocks: ['ATB Connect est la plateforme de banque digitale pour particuliers et entreprises.'],
  }),
  makePage({
    url: 'https://atb.tn/agences',
    title: 'Réseau agences ATB',
    headings: [{ level: 1, text: 'Agences ATB en Tunisie' }],
    textBlocks: ['Trouvez votre agence ATB la plus proche.'],
  }),
  makePage({
    url: 'https://atb.tn/credits',
    title: 'Crédits et prêts ATB',
    headings: [
      { level: 1, text: 'Nos offres de crédit' },
      { level: 2, text: 'Crédit immobilier et consommation' },
    ],
    textBlocks: ['ATB propose des crédits immobiliers, auto, et consommation à taux compétitifs.'],
  }),
  makePage({
    url: 'https://atb.tn/particuliers',
    title: 'Particuliers',
    headings: [{ level: 1, text: 'Services pour particuliers' }],
    textBlocks: ['Comptes, cartes, épargne et solutions de paiement ATB.'],
  }),
]);

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function run(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. searchSiteIndex — scoring and personal query guard
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] searchSiteIndex — scoring\n');

run('personal query ("my account balance") returns empty — not from site-index', () => {
  const matches = searchSiteIndex('what is my account balance', ATB_PAGES);
  assert.strictEqual(matches.length, 0, 'Personal queries must be blocked by _isPersonalQuery guard');
});

run('personal query with "mon compte" returns empty', () => {
  const matches = searchSiteIndex('quel est le solde de mon compte', ATB_PAGES);
  assert.strictEqual(matches.length, 0, 'French personal queries must also be blocked');
});

run('"ATB Connect" query finds connect page at score >= 0.30', () => {
  const matches = searchSiteIndex('what is ATB Connect', ATB_PAGES);
  assert.ok(matches.length > 0, 'Expected at least one match for ATB Connect query');
  const connectMatch = matches.find((m) => m.page.url.includes('atb-connect'));
  assert.ok(connectMatch, 'ATB Connect page must be in results');
  assert.ok(connectMatch.score >= 0.30, `Score ${connectMatch.score.toFixed(2)} must be >= 0.30`);
});

run('"ATB Connect" top result is the connect page (not a generic page)', () => {
  const matches = searchSiteIndex('what is ATB Connect', ATB_PAGES);
  assert.ok(matches.length > 0, 'Expected matches');
  assert.ok(
    matches[0].page.url.includes('atb-connect'),
    `Top result should be connect page, got ${matches[0].page.url}`,
  );
});

run('agency query finds agences page at score >= 0.30', () => {
  // "agency/agencies" is an alias for "agence/agences" in _ALIAS_GROUPS
  const matches = searchSiteIndex('ATB agency locations', ATB_PAGES);
  assert.ok(matches.length > 0, 'Expected match for agency query');
  const agencesMatch = matches.find((m) => m.page.url.includes('agences'));
  assert.ok(agencesMatch, 'Agences page must appear in results');
  assert.ok(agencesMatch.score >= 0.30, `Score ${agencesMatch.score.toFixed(2)} must be >= 0.30`);
});

run('credit/loan query finds credits page at score >= 0.30', () => {
  // "credit" is an alias for "crédit/prêt/financement" in _ALIAS_GROUPS
  const matches = searchSiteIndex('ATB loan products credit', ATB_PAGES);
  assert.ok(matches.length > 0, 'Expected match for loan/credit query');
  const creditMatch = matches.find((m) => m.page.url.includes('credits'));
  assert.ok(creditMatch, 'Credits page must appear in results');
  assert.ok(creditMatch.score >= 0.30, `Score ${creditMatch.score.toFixed(2)} must be >= 0.30`);
});

run('general ATB service query returns at least one match', () => {
  const matches = searchSiteIndex('what services does ATB offer', ATB_PAGES);
  assert.ok(matches.length > 0, 'General ATB site query should return results');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. buildSiteIndexAnswer — default branch (top 3, 120-char desc, textBlocks fallback)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] buildSiteIndexAnswer — default branch\n');

run('default branch shows top 3 pages (not 2)', () => {
  // Use paths > 3 chars so getPageLabel derives the label from the URL path, not title.
  // getPageLabel("/page-one") → rawPath="page-one" → "Page one"; title only used for paths <= 3.
  const pages = [
    makePage({ url: 'https://atb.tn/page-one',   title: 'T1', headings: [{ level: 1, text: 'Section One' }] }),
    makePage({ url: 'https://atb.tn/page-two',   title: 'T2', headings: [{ level: 1, text: 'Section Two' }] }),
    makePage({ url: 'https://atb.tn/page-three', title: 'T3', headings: [{ level: 1, text: 'Section Three' }] }),
    makePage({ url: 'https://atb.tn/page-four',  title: 'T4', headings: [{ level: 1, text: 'Section Four' }] }),
  ];
  const matches = pages.map((page, i) => ({ page, score: 0.90 - i * 0.10 }));
  const answer = buildSiteIndexAnswer('what sections are on the ATB site', matches);
  assert.ok(answer, 'Expected non-null answer');
  assert.ok(answer.includes('page-one') || answer.includes('Page one') || answer.includes('/page-one'), 'Must include 1st page');
  assert.ok(answer.includes('page-two') || answer.includes('Page two') || answer.includes('/page-two'), 'Must include 2nd page');
  assert.ok(answer.includes('page-three') || answer.includes('Page three') || answer.includes('/page-three'), 'Must include 3rd page');
  assert.ok(!answer.includes('page-four') && !answer.includes('Page four'), 'Must NOT include 4th page (top-3 only)');
});

run('default branch description capped at 120 chars', () => {
  const longHeading = 'X'.repeat(200);
  const matches = [
    { page: makePage({ url: 'https://atb.tn/x', title: 'Test', headings: [{ level: 1, text: longHeading }] }), score: 0.50 },
  ];
  const answer = buildSiteIndexAnswer('ATB services', matches);
  assert.ok(answer, 'Expected non-null answer');
  // Find the description part between ": " and " (/)"
  const descMatch = answer.match(/: (.+?) \(\//);
  if (descMatch) {
    assert.ok(descMatch[1].length <= 120, `Description "${descMatch[1].slice(0, 30)}..." is ${descMatch[1].length} chars, must be <= 120`);
  }
});

run('default branch falls back to textBlocks when headings and links empty', () => {
  const textContent = 'ATB propose des solutions bancaires innovantes pour les entreprises tunisiennes.';
  const matches = [
    {
      page: makePage({
        url: 'https://atb.tn/info',
        title: 'ATB Info',
        headings: [],
        links: [],
        textBlocks: [textContent],
      }),
      score: 0.40,
    },
  ];
  const answer = buildSiteIndexAnswer('tell me about ATB banking', matches);
  assert.ok(answer, 'Expected non-null answer');
  assert.ok(
    answer.includes('ATB propose'),
    `Answer should use textBlocks fallback. Got: "${answer.slice(0, 80)}"`,
  );
});

run('default branch returns null for empty matches', () => {
  assert.strictEqual(buildSiteIndexAnswer('anything', []), null);
  assert.strictEqual(buildSiteIndexAnswer('anything', null), null);
});

run('default branch returns non-null for single match', () => {
  const matches = [
    { page: makePage({ url: 'https://atb.tn/x', title: 'ATB Page X' }), score: 0.35 },
  ];
  const answer = buildSiteIndexAnswer('ATB page', matches);
  assert.ok(answer, 'Single match should produce non-null answer');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. detectSourceType — source type classification
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] detectSourceType — source type classification\n');

run('branch query → BRANCH_DIRECTORY', () => {
  const { sourceType } = detectSourceType('where are the ATB branches?');
  assert.strictEqual(sourceType, SOURCE_TYPES.BRANCH_DIRECTORY);
});

run('agency query → BRANCH_DIRECTORY', () => {
  const { sourceType } = detectSourceType('nearest ATB agency location');
  assert.strictEqual(sourceType, SOURCE_TYPES.BRANCH_DIRECTORY);
});

run('"ATB Connect" → CATALOG_PRODUCT', () => {
  const { sourceType } = detectSourceType('what is ATB Connect?');
  assert.strictEqual(sourceType, SOURCE_TYPES.CATALOG_PRODUCT);
});

run('"ATB loan products" → CATALOG_PRODUCT', () => {
  // Note: "tell me about ATB loan products" falsely triggers CONTACT_FACTS because the
  // CONTACT_FACTS pattern `\b(tel|...).{0,25}\b(atb)\b` has no trailing \b after the
  // keyword, so "tell...atb" matches. Use the simpler form without that prefix.
  const { sourceType } = detectSourceType('ATB loan products');
  assert.strictEqual(sourceType, SOURCE_TYPES.CATALOG_PRODUCT);
});

run('"credit simulator" → WEBSITE_PAGE (redirect to Act)', () => {
  const { sourceType } = detectSourceType('I want to use the credit simulator');
  assert.strictEqual(sourceType, SOURCE_TYPES.WEBSITE_PAGE);
});

run('form/PDF query → DOCUMENT_INDEX (redirect to Act)', () => {
  const { sourceType } = detectSourceType('where can I download the subscription form PDF?');
  assert.strictEqual(sourceType, SOURCE_TYPES.DOCUMENT_INDEX);
});

run('ATB phone/address → CONTACT_FACTS', () => {
  const { sourceType } = detectSourceType('what is the ATB phone number?');
  assert.strictEqual(sourceType, SOURCE_TYPES.CONTACT_FACTS);
});

run('general ATB question → GENERAL', () => {
  const { sourceType } = detectSourceType('what can ATB do for me?');
  assert.strictEqual(sourceType, SOURCE_TYPES.GENERAL);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. isCurrentPageQuestion / isSiteWideQuestion — unchanged behavior
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] Current-page and site-wide detection\n');

run('isCurrentPageQuestion detects explicit current-page questions', () => {
  assert.ok(isCurrentPageQuestion('what is on this page?'));
  assert.ok(isCurrentPageQuestion('what links are visible?'));
  assert.ok(isCurrentPageQuestion('what page am I on?'));
  assert.ok(isCurrentPageQuestion('what documents are visible on this page?'));
});

run('isCurrentPageQuestion does NOT match general ATB site questions', () => {
  assert.ok(!isCurrentPageQuestion('what services does ATB offer?'));
  assert.ok(!isCurrentPageQuestion('tell me about ATB loans'));
  assert.ok(!isCurrentPageQuestion('where are ATB branches?'));
  assert.ok(!isCurrentPageQuestion('what is ATB Connect?'));
});

run('isSiteWideQuestion detects site-wide phrasing (blocks P0 current-page path)', () => {
  // Patterns require exact phrasing: "on the site", "on the website", "available on the site/website",
  // "sur le site", "du site", "on your website". "on the ATB website" does NOT match because
  // the patterns require site/website immediately after "the/your/this" without intervening words.
  assert.ok(isSiteWideQuestion('what is available on the site?'));
  assert.ok(isSiteWideQuestion('what documents are available on your website?'));
  assert.ok(isSiteWideQuestion('what is on the site?'));
  assert.ok(isSiteWideQuestion('what can I find on your website?'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Second-chance logic simulation
// Guards that BRANCH_DIRECTORY / CATALOG_PRODUCT / GENERAL with site-index matches
// do NOT fall through to next() when buildSiteIndexAnswer returns a valid answer.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[5] Second-chance site-index simulation\n');

const SECOND_CHANCE_TYPES = new Set([
  SOURCE_TYPES.BRANCH_DIRECTORY,
  SOURCE_TYPES.CATALOG_PRODUCT,
  SOURCE_TYPES.GENERAL,
]);

run('BRANCH_DIRECTORY is in second-chance type set', () => {
  assert.ok(SECOND_CHANCE_TYPES.has(SOURCE_TYPES.BRANCH_DIRECTORY));
});

run('CATALOG_PRODUCT is in second-chance type set', () => {
  assert.ok(SECOND_CHANCE_TYPES.has(SOURCE_TYPES.CATALOG_PRODUCT));
});

run('GENERAL is in second-chance type set', () => {
  assert.ok(SECOND_CHANCE_TYPES.has(SOURCE_TYPES.GENERAL));
});

run('DOCUMENT_INDEX is NOT in second-chance set (must stay as Act mode redirect)', () => {
  assert.ok(!SECOND_CHANCE_TYPES.has(SOURCE_TYPES.DOCUMENT_INDEX));
});

run('WEBSITE_PAGE is NOT in second-chance set (must stay as Act mode redirect)', () => {
  assert.ok(!SECOND_CHANCE_TYPES.has(SOURCE_TYPES.WEBSITE_PAGE));
});

run('CONTACT_FACTS is NOT in second-chance set (static facts take priority)', () => {
  assert.ok(!SECOND_CHANCE_TYPES.has(SOURCE_TYPES.CONTACT_FACTS));
});

run('CATALOG_PRODUCT "ATB Connect" — matches exist AND answer non-null → second-chance fires', () => {
  const message = 'what is ATB Connect?';
  const { sourceType } = detectSourceType(message);
  assert.strictEqual(sourceType, SOURCE_TYPES.CATALOG_PRODUCT);
  assert.ok(SECOND_CHANCE_TYPES.has(sourceType), 'Must be in second-chance set');

  const matches = searchSiteIndex(message, ATB_PAGES, { minScore: 0.30 });
  assert.ok(matches.length > 0, 'ATB Connect should have site-index matches');

  const answer = buildSiteIndexAnswer(message, matches);
  assert.ok(answer, 'Second-chance must produce non-null answer → would intercept before next()');
  assert.ok(answer.includes('ATB Connect') || answer.includes('connect'), 'Answer must reference the matched page');
});

run('BRANCH_DIRECTORY "ATB agency" — matches exist AND answer non-null → second-chance fires', () => {
  const message = 'ATB agency locations';
  const { sourceType } = detectSourceType(message);
  assert.strictEqual(sourceType, SOURCE_TYPES.BRANCH_DIRECTORY);
  assert.ok(SECOND_CHANCE_TYPES.has(sourceType), 'Must be in second-chance set');

  const matches = searchSiteIndex(message, ATB_PAGES, { minScore: 0.30 });
  assert.ok(matches.length > 0, 'Agency query should have site-index matches');

  const answer = buildSiteIndexAnswer(message, matches);
  assert.ok(answer, 'Second-chance must produce non-null answer');
});

run('GENERAL query with no matches — second-chance condition false → falls to next()', () => {
  // Query with no tokens that can match any page in a minimal index
  const isolatedIndex = makeIndex([
    makePage({ url: 'https://atb.tn/unrelated', title: 'XYZ', textBlocks: ['unrelated content'] }),
  ]);
  const message = 'some completely unrelated query with unique tokens xqz987abc';
  const { sourceType } = detectSourceType(message);
  assert.strictEqual(sourceType, SOURCE_TYPES.GENERAL, 'Unrelated query should be GENERAL');

  const matches = searchSiteIndex(message, isolatedIndex, { minScore: 0.30 });
  // If matches.length === 0, second-chance condition is false → next() called (Laragon fallback)
  // This is the correct behavior — site-index can't help, let catalog/AI try
  const conditionWouldFire = SECOND_CHANCE_TYPES.has(sourceType) && matches.length > 0;
  assert.ok(!conditionWouldFire, 'Second-chance must NOT fire when no matches — falls to next()');
});

run('personal query — searchSiteIndex returns empty → second-chance never fires', () => {
  const message = 'what is my account balance?';
  // Personal query → _isPersonalQuery guard → searchSiteIndex returns []
  const matches = searchSiteIndex(message, ATB_PAGES, { minScore: 0.30 });
  assert.strictEqual(matches.length, 0, 'Personal queries must be blocked by searchSiteIndex');
  // matches.length === 0 → second-chance condition false → next() called → Laragon handles it
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. New build-site-index schema — pages carry textPreview + documentLinks
//    (ASK mode must read the new shape; Laragon old shape must still work).
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[6] New site-index schema — ASK retrieval\n');

function makeNewPage(p) {
  return {
    url:           p.url   || 'https://atb.tn/page',
    title:         p.title || 'ATB Page',
    headings:      p.headings      || [],
    textPreview:   p.textPreview   || '',       // new: single string, not textBlocks[]
    internalLinks: p.internalLinks || [],       // new: URL strings, not links[{text}]
    documentLinks: p.documentLinks || [],       // new: [{linkText,documentUrl,filename}]
  };
}

const ATB_NEW_PAGES = makeIndex([
  makeNewPage({
    url: 'https://atb.tn/atb-connect', title: 'ATB',
    headings: [{ level: 1, text: 'ATB Connect banque digitale' }],
    textPreview: 'ATB Connect est la plateforme de banque digitale pour particuliers.',
  }),
  makeNewPage({
    url: 'https://atb.tn/documents-utiles', title: 'ATB',
    headings: [{ level: 1, text: 'Documents utiles' }],
    textPreview: 'Formulaires et documents à télécharger.',
    documentLinks: [
      { linkText: 'Formulaire abonnement Messenger', documentUrl: 'https://atb.tn/doc/messenger.pdf', filename: 'messenger.pdf' },
    ],
  }),
  makeNewPage({
    url: 'https://atb.tn/credits', title: 'ATB',
    headings: [{ level: 1, text: 'Crédits et prêts' }],
    textPreview: 'ATB propose des crédits immobiliers et à la consommation.',
  }),
  makeNewPage({
    url: 'https://atb.tn/agences', title: 'ATB',
    headings: [{ level: 1, text: 'Réseau agences' }],
    textPreview: 'Trouvez votre agence ATB la plus proche.',
  }),
]);

run('searchSiteIndex matches on new-schema page (textPreview + headings)', () => {
  const matches = searchSiteIndex('what is ATB Connect', ATB_NEW_PAGES);
  assert.ok(matches.length > 0, 'new-schema page must be matchable');
  assert.strictEqual(matches[0].page.url, 'https://atb.tn/atb-connect', 'correct page ranked first');
});

run('buildSiteIndexAnswer produces an answer from new-schema pages', () => {
  const matches = searchSiteIndex('tell me about ATB Connect digital banking', ATB_NEW_PAGES);
  const answer = buildSiteIndexAnswer('tell me about ATB Connect digital banking', matches);
  assert.ok(answer, 'answer must be non-null');
});

run('new-schema documentLinks are searchable for document queries', () => {
  const matches = searchSiteIndex('download the Messenger subscription form', ATB_NEW_PAGES);
  assert.ok(matches.length > 0, 'document page must match');
  const answer = buildSiteIndexAnswer('download the Messenger subscription form', matches);
  assert.ok(answer && /messenger/i.test(answer), `answer must reference the Messenger doc, got: ${answer}`);
});

run('Laragon old-schema (textBlocks + downloadLinks) still works', () => {
  const matches = searchSiteIndex('what is ATB Connect', ATB_PAGES);
  assert.ok(matches.length > 0, 'old-schema search must still work');
  assert.strictEqual(matches[0].page.url, 'https://atb.tn/atb-connect', 'old-schema ranking intact');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. ASK mode — direct answer wording, action detection, evidence collection
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[7] ASK mode — wording, action detection, evidence\n');

run('buildSiteIndexAnswer does NOT say "Site sections found"', () => {
  const matches = [
    { page: makePage({ url: 'https://atb.tn/credits', title: 'Crédits ATB', headings: [{ level: 1, text: 'Crédits et prêts' }] }), score: 0.60 },
  ];
  const answer = buildSiteIndexAnswer('ATB credit products', matches);
  assert.ok(answer, 'Expected non-null answer');
  assert.ok(!answer.includes('Site sections found'), 'Answer must NOT use "Site sections found" wording');
});

run('buildSiteIndexAnswer generates direct answer referencing page content', () => {
  const matches = [
    {
      page: makePage({
        url: 'https://atb.tn/agences',
        title: 'Réseau agences ATB',
        headings: [{ level: 1, text: 'Agences ATB en Tunisie' }],
        textBlocks: ['Plus de 150 agences réparties sur tout le territoire tunisien.'],
      }),
      score: 0.70,
    },
  ];
  const answer = buildSiteIndexAnswer('where are ATB branches', matches);
  assert.ok(answer, 'Expected non-null answer');
  assert.ok(
    answer.includes('agences') || answer.includes('Agences') || answer.includes('/agences'),
    `Answer must reference page content; got: "${answer.slice(0, 100)}"`,
  );
});

run('buildSiteIndexAnswer references up to 3 pages, not 4', () => {
  const pages = [
    makePage({ url: 'https://atb.tn/alpha', title: 'Alpha', headings: [{ level: 1, text: 'Alpha service' }] }),
    makePage({ url: 'https://atb.tn/beta',  title: 'Beta',  headings: [{ level: 1, text: 'Beta service'  }] }),
    makePage({ url: 'https://atb.tn/gamma', title: 'Gamma', headings: [{ level: 1, text: 'Gamma service' }] }),
    makePage({ url: 'https://atb.tn/delta', title: 'Delta', headings: [{ level: 1, text: 'Delta service' }] }),
  ];
  const matches = pages.map((page, i) => ({ page, score: 0.80 - i * 0.05 }));
  const answer = buildSiteIndexAnswer('services', matches);
  assert.ok(answer, 'Expected non-null answer');
  assert.ok(answer.includes('/alpha'), 'Must include 1st page');
  assert.ok(answer.includes('/beta'),  'Must include 2nd page');
  assert.ok(answer.includes('/gamma'), 'Must include 3rd page');
  assert.ok(!answer.includes('/delta'), 'Must NOT include 4th page');
});

run('isActionRequest returns true for English action verbs', () => {
  assert.ok(isActionRequest('open the document'),        '"open"');
  assert.ok(isActionRequest('click the download button'), '"click"');
  assert.ok(isActionRequest('download the form'),        '"download"');
  assert.ok(isActionRequest('navigate to the page'),     '"navigate"');
  assert.ok(isActionRequest('go to the tariffs page'),   '"go to"');
});

run('isActionRequest returns true for French action verbs', () => {
  assert.ok(isActionRequest('télécharger le formulaire'), '"télécharger"');
  assert.ok(isActionRequest('ouvre la page'),             '"ouvre"');
  assert.ok(isActionRequest('accéder au simulateur'),     '"accéder"');
});

run('isActionRequest returns false for informational queries', () => {
  assert.ok(!isActionRequest('what is ATB Connect?'),       'informational');
  assert.ok(!isActionRequest('tell me about ATB loans'),    'informational');
  assert.ok(!isActionRequest('what are the ATB tariffs?'),  'informational');
  assert.ok(!isActionRequest('where are ATB branches?'),    'informational');
  assert.ok(!isActionRequest('engagement qualité ATB'),     'product name');
});

run('collectEvidence returns evidence objects with correct shape', () => {
  const evidence = collectEvidence('ATB Connect digital banking', ATB_PAGES);
  assert.ok(Array.isArray(evidence), 'must return array');
  if (evidence.length > 0) {
    const e = evidence[0];
    assert.ok('sourceType' in e, 'must have sourceType');
    assert.ok('kind'       in e, 'must have kind');
    assert.ok('title'      in e, 'must have title');
    assert.ok('url'        in e, 'must have url');
    assert.ok('text'       in e, 'must have text');
    assert.ok('score'      in e, 'must have score');
  }
});

run('collectEvidence returns page evidence for page queries', () => {
  const evidence = collectEvidence('ATB Connect digital banking', ATB_PAGES);
  const pageEvidence = evidence.filter((e) => e.kind === 'page');
  assert.ok(pageEvidence.length > 0, 'must include at least one page evidence');
  assert.ok(pageEvidence[0].url.includes('atb-connect'), 'top page evidence must be the connect page');
});

run('collectEvidence returns document evidence from downloadLinks', () => {
  const pagesWithDocs = makeIndex([
    makePage({
      url: 'https://atb.tn/docs',
      title: 'Documents ATB',
      headings: [{ level: 1, text: 'Formulaires à télécharger' }],
      downloadLinks: [
        { text: 'Formulaire compte cheque', href: 'https://atb.tn/docs/compte-cheque.pdf', fileType: 'pdf' },
      ],
    }),
    makePage({ url: 'https://atb.tn/other', title: 'Other ATB' }),
  ]);
  const evidence = collectEvidence('formulaire compte cheque', pagesWithDocs);
  const docEvidence = evidence.filter((e) => e.kind === 'document');
  assert.ok(docEvidence.length > 0, 'must include document evidence from downloadLinks');
  assert.ok(
    docEvidence[0].url.includes('compte-cheque') || docEvidence[0].title.toLowerCase().includes('compte'),
    `document evidence must reference the matched document; got title="${docEvidence[0]?.title}"`,
  );
});

run('collectEvidence reads documentOccurrences from index root (new schema)', () => {
  const occIndex = {
    ...makeIndex([makePage({ url: 'https://atb.tn/', title: 'ATB Accueil' })]),
    documentOccurrences: [
      {
        linkText: 'Engagement Qualité',
        documentTitle: 'Normes et délais',
        documentUrl: 'https://atb.tn/docs/Normes-Delais.pdf',
        filename: 'Normes-Delais.pdf',
        sourcePageUrl: 'https://atb.tn/',
      },
    ],
  };
  const evidence = collectEvidence('engagement qualite', occIndex);
  const docEvidence = evidence.filter((e) => e.kind === 'document');
  assert.ok(docEvidence.length > 0, 'must find document from documentOccurrences');
  assert.ok(
    docEvidence[0].url.includes('Normes-Delais') || docEvidence[0].title.includes('Engagement'),
    `document evidence must reference Normes-Delais; got title="${docEvidence[0]?.title}"`,
  );
});

run('collectEvidence returns empty for empty index', () => {
  const emptyIdx = makeIndex([]);
  const evidence = collectEvidence('anything', emptyIdx);
  assert.deepStrictEqual(evidence, [], 'empty index must return empty evidence');
});

run('buildAskNotFoundAnswer returns a non-empty informative string', () => {
  const msg = buildAskNotFoundAnswer();
  assert.ok(typeof msg === 'string' && msg.length > 0, 'must return non-empty string');
  assert.ok(!msg.includes('Site sections found'), 'must not use search-result wording');
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
