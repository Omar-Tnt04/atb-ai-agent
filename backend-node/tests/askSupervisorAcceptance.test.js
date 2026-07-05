'use strict';

const assert = require('assert');
const siteIndex = require('../../site-context/atb.tn/site-index.json');
const { resolveAskAnswer } = require('../src/services/askEvidenceResolver.service');

const modelUnavailable = () => Promise.reject(new Error('model unavailable'));
const META_RE = /use it when|should be selected|questions such as|should answer|should select|service-based questions/i;
const SITE_NOISE_RE = /Espace Particuliers|Espace Professionnels|Espace Entreprises|PRIX ATB MUSTAPHA AZOUZ|Trouver votre agence|Nous Contacter|Documents utiles|copyright/i;

const catalogCases = [
  ['Who am I in the bank profile?', 'Customer Profile Overview', ['Omar Tentouch']],
  ['What is my primary branch?', 'Customer Profile Overview', ['Tunis Centre']],
  ['Which Tunis branch handles SME support?', 'ATB Branch Directory - Tunis Region', ['Lac 1']],
  ['How do I activate ATB Connect?', 'ATB Connect Activation Guide', ['Verify customer identity', 'OTP']],
  ['Should I share my OTP with bank staff?', 'Mobile Banking Security Notice', ['Never share your OTP']],
  ['What is my available card limit for card ending 1122?', 'Credit Card Limit Notice', ['1735.250 TND']],
  ['What is the status of my debit card replacement?', 'Debit Card Replacement Request', ['Ready for confirmation']],
  ['Is my transfer to Sami in France completed?', 'International Transfer Request', ['Pending review']],
  ['What is the exchange rate in my foreign currency receipt?', 'Foreign Currency Exchange Receipt', ['1 EUR = 3.378 TND']],
  ['What is my savings goal progress?', 'Savings Goal Progress', ['Laptop Fund', '64%', '2240.000 TND']],
];

const siteCases = [
  'What are ATB opening hours?',
  'What e-banking services does ATB offer?',
  'What is ATB Connect?',
  'What is ATB Messenger?',
  'What is ATB Mobilink?',
  'What is ATB PAY?',
  'What credit products does ATB offer?',
  'What is Credit Sayara?',
  'Where can I find the satisfaction survey?',
  'Where is the recruitment page?',
];

(async () => {
  for (const [question, expectedResource, expectedParts] of catalogCases) {
    const out = await resolveAskAnswer(question, { siteIndex, callModel: modelUnavailable });
    assert.ok(out, `missing answer: ${question}`);
    assert.strictEqual(out.source, 'catalog', `wrong source: ${question}`);
    assert.strictEqual(out.matchTitle, expectedResource, `wrong resource: ${question}`);
    for (const part of expectedParts) assert.ok(out.answer.includes(part), `missing ${part}: ${out.answer}`);
    assert.ok(out.answer.includes('**'), `key answer is not bold: ${out.answer}`);
    assert.ok(!META_RE.test(out.answer), `catalog meta leaked: ${out.answer}`);
    assert.ok(!/\(Source:|resourceId|customerId|requestId|receiptId/i.test(out.answer), `internal metadata leaked: ${out.answer}`);
  }

  for (const question of siteCases) {
    const out = await resolveAskAnswer(question, { siteIndex, callModel: modelUnavailable });
    assert.ok(out, `missing site answer: ${question}`);
    assert.strictEqual(out.source, 'site_index', `public question escaped site index: ${question}`);
    assert.ok(!SITE_NOISE_RE.test(out.answer), `site chrome leaked: ${out.answer}`);
    assert.ok(!META_RE.test(out.answer), `catalog meta leaked into site answer: ${out.answer}`);
    assert.ok(!/browser_agent_(?:queued|done)/i.test(JSON.stringify(out)), `ASK queued browser work: ${question}`);
    const honestInsufficient = /does not contain enough specific detail/i.test(out.answer);
    assert.ok(honestInsufficient || out.answer.includes('**'), `site answer is neither clean nor honestly insufficient: ${out.answer}`);
  }

  console.log(`ok - ASK supervisor acceptance (${catalogCases.length} catalog, ${siteCases.length} site)`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
