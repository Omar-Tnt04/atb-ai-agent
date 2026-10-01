'use strict';
// ASK-mode ask-context.json retrieval — pure, no server, no model, no Ollama.
// Run: node backend-node/tests/askContext.test.js
const assert = require('assert');
const {
  NOT_ENOUGH_INFO,
  retrieveBlocks,
  buildGroundedAnswer,
  buildAskContextAnswer,
} = require('../src/services/askContext.service');

// Synthetic ask-context (generic, not tied to any real site) for deterministic asserts.
const fakeCtx = {
  meta: { domain: 'example.tn' },
  contextBlocks: [
    {
      id: 'contact', url: 'https://example.tn/contact', title: 'Contact',
      richContext: 'Contact page with phone and address.',
      keyPoints: [
        { point: 'Head office address', evidence: '9 Rue Hédi Nouira, 1001 Tunis' },
        { point: 'Standard phone number', evidence: 'Standard: 71 351 155' },
      ],
      usefulForQuestionsAbout: ['how to contact', 'phone number', 'address'],
      promptText: 'Contact: address 9 Rue Hédi Nouira, phone 71 351 155.',
    },
    {
      id: 'sayara', url: 'https://example.tn/credit-sayara', title: 'Crédit Sayara',
      richContext: 'Car loan financing up to 80% of the price.',
      keyPoints: [
        { point: 'Finances up to 80% of the car price', evidence: 'le financement peut atteindre 80% du prix de la voiture' },
        { point: 'Duration up to 7 years', evidence: "Jusqu'à 7 ans." },
      ],
      usefulForQuestionsAbout: ['car loan', 'crédit sayara', 'car financing'],
      promptText: 'Crédit Sayara finances cars up to 80%, up to 7 years.',
    },
  ],
};

// ── retrieveBlocks selects the on-topic block ──────────────────────────────────
const carHits = retrieveBlocks('quelle est la durée du crédit sayara pour une voiture ?', fakeCtx);
assert.ok(carHits.length > 0, 'should retrieve at least one block for a car-loan question');
assert.strictEqual(carHits[0].block.id, 'sayara', 'top block should be the car-loan block');

const contactHits = retrieveBlocks('what is the phone number to contact you?', fakeCtx);
assert.strictEqual(contactHits[0].block.id, 'contact', 'top block should be the contact block');

// Accent-folded matching: "durée" matches even without diacritics in the query.
assert.ok(retrieveBlocks('duree credit sayara', fakeCtx).length > 0, 'accent-folded query should match');

// ── grounded answer cites evidence + source, only from the selected block ──────
const ans = buildGroundedAnswer('duration of credit sayara', carHits);
assert.ok(/7 ans/.test(ans), 'answer should include the verbatim duration evidence');
assert.ok(/Source: https:\/\/example\.tn\/credit-sayara/.test(ans), 'answer should cite the source URL');
assert.ok(!/71 351 155/.test(ans), 'answer must NOT leak evidence from an unrelated block');

// ── buildAskContextAnswer end-to-end ───────────────────────────────────────────
const ok = buildAskContextAnswer('crédit sayara voiture durée', { domain: '__inject__' });
// __inject__ domain has no file → answered:false with the canned message.
assert.strictEqual(ok.answered, false);
assert.strictEqual(ok.answer, NOT_ENOUGH_INFO);

// Directly exercise the answerer against the in-memory ctx (bypass file load).
const direct = buildGroundedAnswer('how to contact you by phone', contactHits);
assert.ok(/71 351 155/.test(direct) && /Source:/.test(direct));

// ── no relevant block → canned "not enough info" ───────────────────────────────
assert.strictEqual(retrieveBlocks('quantum chromodynamics lattice gauge', fakeCtx).length, 0);

// ── real ask-context.json (if present) loads and answers a known question ──────
try {
  const real = require('../../site-context/atb.tn/ask-context.json');
  const hits = retrieveBlocks('crédit Sayara voiture', real);
  assert.ok(hits.length > 0, 'refreshed ask-context should retrieve the captured Sayara product');
  assert.ok(hits[0].block.url.endsWith('/particuliers/nos-credits/credit-sayara'), 'current product page should outrank archived promotions');
  const a = buildGroundedAnswer('crédit Sayara voiture', hits);
  assert.ok(a && /Source: https?:\/\//.test(a), 'real answer should cite a source URL');
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e;
  console.log('  (skipped real ask-context.json check — file not present)');
}

console.log('askContext: all assertions passed');

// ── LLM synthesis path (injected model; no real Ollama) ────────────────────────
(async () => {
  const { synthesizeAnswer, buildCombinedAnswerLLM, answerIsSupported } = require('../src/services/askContext.service');
  const askBlocks = carHits; // sayara block from above
  const catEntries = [{ source: 'catalog.json', id: 'sme_acct', category: 'business', title: 'SME Account', description: 'Overdraft up to 5000 TND.', evidence: 'Overdraft up to 5000 TND.' }];

  // Grounded model → answer returned WITH labeled sources, only selected evidence sent.
  let sentPayload = null;
  const goodModel = async (userContent) => { sentPayload = userContent; return JSON.stringify({ answer: 'Le crédit Sayara peut durer jusqu’à 7 ans.' }); };
  const out = await synthesizeAnswer('durée du crédit sayara', { askBlocks, catalogEntries: catEntries, callModel: goodModel });
  assert.ok(out && /7 ans/.test(out), 'synthesized answer returned');
  assert.ok(/Source: ask-context\.json — https:\/\/example\.tn\/credit-sayara/.test(out), 'ask-context source labeled');
  assert.ok(/Source: catalog\.json \(id=sme_acct, category=business\)/.test(out), 'catalog source labeled');
  // Confirm ONLY selected evidence was sent (no full-file markers, contains our block + entry).
  assert.ok(/credit-sayara/.test(sentPayload) && /sme_acct/.test(sentPayload), 'evidence pack carries selected items');
  assert.ok(!/contextBlocks":\[/.test(sentPayload) || /askContextEvidence/.test(sentPayload), 'pack is the compact evidence shape, not raw file');

  // Hallucinated number (never in evidence) → guard rejects → null (caller falls back).
  const liarModel = async () => JSON.stringify({ answer: 'The loan lasts up to 25 years at 99% rate.' });
  assert.strictEqual(await synthesizeAnswer('duration', { askBlocks, catalogEntries: [], callModel: liarModel }), null, 'unsupported numbers rejected');

  // Empty answer → null.
  assert.strictEqual(await synthesizeAnswer('x', { askBlocks, catalogEntries: [], callModel: async () => JSON.stringify({ answer: '' }) }), null);

  // Model throws (Ollama down) → null.
  assert.strictEqual(await synthesizeAnswer('x', { askBlocks, catalogEntries: [], callModel: async () => { throw new Error('ECONNREFUSED'); } }), null);

  // answerIsSupported unit checks.
  assert.strictEqual(answerIsSupported('call 71 351 155', 'phone Standard: 71 351 155'), true);
  assert.strictEqual(answerIsSupported('rate is 42%', 'no such number here'), false);
  assert.strictEqual(answerIsSupported('email a@b.com', 'contact a@b.com now'), true);

  // buildCombinedAnswerLLM: flag OFF → deterministic (ignores model).
  delete process.env.ASK_USE_LLM_SYNTHESIS;
  const det = await buildCombinedAnswerLLM('duree credit sayara', { askBlocks, catalogEntries: catEntries, callModel: goodModel });
  assert.ok(det.answered && det.synthesized === false, 'flag off → deterministic');

  // flag ON → synthesized; on model failure → deterministic fallback still answers.
  process.env.ASK_USE_LLM_SYNTHESIS = 'true';
  const on = await buildCombinedAnswerLLM('duree credit sayara', { askBlocks, catalogEntries: catEntries, callModel: goodModel });
  assert.ok(on.answered && on.synthesized === true, 'flag on → synthesized');
  const fb = await buildCombinedAnswerLLM('duree credit sayara', { askBlocks, catalogEntries: catEntries, callModel: async () => { throw new Error('down'); } });
  const noEvidence = await buildCombinedAnswerLLM('queue number', {
    askBlocks: [],
    catalogEntries: catEntries,
    callModel: async () => JSON.stringify({ answer: 'The evidence provided does not include the queue number.' }),
  });
  assert.strictEqual(noEvidence.answered, false, 'model no-evidence answer falls through');
  assert.ok(fb.answered && fb.synthesized === false, 'synthesis failure → deterministic fallback answers');
  delete process.env.ASK_USE_LLM_SYNTHESIS;

  console.log('askContext LLM synthesis: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });

// ── Markdown emphasis: the RULES live in the synthesis prompt, and a bolded answer
//    must survive the pipeline untouched (formatting is never post-processed away). ──
(async () => {
  process.env.ASK_USE_LLM_SYNTHESIS = 'true';
  const { buildCombinedAnswerLLM } = require('../src/services/askContext.service');

  const CONNECT = "ATB Connect est le service de banque en ligne de l'ATB pour gérer vos comptes à distance.";
  const RENOV = "Crédit Renov : ATB RENOV couvre jusqu'à 80 % du montant, jusqu'à 200 000 DT, remboursable sur 20 ans.";

  // 1. "C'est quoi ATB Connect ?" → answer opens with the bold entity + definition.
  let seenSystem = '';
  const connectModel = async (_pack, system) => {
    seenSystem = system;
    return JSON.stringify({ answer: "**ATB Connect** est le service de banque en ligne de l'ATB qui permet de gérer ses comptes et ses opérations à distance." });
  };
  const r1 = await buildCombinedAnswerLLM("C'est quoi ATB Connect ?", {
    exactEvidence: [{ blockId: 'services-banque-atbconnect', url: 'https://atb.tn/services-banque-atbconnect', title: 'ATB Connect', chunks: [CONNECT] }],
    callModel: connectModel, responseLanguage: 'fr',
  });
  assert.ok(r1.answered && r1.synthesized, 'bolded answer must be accepted by the guard');
  assert.ok(/^\*\*ATB Connect\*\* est le service/.test(r1.answer), `answer must open with the bold entity, got: ${r1.answer.slice(0, 60)}`);

  // The formatting contract is IN THE PROMPT (not post-processing).
  for (const rule of ['**bold**', 'EMPHASIS RULES', 'no HTML', '**200 000 DT**', 'Do NOT overuse bold']) {
    assert.ok(seenSystem.includes(rule), `synthesis system prompt must carry the rule: ${rule}`);
  }
  assert.ok(/gras/.test(seenSystem), 'French answers get the localized emphasis clause');

  // 2. "Explique Crédit Renov" → entity + every key figure bolded, all still evidence-supported.
  const r2 = await buildCombinedAnswerLLM('Explique Crédit Renov', {
    exactEvidence: [{ blockId: 'credit-renov', url: 'https://atb.tn/produits/credit-Renov-presentation.php', title: 'Crédit Renov', chunks: [RENOV] }],
    callModel: async () => JSON.stringify({
      answer: "**Crédit Renov** est le crédit de l'ATB pour financer vos travaux.\n- **Quotité** : jusqu'à **80 %** du montant\n- **Montant maximal** : **200 000 DT**\n- **Durée** : jusqu'à **20 ans**",
    }),
    responseLanguage: 'fr',
  });
  assert.ok(r2.answered && r2.synthesized, 'bolded figures must not trip the anti-hallucination guard');
  for (const bold of ['**Crédit Renov**', '**80 %**', '**200 000 DT**', '**20 ans**', '**Montant maximal**']) {
    assert.ok(r2.answer.includes(bold), `answer must keep ${bold}`);
  }
  assert.ok(!/<\/?[a-z]/i.test(r2.answer.split('Source:')[0]), 'no HTML in the answer body');

  delete process.env.ASK_USE_LLM_SYNTHESIS;
  console.log('askContext markdown emphasis: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
