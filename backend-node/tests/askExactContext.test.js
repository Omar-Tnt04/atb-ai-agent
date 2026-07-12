'use strict';
/**
 * askExactContext.test.js — unified evidence ranking for Ask mode (no hardcoded page ids).
 * Pure/offline: no browser, no Ollama. Uses a fixture ask-exact-context + injected model.
 *
 *   node backend-node/tests/askExactContext.test.js
 */

const assert = require('assert');
process.env.ASK_USE_LLM_SYNTHESIS = 'true'; // before requiring askContext

const X = require('../src/services/askExactContext.service');
const { buildCombinedAnswerLLM } = require('../src/services/askContext.service');

// ── fixture: an in-memory ask-exact-context.json spanning hub + product + service pages ──
const HOURS = "Horaires d'ouverture des agences : Du lundi au Vendredi De 8h15 à 13h30 et de 15h à 17h30. Liste complète des agences ATB.";
const NAMES = 'Liste complète des agences par gouvernorat. Ariana : Ariana, Ennasr, Raoued, Soukra. Béja : Beja, Teboursouk. Ben Arous : Ben Arous, Boumhel, El Mourouj, Ezzahra, Hammam Lif, Megrine, Rades, Fouchana.';
const HOME_MENU = 'Espace Particuliers Espace Professionnels Espace Entreprises Espace Finance Documents Utiles Recrutement Nous Contacter Trouver votre agence Se connecter Mentions légales Plan du site Newsletter Tarifs Engagement Qualité Conseils cartes bancaires Médiateur de l ATB.';
const RENOV = "Crédit Renov : ATB RENOV couvre jusqu'à 80% du montant, jusqu'à 200 000 DT, sur 20 ans. touche de fraîcheur installation de chauffage.";

const exactCtx = {
  exactBlocks: [
    { id: 'agences', url: 'https://atb.tn/nos-agences-en-tunisie', title: 'Nos agences en Tunisie', language: 'fr', usefulForQuestionsAbout: ['agences', 'liste des agences', 'horaires'], exactChunks: [{ chunkIndex: 0, text: HOURS }, { chunkIndex: 1, text: NAMES }] },
    { id: 'home', url: 'https://atb.tn/', title: 'Accueil', language: 'fr', usefulForQuestionsAbout: [], exactChunks: [{ chunkIndex: 0, text: HOME_MENU }] },
    { id: 'credit-renov', url: 'https://atb.tn/produits/credit-Renov-presentation.php', title: 'Crédit Renov', language: 'fr', usefulForQuestionsAbout: ['renov', 'travaux'], exactChunks: [{ chunkIndex: 0, text: RENOV }] },
    { id: 'services-banque-atbconnect', url: 'https://atb.tn/services-banque-atbconnect', title: 'ATB Connect', language: 'fr', usefulForQuestionsAbout: ['connect'], exactChunks: [{ chunkIndex: 0, text: 'ATB Connect est la banque en ligne pour gérer vos comptes à distance.' }] },
    { id: 'services-mobilink', url: 'https://atb.tn/services-mobilink', title: 'Mobilink', language: 'fr', usefulForQuestionsAbout: ['mobilink'], exactChunks: [{ chunkIndex: 0, text: "Mobilink est l'application mobile bancaire ATB pour vos opérations." }] },
    { id: 'services-atbpay', url: 'https://atb.tn/services-atbpay', title: 'ATB PAY', language: 'fr', usefulForQuestionsAbout: ['atb pay', 'qr'], exactChunks: [{ chunkIndex: 0, text: 'ATB PAY est le service de paiement mobile par QR code.' }] },
    // Reproduces the real failure: a product page whose GLOBAL NAV mentions "ATB Connect".
    // Its text mentions the entity; only services-banque-atbconnect IS the entity.
    { id: 'credit-start', url: 'https://atb.tn/produits/credit-start-presentation.php', title: 'Crédit Start', language: 'fr', usefulForQuestionsAbout: ['credit start'], exactChunks: [{ chunkIndex: 0, text: 'Crédit Start : financement pour les jeunes diplômés ATB. Les autres services ATB Connect Mobilink ATB PAY. ATB Connect vous permet la consultation de vos comptes.' }] },
    { id: 'offres-emploi', url: 'https://atb.tn/offres-emploi', title: 'Offres Emploi', language: 'fr', usefulForQuestionsAbout: ['recrutement', 'emploi'], exactChunks: [{ chunkIndex: 0, text: 'Offres de recrutement ATB : postulez à nos offres emploi et carrière. Recrutement ouvert.' }] },
  ],
};

// The ONE production entry: unified ranking → selected pack → link from that pack.
const packFor = (message, opts = {}) => X.buildAskEvidencePack({ exactContext: exactCtx, message, ...opts });
const packIds = (pack) => pack.selectedEvidence.map((e) => `${e.evidenceKind}:${e.id}`);

const ids = (ev) => ev.map((e) => e.blockId);
const joined = (ev, id) => (ev.find((e) => e.blockId === id) || { chunks: [] }).chunks.join(' ');

// ── 1. missing / null context → silent fallback, no throw ──────────────────────
assert.deepStrictEqual(X.selectExactEvidence(null, { message: 'q' }), []);
assert.deepStrictEqual(X.selectExactEvidence({ exactBlocks: [] }, { message: 'q' }), []);
assert.strictEqual(X.loadAskExactContext('nonexistent.invalid.domain'), null);
assert.deepStrictEqual(X.buildExactEvidence({ domain: 'nonexistent.invalid.domain', message: 'q' }), []);
assert.deepStrictEqual(X.rankEvidenceCandidates('q', []), []);

// ── 2. "donne moi la liste complète des agences" → agences exact is primary ────
{
  const ev = X.selectExactEvidence(exactCtx, { message: 'donne moi la liste complète des agences' });
  assert.ok(ids(ev).includes('agences'), 'agences block must be selected');
  assert.ok(!ids(ev).includes('home'), 'home menu block must NOT be selected');
  assert.ok(/liste complète des agences/i.test(joined(ev, 'agences')));
  assert.ok(/ariana|ben arous/i.test(joined(ev, 'agences')), 'grouped governorate examples present');
}

// ── 3. "quels sont les horaires des agences" → hours chunk ranks top ───────────
{
  const cands = X.buildExactCandidates(exactCtx);
  const ranked = X.rankEvidenceCandidates('quels sont les horaires des agences ?', cands);
  assert.ok(/Du lundi au Vendredi/.test(ranked[0].text) && /8h15/.test(ranked[0].text), 'hours chunk ranked first');
  const ev = X.selectExactEvidence(exactCtx, { message: 'quels sont les horaires des agences ?' });
  assert.ok(/Du lundi au Vendredi/.test(joined(ev, 'agences')) && /8h15/.test(joined(ev, 'agences')));
}

// ── 4. "télécharge la liste des agences" → document ranks above exact ──────────
{
  const doc = { sourceFile: 'catalog.json', evidenceKind: 'catalog_resource', id: 'agences-pdf', url: 'https://atb.tn/docs/agences.pdf', title: 'Liste des agences', text: 'Liste des agences ATB à télécharger PDF' };
  const cands = [doc, ...X.buildExactCandidates(exactCtx)];
  const ranked = X.rankEvidenceCandidates('télécharge la liste des agences', cands, { intent: X.detectAskIntent('télécharge la liste des agences') });
  assert.ok(['document', 'catalog_resource', 'form'].includes(ranked[0].evidenceKind), 'document/catalog ranks first for download');
  const topExact = ranked.find((c) => c.evidenceKind === 'exact_chunk');
  assert.ok(ranked[0].score > topExact.score, 'document outranks exact text');
}

// ── 5/6. "Télécharge le formulaire ATBNET et ATB Mobile" → catalog form above exact ──
{
  const form = { sourceFile: 'catalog.json', evidenceKind: 'catalog_resource', id: 'atbnet-form', url: 'https://atb.tn/docs/atbnet.pdf', title: 'Formulaire ATBNET', text: 'Formulaire adhésion ATBNET et ATB Mobile à remplir' };
  const menu = { sourceFile: 'ask-exact-context.json', evidenceKind: 'exact_chunk', id: 'home', url: 'https://atb.tn/', title: 'Accueil', text: HOME_MENU };
  const q = 'Télécharge le formulaire ATBNET et ATB Mobile';
  const ranked = X.rankEvidenceCandidates(q, [menu, form], { intent: X.detectAskIntent(q) });
  assert.strictEqual(ranked[0].evidenceKind, 'catalog_resource', 'form/catalog beats noisy menu exact text');
}

// ── 7. comparison query retrieves MULTIPLE service blocks ──────────────────────
{
  const ev = X.selectExactEvidence(exactCtx, { message: 'Quelle est la différence entre ATB Connect, Mobilink et ATB PAY ?' });
  const svc = ids(ev).filter((i) => ['services-banque-atbconnect', 'services-mobilink', 'services-atbpay'].includes(i));
  assert.ok(svc.length >= 2, `comparison should surface >=2 service blocks, got ${JSON.stringify(ids(ev))}`);
}

// ── 8. boilerplate (home menu) is penalized, does not outrank relevant exact ────
{
  const cands = X.buildExactCandidates(exactCtx);
  const ranked = X.rankEvidenceCandidates('donne moi la liste complète des agences', cands);
  const agences = ranked.find((c) => c.id === 'agences');
  const home = ranked.find((c) => c.id === 'home');
  assert.ok(agences.score > home.score, 'agences must outrank home menu boilerplate');
  assert.ok(X.boilerplateFraction(HOME_MENU) > X.boilerplateFraction(NAMES), 'menu text is more boilerplate than agency list');
}

// ── 9. current-page boost ──────────────────────────────────────────────────────
{
  const a = { evidenceKind: 'exact_chunk', id: 'agences', url: 'https://atb.tn/nos-agences-en-tunisie', title: 'Nos agences', text: NAMES };
  const b = { evidenceKind: 'exact_chunk', id: 'other', url: 'https://atb.tn/autre-page', title: 'Autre', text: NAMES };
  const ranked = X.rankEvidenceCandidates('donne moi la liste complète', [b, a], { currentUrl: 'https://atb.tn/nos-agences-en-tunisie/' });
  assert.strictEqual(ranked[0].id, 'agences', 'current-page candidate ranks first');
  assert.ok(ranked[0].currentMatch && ranked[0].reasons.includes('currentPage'));
  const ev = X.selectExactEvidence(exactCtx, { message: 'donne moi la liste complète', currentUrl: 'https://atb.tn/nos-agences-en-tunisie' });
  assert.ok(ids(ev).includes('agences'));
}

// ── 4b (Renov). "Expliquez Crédit Renov" → credit-renov exact chunks ───────────
{
  const ev = X.selectExactEvidence(exactCtx, { message: 'Expliquez Crédit Renov' });
  assert.ok(ids(ev).includes('credit-renov'));
  const all = joined(ev, 'credit-renov');
  for (const s of ['80%', '200 000 DT', '20 ans']) assert.ok(all.includes(s), `renov missing ${s}`);
}

// ── intent detection sanity ────────────────────────────────────────────────────
assert.strictEqual(X.detectAskIntent('télécharge la liste des agences').intent, 'document_or_form_request');
assert.strictEqual(X.detectAskIntent('donne moi la liste complète des agences').intent, 'page_information_request');
assert.strictEqual(X.detectAskIntent('quelle est la différence entre A et B').intent, 'comparison_request');
assert.ok(X.detectAskIntent('la liste sur cette page').isCurrentPage);

console.log('askExactContext ranking: all assertions passed');

// ── ASK answer-link selection: the link may ONLY come from the selected evidence ─
{
  const askB = (id, url, title, richContext) => ({ block: { id, url, title, richContext } });

  // Every askLink must point at an item that is actually inside the pack (no divergence).
  const assertLinkInPack = (pack, label) => {
    if (!pack.askLink) return;
    assert.strictEqual(pack.askLink.derivedFrom, 'selected_evidence', `${label}: link must derive from the pack`);
    assert.ok(
      pack.selectedEvidence.some((e) => e.url === pack.askLink.url && e.evidenceKind === pack.askLink.sourceType),
      `${label}: askLink ${pack.askLink.url} is not in the selected evidence pack`,
    );
  };

  // 1. THE BUG: "c'est quoi atb connect ?" — the Crédit Start page mentions ATB Connect in
  //    its nav, but only services-banque-atbconnect IS ATB Connect. Answer AND link must agree.
  {
    const pack = packFor("c'est quoi atb connect ?");
    assert.strictEqual(pack.selectedEvidence[0].id, 'services-banque-atbconnect', `top evidence must be ATB Connect, got ${JSON.stringify(packIds(pack))}`);
    assert.ok(pack.exactEvidence.some((e) => e.blockId === 'services-banque-atbconnect'), 'answer evidence includes ATB Connect');
    assert.strictEqual(pack.askLink.url, 'https://atb.tn/services-banque-atbconnect', 'link must be the ATB Connect page');
    assert.ok(!/credit-start/i.test(pack.askLink.url), 'Crédit Start must never be the ATB Connect link');
    assertLinkInPack(pack, 'atb connect');
  }

  // 2. "explique crédit start" → answer + link both Crédit Start
  {
    const pack = packFor('explique crédit start');
    assert.strictEqual(pack.selectedEvidence[0].id, 'credit-start');
    assert.strictEqual(pack.askLink.url, 'https://atb.tn/produits/credit-start-presentation.php');
    assertLinkInPack(pack, 'credit start');
  }

  // 3. "c'est quoi mobilink ?" → answer + link both Mobilink
  {
    const pack = packFor("c'est quoi mobilink ?");
    assert.strictEqual(pack.exactEvidence[0].blockId, 'services-mobilink');
    assert.strictEqual(pack.askLink.url, 'https://atb.tn/services-mobilink');
    assertLinkInPack(pack, 'mobilink');
  }

  // 4. recruitment → /offres-emploi (exact page + the ask-context block agree)
  {
    const pack = packFor('quels sont les offres de recrutement ATB ?', {
      askBlocks: [askB('offres-emploi', 'https://atb.tn/offres-emploi', 'Offres Emploi', 'Offres de recrutement ATB emploi carrière recrute'), askB('agences', 'https://atb.tn/nos-agences-en-tunisie', 'Nos agences', 'liste des agences')],
    });
    assert.strictEqual(pack.askLink.url, 'https://atb.tn/offres-emploi', 'recruitment link must be /offres-emploi');
    assertLinkInPack(pack, 'recrutement');
  }

  // 5. agency list → /nos-agences-en-tunisie
  {
    const pack = packFor('donne moi la liste complète des agences');
    assert.ok(pack.exactEvidence.some((e) => e.blockId === 'agences'));
    assert.strictEqual(pack.askLink.url, 'https://atb.tn/nos-agences-en-tunisie');
    assert.strictEqual(pack.askLink.sourceType, 'exact_chunk');
    assertLinkInPack(pack, 'agences');
  }

  // 6. document request → the selected document/catalog resource, not the page text
  {
    const pack = packFor('télécharge le formulaire ATBNET et ATB Mobile', {
      catalogEntries: [{ id: 'atbnet-form', url: 'https://atb.tn/doc/Formulaire_ATBNET-ATBMOBILE.pdf', title: 'Formulaire ATBNET', description: 'Formulaire adhésion ATBNET et ATB Mobile', evidence: 'formulaire atbnet atb mobile à remplir' }],
    });
    assert.strictEqual(pack.askLink.url, 'https://atb.tn/doc/Formulaire_ATBNET-ATBMOBILE.pdf', 'download link must be the document resource');
    assert.strictEqual(pack.askLink.sourceType, 'catalog_resource');
    assertLinkInPack(pack, 'document');
  }

  // 7. SYNTHETIC divergence guard: candidate B ("agences") would win a standalone rerank of
  //    the raw universe, but it is NOT in the selected evidence pack → it can never be the link.
  {
    const A = { sourceFile: 'ask-exact-context.json', evidenceKind: 'exact_chunk', id: 'credit-renov', url: 'https://atb.tn/produits/credit-Renov-presentation.php', title: 'Crédit Renov', text: RENOV, score: 3.0, reasons: ['selected'] };
    const B = { sourceFile: 'ask-exact-context.json', evidenceKind: 'exact_chunk', id: 'agences', url: 'https://atb.tn/nos-agences-en-tunisie', title: 'Nos agences', text: NAMES, score: 9.9, reasons: ['not-selected'] };
    const link = X.selectAskAnswerLink({ message: 'Expliquez Crédit Renov', selectedEvidence: [A] }); // B never enters the pack
    assert.strictEqual(link.url, A.url, 'link must come from the selected evidence, not a higher-scoring outsider');
    assert.strictEqual(link.derivedFrom, 'selected_evidence');
    assert.ok(!X.selectAskAnswerLink({ message: 'Expliquez Crédit Renov', selectedEvidence: [A] }).url.includes('agences'));
    void B;
  }

  // stale currentUrl (agences) cannot override the relevant top evidence (offres-emploi)
  {
    const pack = packFor('quels sont les offres de recrutement ATB', {
      askBlocks: [askB('offres-emploi', 'https://atb.tn/offres-emploi', 'Offres Emploi', 'Offres de recrutement ATB emploi carrière recrute')],
      currentUrl: 'https://atb.tn/nos-agences-en-tunisie',
    });
    assert.strictEqual(pack.askLink.url, 'https://atb.tn/offres-emploi', 'stale currentUrl must not override top evidence');
  }

  // currentUrl is used ONLY when the pack carries no usable URL
  {
    const l = X.selectAskAnswerLink({ message: 'et alors ?', selectedEvidence: [], currentUrl: 'https://atb.tn/contact' });
    assert.strictEqual(l.derivedFrom, 'current_url');
    assert.strictEqual(X.selectAskAnswerLink({ message: 'x', selectedEvidence: [] }), null);
    // non-ATB URLs are never linked
    assert.strictEqual(X.selectAskAnswerLink({ message: 'x', selectedEvidence: [{ evidenceKind: 'exact_chunk', url: 'https://evil.example/atb', score: 5 }] }), null);
  }

  console.log('askExactContext answer-link: all assertions passed');
}

// ── synthesis threads unified exact evidence; guard accepts exact numbers ──────
(async () => {
  const exactEvidence = [{ blockId: 'agences', url: 'https://atb.tn/nos-agences-en-tunisie', title: 'Nos agences', chunks: [NAMES, HOURS] }];
  const fakeModel = async () => JSON.stringify({ answer: 'Oui, cette page contient la liste complète des agences par gouvernorat. Exemples : Ariana ; Béja ; Ben Arous. La liste complète est sur la page.' });
  const diag = {};
  const res = await buildCombinedAnswerLLM('donne moi la liste complète des agences', {
    askBlocks: [], catalogEntries: [], exactEvidence, callModel: fakeModel, diag, responseLanguage: 'fr',
  });
  assert.ok(res.answered && res.synthesized, 'exact-only evidence should synthesize');
  assert.ok(res.sources.some((s) => s.startsWith('ask-exact-context.json:')), 'labeled ask-exact-context.json');
  assert.ok(!diag.guardRejected, 'guard accepts answer grounded in exact evidence');
  assert.strictEqual(diag.exactBlocksUsed, 1);

  const diag2 = {};
  const none = await buildCombinedAnswerLLM('q', { askBlocks: [], catalogEntries: [], exactEvidence: [], callModel: fakeModel, diag: diag2, responseLanguage: 'fr' });
  assert.strictEqual(none.answered, false, 'no evidence → answered:false');

  console.log('askExactContext synthesis: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
