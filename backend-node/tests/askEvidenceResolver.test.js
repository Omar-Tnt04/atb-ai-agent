'use strict';
// ASK answer pipeline: RETRIEVE → EXTRACT → REFORMULATE → VALIDATE. Pure + injected
// model (no Ollama, no server, no hardcoded resource/product/page names).
// Run: node backend-node/tests/askEvidenceResolver.test.js
const assert = require('assert');
const path = require('path');
const R = require('../src/services/askEvidenceResolver.service');
const {
  extractAnswerPayload, validateReformulation, deterministicAnswer, resolveAskAnswer,
  classifyScope, filterSiteFacts, MIN_SOURCE_CONF, ASK_RESOLVER_VERSION,
} = R;

const siteIndex = require('../../site-context/atb.tn/site-index.json');
const MED = "quelle est l'adresse du médiateur de l'ATB?";

// Synthetic evidence (generic, no real names).
const record = {
  source: 'catalog', title: 'Some Resource', url: '',
  snippet: 'Use it when the user asks about the account. '
    + 'It contains recordId AX-77, owner user_9, status suspended, balance 1200 units, rate 1 EUR = 0.30 TND.',
};
const listRec = {
  source: 'site_index', title: 'Products', url: 'http://x/p',
  snippet: 'Home Menu Services About Contact Login Account. We list products Product Alpha, Product Beta, Product Gamma, Product Delta.',
};

(async () => {
  // ── Scope classifier (hint only) ────────────────────────────────────────────
  assert.strictEqual(classifyScope('What does ATB say about its services?'), 'public_site_info');
  assert.strictEqual(classifyScope('what is the rate on my receipt?'), 'private_catalog_info');

  // ── EXTRACT: atomic facts, boilerplate/meta removed ─────────────────────────
  const pStatus = extractAnswerPayload('what is the account status?', record, { catalog: 0.8 });
  assert.ok(pStatus.answerFacts.some((f) => /status/i.test(f) && /suspended/i.test(f)), 'status fact extracted');
  assert.ok(!pStatus.answerFacts.some((f) => /use it when/i.test(f)), 'routing/meta removed');
  // value question → only the requested value unit, not the whole record
  const pRate = extractAnswerPayload('what is the exchange rate?', record, { catalog: 0.8 });
  assert.ok(pRate.answerFacts[0] && /rate/i.test(pRate.answerFacts[0]) && /0\.30/.test(pRate.answerFacts[0]),
    `rate fact expected, got: ${pRate.answerFacts[0]}`);
  assert.ok(!/recordId AX-77.*owner user_9.*status/i.test(pRate.answerFacts[0] || ''), 'must not be the full record dump');
  // list question → the list items
  const pList = extractAnswerPayload('which products are listed?', listRec, { site_index: 0.6 });
  assert.ok(pList.answerFacts.some((f) => /Product Alpha/.test(f)), 'list facts extracted');
  assert.ok(!pList.answerFacts.some((f) => /Home Menu Services/.test(f)), 'nav/menu text removed');

  // ── REFORMULATE validation ──────────────────────────────────────────────────
  const pk = { question: 'what is the status?', answerFacts: ['status suspended', 'balance 1200 units'], supportingFacts: [] };
  // good reformulation → accepted
  assert.strictEqual(validateReformulation(
    { answer: 'The account is currently suspended.', usedFacts: [0], confidence: 0.9 }, pk, pk.question).ok, true);
  // vague "I found X" → rejected
  assert.strictEqual(validateReformulation(
    { answer: 'I found the resource', usedFacts: [0], confidence: 0.9 }, pk, pk.question).ok, false);
  // raw record dump → rejected
  const dumpPk = { question: 'q', answerFacts: ['recordId AX-77, owner user_9, status suspended, balance 1200'], supportingFacts: [] };
  assert.strictEqual(validateReformulation(
    { answer: 'recordId AX-77, owner user_9, status suspended, balance 1200', usedFacts: [0], confidence: 0.9 }, dumpPk, 'q').ok, false);
  // empty usedFacts / low confidence → rejected
  assert.strictEqual(validateReformulation({ answer: 'x', usedFacts: [], confidence: 0.9 }, pk, pk.question).ok, false);
  assert.strictEqual(validateReformulation({ answer: 'suspended', usedFacts: [0], confidence: 0.1 }, pk, pk.question).ok, false);
  // page-list for non-list question → rejected
  assert.strictEqual(validateReformulation(
    { answer: '- Page A (/a)\n- Page B (/b)', usedFacts: [0], confidence: 0.9 }, pk, 'what is the status?').ok, false);
  // unsupported answer → rejected
  assert.strictEqual(validateReformulation(
    { answer: 'the moon is cheese', usedFacts: [0], confidence: 0.9 }, pk, pk.question).ok, false);

  // ── Deterministic fallback: clean, bolded, no field name, no dump, no "I found" ─
  const det = deterministicAnswer(pRate);
  assert.ok(det && /0\.30/.test(det) && !/^\s*I found/i.test(det), `clean deterministic value: ${det}`);
  assert.ok(!/recordId/i.test(det), 'field names not exposed in deterministic answer');
  assert.ok(det.includes('**'), 'deterministic answer must bold the key fact');

  // ── Site-chrome filtering (generic, site_index facts only) ───────────────────
  const chrome = [
    'Trouver votre agence Nous Contacter Réclamations Enquête de satisfaction',
    'Nos comptes Nos cartes Nos Packs ATB Financement E Banking',
    'Gizmo Premium La solution qui vous permet de gérer vos paiements en ligne',   // descriptive → keep
    'Alpha Beta Gamma Delta Epsilon Zeta Omega Sigma',                             // category list, no values
  ];
  const fr = filterSiteFacts(chrome, { siteSnippets: [], listOk: false });
  assert.ok(fr.kept.includes(chrome[2]), 'descriptive product prose must survive');
  assert.ok(!fr.kept.includes(chrome[0]) && !fr.kept.includes(chrome[1]), 'chrome phrases removed');
  assert.ok(!fr.kept.includes(chrome[3]), 'category list rejected for non-list question');
  assert.ok(fr.removedChrome >= 2 && fr.rejectedLists >= 1, 'filter counters populated');
  // same category list survives when the user asks for an enumeration
  const frList = filterSiteFacts([chrome[3]], { siteSnippets: [], listOk: true });
  assert.ok(frList.kept.includes(chrome[3]), 'category list allowed when user asks for a list');
  // cross-page repetition: identical long fact in 2 candidate snippets → chrome
  const rep = 'Grand Slogan Banque Partenaire De Votre Croissance Continue Toujours';
  const frRep = filterSiteFacts([rep], { siteSnippets: [rep + ' x', 'y ' + rep], listOk: false });
  assert.strictEqual(frRep.kept.length, 0, 'fact repeated across pages treated as chrome');

  // ── Insufficient evidence: chrome-only site page → clean message, not noise ──
  const chromeIdx = { targetUrl: 'https://x.tn', pages: [{
    url: 'https://x.tn/special-widget', title: 'Special Widget',
    headings: [], links: [],
    textPreview: 'Special Widget Nos comptes Nos cartes Nos Packs Devenir Client Recrutement Documents Utiles TMM 7.99 ATBCHALLENGE 2026',
  }] };
  const insuf = await resolveAskAnswer('what about the special widget?', {
    siteIndex: chromeIdx, callModel: () => Promise.reject(new Error('down')),
  });
  assert.ok(insuf && /does not contain enough specific detail/i.test(insuf.answer),
    `insufficient-evidence message expected, got: ${insuf && insuf.answer}`);
  assert.ok(!/Nos comptes/i.test(insuf.answer), 'noisy chrome text must not leak into the answer');

  // ── Unformatted value answer rejected (deterministic bold takes over) ────────
  assert.strictEqual(validateReformulation(
    { answer: 'The rate is 1 EUR = 3.378 TND', usedFacts: [0], confidence: 0.9 },
    { question: 'rate?', answerFacts: ['rate 1 EUR = 3.378 TND'], supportingFacts: [] }, 'rate?').ok, false);

  // ── E2E (real site index): Gemma reformulates extracted facts → clean answer ─
  const goodGemma = () => Promise.resolve(JSON.stringify({
    answer: "L'adresse du médiateur est **20 Rue Mohamed Triki, Ennasr 2, CP 2001**.", usedFacts: [0], confidence: 0.9 }));
  const out = await resolveAskAnswer(MED, { siteIndex, callModel: goodGemma });
  assert.ok(out && /20 Rue Mohamed Triki/.test(out.answer) && out.source === 'site_index', `clean site answer: ${out && out.answer}`);

  // ── Gemma unavailable → safe deterministic fallback (no crash, no dump) ──────
  const dbg = {};
  const down = await resolveAskAnswer(MED, { siteIndex, callModel: () => Promise.reject(new Error('down')), debug: dbg });
  assert.ok(down && /20 Rue Mohamed Triki/.test(down.answer) && down.synthesized === true, 'deterministic fallback answers');
  assert.strictEqual(dbg.version, ASK_RESOLVER_VERSION);
  assert.ok(!/^\s*I found/i.test(down.answer), 'never "I found X"');

  // ── Gemma invalid output → rejected → deterministic fallback (not raw) ───────
  const bad = await resolveAskAnswer(MED, { siteIndex, callModel: () => Promise.resolve('garbage') });
  assert.ok(bad === null || /20 Rue Mohamed Triki/.test(bad.answer), 'invalid Gemma output must not surface raw');

  // ── ASK never references the browser/CDP path ────────────────────────────────
  const src = require('fs').readFileSync(path.join(__dirname, '../src/services/askEvidenceResolver.service.js'), 'utf8');
  assert.ok(!/browser_agent_queued|browser_agent_done|launchBrowserAgentJob|checkCdpReachable/.test(src),
    'resolver must not reference any browser/CDP execution');

  console.log('ok - ask 3-step answer pipeline (all checks passed)');
})().catch((e) => { console.error(e); process.exit(1); });
