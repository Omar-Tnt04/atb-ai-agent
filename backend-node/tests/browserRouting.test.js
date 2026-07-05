/**
 * Browser routing separation tests.
 *
 * Verifies that isBrowserAgentTask correctly routes site navigation requests
 * to the DOM agent and keeps resource/file analysis requests on the resource path.
 *
 * Run: node tests/browserRouting.test.js
 */
const assert = require('assert');
const {
  isBrowserAgentTask,
  isLightweightPageTask,
  _routingSignals,
} = require('../src/services/requestRouting.service');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectDomAgent(message, goals = []) {
  const result = isBrowserAgentTask(message, { goals });
  assert.strictEqual(
    result,
    true,
    `Expected dom_agent for: "${message}" — got resource_analysis`,
  );
}

function expectResourceAnalysis(message, goals = []) {
  const result = isBrowserAgentTask(message, { goals });
  assert.strictEqual(
    result,
    false,
    `Expected resource_analysis for: "${message}" — got dom_agent`,
  );
}

// ---------------------------------------------------------------------------
// DOM agent — site navigation cases
// ---------------------------------------------------------------------------

function runDomAgentCases() {
  const cases = [
    // French navigation verbs
    'Trouve le simulateur de crédit.',
    'Trouver le simulateur de crédit immobilier.',
    'Ouvre la page de contact ATB.',
    'Ouvre ATB Connect.',
    'Va sur la page Devenir Client.',
    'Va vers la page cartes bancaires.',
    'Aller à la page des formulaires.',
    'Accéder à la page réclamations.',
    'Je veux trouver le simulateur.',
    'Je veux accéder à la page contact.',
    'Navigue vers les services.',
    'Montre-moi la page des agences.',

    // French site-specific target nouns
    'Je veux simuler un crédit.',
    'Simulation de crédit immobilier.',
    'Devenir client ATB.',
    'Je veux devenir client.',
    'Nous contacter.',
    'Contactez-nous.',
    'Espace client ATB.',

    // French form/complaint/document navigation
    'Je veux déposer une réclamation.',
    'Trouve le formulaire d\'abonnement MOBILINK.',
    'Trouve la page des cartes bancaires.',
    'Trouve le service de transfert à l\'étranger.',

    // English navigation verbs
    'Find the credit simulator.',
    'Open the contact page.',
    'Go to the services page.',
    'Take me to the agency locator.',
    'Navigate to the complaints page.',
    'Show me the simulator.',
    'Find the MOBILINK subscription form.',

    // English site-specific target nouns
    'I want to simulate a loan.',
    'Credit simulator.',
    'I want to become a client.',
    'Become a customer.',
    'Contact us page.',
    'ATB Connect activation.',
  ];

  for (const msg of cases) {
    expectDomAgent(msg);
  }
  console.log(`  ✓ DOM agent cases: ${cases.length} passed`);
}

// ---------------------------------------------------------------------------
// Resource analysis — uploaded/visible document cases
// ---------------------------------------------------------------------------

function runResourceAnalysisCases() {
  const cases = [
    // Explicit document references
    'Analyse ce relevé de carte.',
    'Lis cette image.',
    'Que dit ce document ?',
    'Analyser ce fichier.',
    'Lis ce relevé.',

    // English uploaded file references
    'What is the credit card limit in this document?',
    'Extract the amount from this bill.',
    'What is the due date on this statement?',
    'Summarize this uploaded PDF.',
    'What is in this image?',
    'Extract the reference from this receipt.',

    // Personal account queries (not navigation)
    'What is my account balance?',
    'Show me my transactions.',
    'My card statement.',

    // Lightweight inspect (page control, not DOM agent)
    'What sections are on this page?',
    'List the links on this page.',
    'Highlight the contact section.',
    'Summarize what is visible here.',
  ];

  for (const msg of cases) {
    expectResourceAnalysis(msg);
  }
  console.log(`  ✓ Resource analysis cases: ${cases.length} passed`);
}

// ---------------------------------------------------------------------------
// _routingSignals — verify signal breakdown for key cases
// ---------------------------------------------------------------------------

function runSignalTests() {
  const sim = _routingSignals('Trouve le simulateur de crédit.');
  assert.strictEqual(sim.isSiteNav, true, 'trouve should trigger isSiteNav');
  assert.strictEqual(sim.isSiteTarget, true, 'simulateur should trigger isSiteTarget');
  assert.strictEqual(sim.isExplicitFile, false, 'no explicit file ref');

  const docRef = _routingSignals('What is the credit card limit in this document?');
  assert.strictEqual(docRef.isExplicitFile, true, 'this document should trigger isExplicitFile');

  const releve = _routingSignals('Analyse ce relevé de carte.');
  assert.strictEqual(releve.isExplicitFile, true, 'ce relevé should trigger isExplicitFile');

  const ouvre = _routingSignals('Ouvre la page de contact ATB.');
  assert.strictEqual(ouvre.isSiteNav, true, 'ouvre should trigger isSiteNav');
  assert.strictEqual(ouvre.isExplicitFile, false, 'no explicit file ref');

  const find = _routingSignals('Find the credit simulator.');
  assert.strictEqual(find.isSiteNav, true, 'find the should trigger isSiteNav');
  assert.strictEqual(find.isSiteTarget, true, 'simulator should trigger isSiteTarget');

  console.log('  ✓ Signal breakdown tests: 10 assertions passed');
}

// ---------------------------------------------------------------------------
// Critical regression: the original bug
// ---------------------------------------------------------------------------

function runRegressionTests() {
  // "Trouve le simulateur de crédit." was wrongly routed to resource analysis,
  // returning a Credit Card Limit Notice instead of navigating to the simulator.
  expectDomAgent('Trouve le simulateur de crédit.');
  expectDomAgent('Find the credit simulator.');

  // These must stay in resource analysis — the word "credit" alone is not enough
  // to make it a site navigation request when an explicit file reference is present.
  expectResourceAnalysis('What is the credit card limit in this document?');
  expectResourceAnalysis('Analyse ce relevé de carte.');

  console.log('  ✓ Regression tests: 4 passed');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function runAllTests() {
  console.log('browserRouting.test.js');
  console.log('');
  console.log('DOM agent routing:');
  runDomAgentCases();
  console.log('');
  console.log('Resource analysis routing:');
  runResourceAnalysisCases();
  console.log('');
  console.log('Signal breakdown:');
  runSignalTests();
  console.log('');
  console.log('Regression:');
  runRegressionTests();
  console.log('');
  console.log('browserRouting tests passed');
}

runAllTests();
