'use strict';

const assert = require('assert');
const {
  expandTerms,
  enrichPageDeterministically,
  searchSiteContext,
} = require('../lib/site-context');
const { validateContext } = require('../validate-site-context');
const {
  addStructuredFallbackSections,
  isCrawlable,
  removeRepeatedContacts,
} = require('../build-site-context');

const basePage = {
  url: 'https://example.test/', path: '/', title: 'Example Bank', metaDescription: '', language: 'fr',
  pageType: '', pagePurpose: '', cleanText: 'Horaires du lundi au vendredi de 08h15 à 13h30.',
  headings: ['Bienvenue'], sections: [{ heading: 'Horaires', text: 'Du lundi au vendredi de 08h15 à 13h30.', facts: [] }],
  keyFacts: [], keywords: [], searchText: '', contactFacts: { emails: [], phones: [], addresses: [] },
  hours: ['Horaires du lundi au vendredi de 08h15 à 13h30.'], documents: [], forms: [], buttons: [], links: [],
  contentQuality: { hasMainContent: true, boilerplateRemoved: true, textLength: 52, confidence: 0.8 },
};

const home = enrichPageDeterministically(basePage);
const credit = enrichPageDeterministically({ ...basePage,
  url: 'https://example.test/produits/credit-auto', path: '/produits/credit-auto', title: 'Crédit automobile',
  cleanText: 'Ce crédit finance un véhicule avec une durée définie selon les conditions du contrat.',
  headings: ['Crédit automobile'], sections: [{ heading: 'Crédit automobile', text: 'Ce crédit finance un véhicule.', facts: [] }],
  hours: [], contentQuality: { ...basePage.contentQuality, textLength: 84 },
});
const contact = enrichPageDeterministically({ ...basePage,
  url: 'https://example.test/contact', path: '/contact', title: 'Nous contacter',
  cleanText: 'Email: support@example.test. Téléphone: +216 71 000 000.', headings: ['Nous contacter'],
  sections: [{ heading: 'Nous contacter', text: 'Email: support@example.test. Téléphone: +216 71 000 000.', facts: [] }],
  contactFacts: { emails: ['support@example.test'], phones: ['+216 71 000 000'], addresses: [] }, hours: [],
  contentQuality: { ...basePage.contentQuality, textLength: 61 },
});
const recruitment = enrichPageDeterministically({ ...basePage,
  url: 'https://example.test/offres-emploi', path: '/offres-emploi', title: 'Offres emploi',
  cleanText: 'Consultez les postes disponibles.', headings: ['Recrutement'], sections: [],
  hours: [], forms: [], contentQuality: { ...basePage.contentQuality, textLength: 34 },
});
const context = { meta: { targetUrl: 'https://example.test', generatedAt: new Date().toISOString(), pagesCrawled: 3 }, pages: [home, credit, contact] };

assert.ok(expandTerms('loan').includes('credit'), 'English loan expands to French credit');
assert.ok(home.keyFacts.some((fact) => /08h15/.test(fact)), 'hours become deterministic facts');
assert.strictEqual(credit.pageType, 'product');
assert.strictEqual(searchSiteContext('loan products', context)[0].page.path, '/produits/credit-auto');
assert.strictEqual(searchSiteContext('contact', context)[0].page.path, '/contact');
assert.strictEqual(contact.pageType, 'contact');
assert.strictEqual(recruitment.pageType, 'listing');

const weakRecruitment = enrichPageDeterministically({ ...basePage,
  url: 'https://example.test/offres-emploi', path: '/offres-emploi', title: 'Offres emploi',
  cleanText: 'Postuler', headings: [], sections: [], hours: [],
  contentQuality: { ...basePage.contentQuality, hasMainContent: false, textLength: 8, confidence: 0.2 },
});
const detailedRecruitment = enrichPageDeterministically({ ...basePage,
  url: 'https://example.test/jobs', path: '/jobs', title: 'Offres emploi',
  cleanText: 'Offres emploi et recrutement. Nous recrutons un ingénieur réseau avec des compétences techniques et une expérience professionnelle détaillée.',
  headings: ['Offres emploi'], sections: [], hours: [],
  contentQuality: { ...basePage.contentQuality, textLength: 111, confidence: 0.8 },
});
const weakRecruitmentScore = searchSiteContext('recruitment page', { pages: [weakRecruitment] })[0].score;
const detailedRecruitmentScore = searchSiteContext('recruitment page', { pages: [detailedRecruitment] })[0].score;
assert.ok(detailedRecruitmentScore > weakRecruitmentScore);

const fallbackPage = {
  ...basePage,
  cleanText: '',
  sections: [],
  hours: ['Du lundi au vendredi de 08h15 à 13h30.'],
  documents: [{ text: 'Account opening form', fileName: 'account-form.pdf' }],
  forms: [],
  contentQuality: { hasMainContent: false, boilerplateRemoved: true, textLength: 0, confidence: 0.2 },
};
assert.strictEqual(addStructuredFallbackSections([fallbackPage]), 1);
assert.match(fallbackPage.cleanText, /08h15/);
assert.match(fallbackPage.cleanText, /Account opening form/);
assert.strictEqual(fallbackPage.contentQuality.hasMainContent, true);

assert.strictEqual(isCrawlable('https://example.test/services', 'example.test'), true);
assert.strictEqual(isCrawlable('https://example.test/login', 'example.test'), false);
assert.strictEqual(isCrawlable('https://other.test/services', 'example.test'), false);

const repeatedContactPages = Array.from({ length: 4 }, (_, index) => ({
  path: index === 0 ? '/contact' : `/page-${index}`,
  title: index === 0 ? 'Contact' : `Page ${index}`,
  headings: [],
  contactFacts: { emails: ['global@example.test'], phones: ['+216 71 000 000'], addresses: [] },
}));
assert.strictEqual(removeRepeatedContacts(repeatedContactPages), 6);
assert.deepStrictEqual(repeatedContactPages[0].contactFacts.emails, ['global@example.test']);
assert.deepStrictEqual(repeatedContactPages[1].contactFacts.emails, []);

const validation = validateContext(context, { queries: ['opening hours', 'loan', 'contact'], minQueryCoverage: 1, minCleanRatio: 1 });
assert.ok(validation.passed, validation.checks.filter((check) => !check.passed).map((check) => check.name).join(', '));

console.log('ok - site-context helpers and validation');
