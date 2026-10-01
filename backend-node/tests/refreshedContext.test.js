'use strict';
const assert = require('node:assert/strict');
const { adaptSiteIndex } = require('../src/services/siteIndexAdapter.service');
const { decideAction } = require('../src/services/siteIndexAgent.service');
const raw = require('../../site-context/atb.tn/site-index.json');
const ask = require('../../site-context/atb.tn/ask-context.json');
const { retrieveBlocks } = require('../src/services/askContext.service');

(async () => {
  const adapted = adaptSiteIndex(raw);
  const messenger = adapted.resources.find(r => r.type === 'document' && /Formulaire_Abonnement-ATBMESSENGER\.pdf$/.test(r.url));
  assert(messenger, 'new Messenger form exists');
  assert.equal(messenger.title, messenger.filename, 'generic download button must not hide document identity');
  assert.equal(messenger.sourcePages[0].linkText, 'Télécharger', 'preserve actual browser label');
  const cases = [
    ['Ouvre le crédit Sayara', 'open_page', 'crédit Sayara', /\/particuliers\/nos-credits\/credit-sayara$/],
    ['Open the contact page', 'open_page', 'contacter un conseiller', /\/contacter-un-conseiller$/],
    ['Open ATB PAY', 'open_page', 'ATB PAY', /\/atb-pay$/],
    ['Find the ATB Messenger subscription form', 'open_document', 'formulaire abonnement ATB Messenger subscription', /Formulaire_Abonnement-ATBMESSENGER(?:_0)?\.pdf$/],
    ['Documents pour le crédit Sayara', 'open_document', 'credit sayara documents', /credit_sayara_documents\.pdf$/],
  ];
  for (const [message, action, requestDescription, expected] of cases) {
    const result = await decideAction(message, { intent: { action, requestDescription }, allowedDomain: 'atb.tn', _selectFn: async () => null });
    assert(result.found, message);
    const url = result.action.documentUrl || result.action.url;
    assert(expected.test(url), `${message}: ${url}`);
    console.log('PASS:', message, '->', url);
  }
  const hits = retrieveBlocks('crédit Sayara voiture', ask);
  assert(hits[0].block.url.endsWith('/particuliers/nos-credits/credit-sayara'));
  assert(ask.contextBlocks.some(b => /credit-sayara$/.test(b.url) && /80\s*%/.test(b.richContext) && /7 ans/.test(b.richContext)));
  console.log('PASS: current product outranks archive; new Sayara figures are available as captured evidence.');
})().catch(error => { console.error(error); process.exitCode = 1; });
