const assert = require('assert');
const {
  buildPagePlan,
  isPageControlTask,
  detectGoals,
  expandSearchTerms,
  classifyHref,
} = require('../src/services/pageControl.service');

// Realistic ATB-like host page. Generic shapes only — the matcher never sees these names hardcoded.
const BASE = 'https://atb.tn/';
const SNAPSHOT = {
  url: BASE,
  title: 'Arab Tunisian Bank',
  headings: [{ ref: 'h1', tag: 'h1', text: 'Bienvenue' }],
  sections: [],
  buttons: [{ ref: 'b1', type: 'button', kind: 'header', text: 'Rechercher' }],
  links: [
    { ref: 'l1', type: 'link', kind: 'sidebar', text: 'E Banking', href: 'https://atb.tn/e-banking' },
    { ref: 'l2', type: 'link', kind: 'sidebar', text: 'Réclamations', href: 'https://atb.tn/reclamations' },
    { ref: 'l3', type: 'link', kind: 'sidebar', text: 'Opposition carte', href: 'https://atb.tn/opposition' },
    { ref: 'l4', type: 'link', kind: 'header', text: 'ATB Connect', href: 'https://atb.tn/atb-connect' },
    { ref: 'l5', type: 'link', kind: 'header', text: 'Documents utiles', href: 'https://atb.tn/documents' },
    { ref: 'l6', type: 'link', kind: 'header', text: 'Cartes Bancaires', href: 'https://atb.tn/particuliers/cartes' },
    { ref: 'l7', type: 'link', kind: 'header', text: 'Espace Particuliers', href: 'https://atb.tn/particuliers' },
    { ref: 'l8', type: 'link', kind: 'header', text: 'Espace Professionnels', href: 'https://atb.tn/professionnels' },
    { ref: 'l9', type: 'link', kind: 'header', text: 'Espace Entreprises', href: 'https://atb.tn/entreprises' },
    { ref: 'l10', type: 'link', kind: 'header', text: 'Devenir client', href: 'https://atb.tn/devenir-client' },
    { ref: 'l11', type: 'link', kind: 'header', text: 'Trouver une agence', href: 'https://atb.tn/agences' },
    { ref: 'l12', type: 'link', kind: 'header', text: 'Ouvrir un compte', href: 'https://atb.tn/ouverture-compte' },
    { ref: 'd1', type: 'link', kind: 'nav', text: 'Formulaire de demande de carte', href: 'https://atb.tn/docs/formulaire-carte.pdf', fileType: 'pdf' },
    { ref: 'd2', type: 'link', kind: 'nav', text: 'Conditions générales', href: 'https://atb.tn/docs/conditions.pdf', fileType: 'pdf' },
    // Forbidden / external — must never be clicked or opened.
    { ref: 'x1', type: 'link', kind: 'header', text: 'Connexion', href: 'https://atb.tn/login' },
    { ref: 'x2', type: 'link', kind: 'footer', text: 'Facebook', href: 'https://facebook.com/atb' },
  ],
};

const byRef = {};
for (const l of SNAPSHOT.links) byRef[l.ref] = l;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

// A plan must never act on a forbidden/external link.
function assertActionsSafe(plan) {
  for (const a of plan.actions) {
    if (a.type === 'clickLink') {
      const cls = classifyHref(byRef[a.ref].href, BASE);
      assert.strictEqual(cls.kind, 'internal', `clickLink must target internal, got ${cls.kind}`);
    }
    if (a.type === 'openDocument') {
      const cls = classifyHref(byRef[a.ref].href, BASE);
      assert.strictEqual(cls.kind, 'document', `openDocument must target document, got ${cls.kind}`);
    }
    // Never act on the login or external refs.
    assert.ok(a.ref !== 'x1' && a.ref !== 'x2', `action must not target forbidden ref ${a.ref}`);
  }
}

function types(plan) {
  return plan.actions.map((a) => a.type);
}

console.log('\n[safety policy] classifyHref');
check('safe internal page', () => assert.strictEqual(classifyHref('https://atb.tn/cartes', BASE).kind, 'internal'));
check('safe pdf document', () => assert.strictEqual(classifyHref('https://atb.tn/x.pdf', BASE).kind, 'document'));
check('docx document', () => assert.strictEqual(classifyHref('/forms/a.docx', BASE).kind, 'document'));
check('login is forbidden', () => assert.strictEqual(classifyHref('https://atb.tn/login', BASE).kind, 'forbidden'));
check('payment is forbidden', () => assert.strictEqual(classifyHref('https://atb.tn/paiement', BASE).kind, 'forbidden'));
check('javascript: is forbidden', () => assert.strictEqual(classifyHref('javascript:void(0)', BASE).kind, 'forbidden'));
check('external domain blocked', () => assert.strictEqual(classifyHref('https://facebook.com/x', BASE).kind, 'external'));
check('cross-domain pdf forbidden', () => assert.strictEqual(classifyHref('https://evil.com/x.pdf', BASE).kind, 'forbidden'));
check('.exe is not a safe document', () => assert.notStrictEqual(classifyHref('https://atb.tn/x.exe', BASE).kind, 'document'));

console.log('\n[goal detection] FR / EN / mixed');
check('credit card -> card_request', () => assert.strictEqual(detectGoals('I want a credit card')[0].id, 'card_request'));
check('lost card -> lost_card_support', () => assert.strictEqual(detectGoals('I lost my card')[0].id, 'lost_card_support'));
check('reclamation FR -> complaint_support', () => assert.strictEqual(detectGoals('jai une reclamation')[0].id, 'complaint_support'));
check('ouvrir un compte -> account_opening', () => assert.strictEqual(detectGoals('je veux ouvrir un compte')[0].id, 'account_opening'));
check('devenir client -> customer_onboarding', () => assert.strictEqual(detectGoals('je veux devenir client')[0].id, 'customer_onboarding'));
check('online banking -> online_banking', () => assert.strictEqual(detectGoals('I need online banking access')[0].id, 'online_banking'));
check('agence -> agency_location', () => assert.strictEqual(detectGoals('trouver une agence')[0].id, 'agency_location'));
check('search-term expansion includes card concepts', () => {
  const { core } = expandSearchTerms('I want a credit card');
  assert.ok(core.has('carte') && core.has('card') && core.has('credit'));
});

console.log('\n[routing gate] isPageControlTask');
check('natural card goal routes', () => assert.strictEqual(isPageControlTask('I want a credit card'), true));
check('lost card routes despite "my card"', () => assert.strictEqual(isPageControlTask('I lost my card, what should I do?'), true));
check('transfer is refused', () => assert.strictEqual(isPageControlTask('I want to transfer money to my friend'), false));
check('show my balance is refused', () => assert.strictEqual(isPageControlTask('show me my balance'), false));

console.log('\n[plans] natural test prompts');

check('1. credit card + document -> highlight + open safe pdf, no nav', () => {
  const plan = buildPagePlan('I want a credit card. Can you help me get the right document?', SNAPSHOT);
  assertActionsSafe(plan);
  assert.ok(types(plan).includes('openDocument'), 'should open a document');
  assert.ok(!types(plan).includes('clickLink'), 'should not navigate for a document goal');
  const doc = plan.actions.find((a) => a.type === 'openDocument');
  assert.strictEqual(classifyHref(byRef[doc.ref].href, BASE).kind, 'document');
});

check('2. form to request a card -> opens safe pdf', () => {
  const plan = buildPagePlan('I need the form to request a bank card.', SNAPSHOT);
  assertActionsSafe(plan);
  assert.ok(types(plan).includes('openDocument'));
});

check('3. become a customer -> safe internal navigation', () => {
  const plan = buildPagePlan('I want to become an ATB customer. What should I do?', SNAPSHOT);
  assertActionsSafe(plan);
  assert.strictEqual(plan.status, 'navigated');
  assert.ok(types(plan).includes('clickLink'));
});

check('4. service problem -> navigates to complaint entry', () => {
  const plan = buildPagePlan('I have a problem with my bank service, what should I do?', SNAPSHOT);
  assertActionsSafe(plan);
  assert.strictEqual(plan.actions[0].ref, 'l2'); // Réclamations
  assert.ok(types(plan).includes('clickLink'));
  assert.strictEqual(plan.status, 'navigated');
});

check('5. lost card -> navigates to opposition, no doc', () => {
  const q = 'I lost my card. Can you find the right support option for me?';
  assert.strictEqual(isPageControlTask(q), true);
  const plan = buildPagePlan(q, SNAPSHOT);
  assertActionsSafe(plan);
  assert.strictEqual(plan.actions[0].ref, 'l3'); // Opposition carte
  assert.ok(!types(plan).includes('openDocument'));
  assert.ok(types(plan).includes('clickLink'));
  assert.strictEqual(plan.status, 'navigated');
});

check('6. online banking where to start -> safe internal navigation', () => {
  const plan = buildPagePlan('I want to use ATB online banking. Help me find where to start.', SNAPSHOT);
  assertActionsSafe(plan);
  assert.strictEqual(plan.status, 'navigated');
});

check('7. official documents -> highlights documents entry', () => {
  const plan = buildPagePlan('I need official documents from the bank. Can you find where they are?', SNAPSHOT);
  assertActionsSafe(plan);
  const refs = plan.actions.map((a) => a.ref);
  assert.ok(refs.includes('l5') || plan.actions.some((a) => a.type === 'openDocument'));
});

check('8. open an account -> safe internal navigation', () => {
  const plan = buildPagePlan('I want to open an account. Find the most relevant page or document.', SNAPSHOT);
  assertActionsSafe(plan);
  assert.strictEqual(plan.status, 'navigated');
});

check('9. business owner -> highlights a pro/enterprise entry', () => {
  const plan = buildPagePlan('I am a business owner. Find the best entry point for me on this website.', SNAPSHOT);
  assertActionsSafe(plan);
  const refs = plan.actions.map((a) => a.ref);
  assert.ok(refs.includes('l8') || refs.includes('l9'), `expected pro/entreprise, got ${refs}`);
});

check('10. find an agency take me -> safe internal navigation to agency', () => {
  const plan = buildPagePlan('I need to find an ATB agency. Can you take me to the right place?', SNAPSHOT);
  assertActionsSafe(plan);
  assert.strictEqual(plan.status, 'navigated');
  const nav = plan.actions.find((a) => a.type === 'clickLink');
  assert.strictEqual(nav.ref, 'l11'); // Trouver une agence
});

check('resume: navigated plan does not navigate again', () => {
  const plan = buildPagePlan('I want to open an account.', SNAPSHOT, { navigated: true, step: 1 });
  assertActionsSafe(plan);
  assert.ok(!types(plan).includes('clickLink'), 'must not navigate twice');
  assert.strictEqual(plan.status, 'done');
});

console.log(`\npageControl tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
