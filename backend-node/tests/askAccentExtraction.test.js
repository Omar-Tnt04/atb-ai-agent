'use strict';
// Generic ASK-mode NLP fix: accent-folding retrieval + labeled-field extraction.
// Pure functions, no server. Run: node backend-node/tests/askAccentExtraction.test.js
const assert = require('assert');
const {
  searchSiteIndex,
  buildSiteIndexAnswer,
  extractLabeledFields,
} = require('../src/services/siteIndex.service');

// Real textPreview tail from site-context/atb.tn/site-index.json (/professionnels/mediateur).
const MEDIATEUR_BODY =
  "Assistance Entreprises Espace Particuliers Médiateur de l'ATB M. Meftah ziadi " +
  'Adresse : 20 Rue Mohamed Triki, Ennasr 2, CP 2001 ' +
  'Email : ziadi.meftah@cbf.org.tn Tél : (+216) 71 950 300';

// Minimal fixture index (2 pages) — the boilerplate /mediateur ranks near the real
// /professionnels/mediateur, exactly as in production; extraction must skip the empty one.
const INDEX = {
  targetUrl: 'https://atb.tn',
  pages: [
    { url: 'https://atb.tn/mediateur', title: "Médiateur de l'ATB | ATB",
      headings: [], links: [], textPreview: 'Assistance Entreprises Espace Particuliers' },
    { url: 'https://atb.tn/professionnels/mediateur', title: "Médiateur de l'ATB | ATB",
      headings: [], links: [], textPreview: MEDIATEUR_BODY },
    { url: 'https://atb.tn/credit-auto', title: 'Crédit Auto | ATB',
      headings: [], links: [], textPreview: 'Simulez votre crédit auto en ligne.' },
  ],
};

// 1. Accent folding: unaccented query token matches accented indexed word.
const matches = searchSiteIndex("quelle est l'adresse du mediateur de l'ATB?", INDEX);
assert.ok(matches.length > 0, 'mediateur query must produce site-index matches after accent folding');
assert.ok(
  matches.some((m) => m.page.url.includes('/professionnels/mediateur')),
  'the page carrying the address must be among the ranked candidates',
);

// 2. Generic labeled-field extraction pulls the address out of free text.
const fields = extractLabeledFields(MEDIATEUR_BODY);
assert.strictEqual(fields.address, '20 Rue Mohamed Triki, Ennasr 2, CP 2001');
assert.strictEqual(fields.email, 'ziadi.meftah@cbf.org.tn');
assert.ok(fields.phone && fields.phone.includes('71 950 300'), 'phone field extracted');

// 3. End-to-end ASK answer: correct address, and NOT the wrong catalog resource.
const answer = buildSiteIndexAnswer("quelle est l'adresse du mediateur de l'ATB?", matches);
assert.ok(answer && answer.includes('20 Rue Mohamed Triki, Ennasr 2, CP 2001'),
  `answer must contain the mediator address, got: ${answer}`);
assert.ok(!/SME Current Account/i.test(answer), 'must not surface the unrelated catalog product');

// 4. Extraction is generic — English labels on a non-ATB shape also work.
const en = extractLabeledFields('Location: 5 Baker Street, London Email: hi@acme.io Hours: 9-5');
assert.strictEqual(en.address, '5 Baker Street, London');
assert.strictEqual(en.email, 'hi@acme.io');
assert.strictEqual(en.hours, '9-5');

// 5. No false extraction when text has no labeled fields.
assert.deepStrictEqual(extractLabeledFields('Simulez votre crédit auto en ligne.'), {});

// 6. Truncated phone (common crawl cutoff) is rejected, address still kept.
const trunc = extractLabeledFields('Adresse : 20 Rue X Tél : (+2');
assert.strictEqual(trunc.address, '20 Rue X');
assert.ok(!trunc.phone, 'truncated phone must not be surfaced');

console.log('ok - ask accent-folding + labeled-field extraction (6 checks passed)');
