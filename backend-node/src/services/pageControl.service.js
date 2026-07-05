// Same-page control: turn a NATURAL customer request + a generic DOM snapshot (sent by the widget
// loader from the host page) into a small, safe action plan the loader runs on the SAME tab.
//
// The user never has to say "click" / "navigate" / "download". We infer a generic banking GOAL
// (card request, account opening, complaint, online banking, documents, agency, onboarding, lost
// card…), expand it into search concepts (FR/EN), then match those against the visible DOM text and
// hrefs. Fully generic — no site name, section name, or URL path is hardcoded.

// ---------------------------------------------------------------------------------------------
// Text utilities (accent-folding so "Réclamations" == "Reclamations", "Cartes" ~= "carte").
// ---------------------------------------------------------------------------------------------
function stripAccents(text) {
  // Decompose then drop combining diacritical marks (U+0300–U+036F).
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function normalize(text) {
  return stripAccents(text).toLowerCase().replace(/\s+/g, ' ').trim();
}
function words(text) {
  return normalize(text).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

const PAGE_STOPWORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'of', 'on', 'in', 'at', 'to', 'for', 'and',
  'or', 'what', 'which', 'where', 'who', 'how', 'is', 'are', 'am', 'was', 'were', 'be', 'can', 'do',
  'does', 'did', 'show', 'me', 'tell', 'about', 'find', 'list', 'give', 'see', 'look', 'go', 'open',
  'navigate', 'scroll', 'page', 'pages', 'site', 'website', 'web', 'homepage', 'section', 'sections',
  'area', 'areas', 'part', 'parts', 'content', 'contents', 'available', 'main', 'all', 'everything',
  'here', 'please', 'i', 'you', 'my', 'your', 'has', 'have', 'it', 'its', 'there', 'some', 'any',
  'more', 'most', 'they', 'them', 'with', 'from', 'get', 'into', 'out', 'up', 'down', 'take',
  'highlight', 'probably', 'would', 'will', 'then', 'explain', 'used', 'use', 'uses', 'customer',
  'action', 'why', 'when', 'should', 'could', 'point', 'points', 'want', 'need', 'help', 'right',
  'best', 'most', 'relevant', 'je', 'veux', 'un', 'une', 'le', 'la', 'les', 'des', 'pour', 'sur',
  'comment', 'aide', 'aidez', 'moi', 'trouver', 'ou', 'est', 'que', 'quoi',
]);

function contentTerms(text) {
  return words(text).filter((w) => w.length > 2 && !PAGE_STOPWORDS.has(w));
}

// Word-level match tolerant of simple plurals / French inflections (carte↔cartes, document↔
// documents). Generic — prefix overlap of >= 4 chars counts as a strong hit.
function wordMatches(labelWords, term) {
  if (!term) return false;
  for (const w of labelWords) {
    if (w === term) return true;
    if (term.length >= 4 && w.startsWith(term)) return true;
    if (w.length >= 4 && term.startsWith(w)) return true;
  }
  return false;
}

function hasWholeWord(normHaystack, normTerm) {
  if (!normTerm) return false;
  const re = new RegExp(`(^| )${normTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`);
  return re.test(` ${normHaystack} `);
}

function extractQuoted(text) {
  const out = [];
  const re = /["'“”‘’«»]([^"'“”‘’«»]{2,}?)["'“”‘’«»]/g;
  let match;
  while ((match = re.exec(String(text || '')))) {
    const value = match[1].trim();
    if (value) out.push(value);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Goal lexicon — generic banking goals. `triggers` detect the goal; `core` are strong search
// concepts; `support` are weak/generic concepts. Nothing here is ATB- or URL-specific.
// ---------------------------------------------------------------------------------------------
const GOALS = [
  {
    id: 'lost_card_support',
    label: 'a lost or stolen card',
    triggers: ['lost card', 'lost my card', 'stolen card', 'stolen my card', 'carte perdue',
      'perdu ma carte', 'perdu carte', 'vol carte', 'carte volee', 'block card', 'blocked card',
      'bloquer carte', 'opposition', 'card blocked'],
    core: ['opposition', 'perdu', 'vol', 'blocage', 'bloquer', 'lost', 'stolen', 'urgence',
      'assistance', 'securite'],
    support: ['carte', 'card', 'support', 'aide', 'contact', 'service'],
  },
  {
    id: 'complaint_support',
    label: 'a complaint or support issue',
    triggers: ['problem', 'complaint', 'reclamation', 'plainte', 'issue with', 'service problem',
      'probleme', 'support', 'help with my', 'not working', 'dispute', 'litige'],
    core: ['reclamation', 'plainte', 'complaint', 'litige', 'dispute', 'mediation', 'probleme'],
    support: ['support', 'assistance', 'aide', 'contact', 'service', 'help'],
  },
  {
    id: 'card_request',
    label: 'getting a bank card',
    triggers: ['credit card', 'debit card', 'bank card', 'carte bancaire', 'carte de credit',
      'carte de debit', 'card request', 'request a card', 'demande de carte', 'want a card',
      'need a card', 'carte'],
    core: ['carte', 'card', 'credit', 'debit', 'bancaire', 'visa', 'mastercard'],
    support: ['demande', 'formulaire', 'document', 'request', 'form', 'service', 'particuliers'],
  },
  {
    id: 'account_opening',
    label: 'opening an account',
    triggers: ['open account', 'open an account', 'ouvrir compte', 'ouvrir un compte',
      'account opening', 'ouverture compte', 'ouverture de compte', 'new account', 'nouveau compte'],
    core: ['compte', 'account', 'ouvrir', 'ouverture', 'opening'],
    support: ['demande', 'formulaire', 'particuliers', 'services', 'document', 'request'],
  },
  {
    id: 'customer_onboarding',
    label: 'becoming a customer',
    triggers: ['become customer', 'become a customer', 'become an atb', 'devenir client',
      'new customer', 'join the bank', 'sign up', 'become member', 'devenir membre'],
    core: ['devenir', 'client', 'onboarding', 'adhesion', 'inscription'],
    support: ['particuliers', 'nouveau', 'customer', 'services', 'compte', 'ouvrir'],
  },
  {
    id: 'online_banking',
    label: 'online banking access',
    triggers: ['online banking', 'internet banking', 'e-banking', 'ebanking', 'mobile banking',
      'digital banking', 'banque en ligne', 'espace client', 'online access', 'connect',
      'application mobile', 'app banking'],
    core: ['ebanking', 'online', 'internet', 'digital', 'connect', 'numerique', 'mobile'],
    support: ['banking', 'banque', 'ligne', 'espace', 'client', 'application', 'service'],
  },
  {
    id: 'documents_forms',
    label: 'documents or forms',
    triggers: ['document', 'documents', 'form', 'forms', 'formulaire', 'formulaires', 'fichier',
      'official document', 'documents utiles', 'telecharger', 'download', 'pdf'],
    core: ['document', 'formulaire', 'telechargement', 'pdf', 'fichier', 'form'],
    support: ['utiles', 'demande', 'services', 'particuliers', 'official'],
  },
  {
    id: 'agency_location',
    label: 'finding an agency or ATM',
    triggers: ['agency', 'agence', 'branch', 'atm', 'distributeur', 'near me', 'nearest',
      'find agency', 'find an agency', 'agency near', 'localisation', 'guichet'],
    core: ['agence', 'agency', 'branch', 'atm', 'distributeur', 'guichet', 'localisation'],
    support: ['contact', 'adresse', 'reseau', 'carte', 'near', 'proximite'],
  },
  {
    id: 'service_discovery',
    label: 'discovering services',
    triggers: ['services', 'products', 'offers', 'produits', 'offres', 'what do you offer',
      'business owner', 'entreprise', 'professionnel', 'professionnels', 'entreprises',
      'what can i do'],
    core: ['services', 'produits', 'offres', 'products', 'professionnels', 'entreprises'],
    support: ['offer', 'business', 'solutions', 'espace', 'particuliers'],
  },
];

const DOC_GOALS = new Set([
  'card_request', 'account_opening', 'customer_onboarding', 'documents_forms', 'complaint_support',
]);

// Detect goals present in the message, ranked by trigger strength (longer phrase = stronger).
function detectGoals(message) {
  const norm = normalize(message);
  const wordList = words(message);
  const hits = [];
  for (const goal of GOALS) {
    let score = 0;
    for (const trigger of goal.triggers) {
      const t = normalize(trigger);
      if (!t) continue;
      if (t.includes(' ')) {
        if (norm.includes(t)) score += 4 + t.length / 10;
      } else if (wordMatches(wordList, t)) {
        score += 2;
      }
    }
    if (score > 0) hits.push({ goal, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.map((h) => h.goal);
}

// Expand the detected goal + the user's own words into concept sets.
//   core      — strong goal concepts (a hit makes a candidate a real target)
//   support   — weak/generic goal concepts (help ranking only)
//   userTerms — the user's own content words (ranked below goal concepts so a brand name like
//               "atb" can't outrank a goal concept like "agence")
// Only the PRIMARY goal drives concepts — merging multiple goals let an accidental secondary goal
// (e.g. "service" → service discovery) pull the match to the wrong place.
function expandSearchTerms(message) {
  const goals = detectGoals(message);
  const core = new Set();
  const support = new Set();
  const primary = goals[0] || null;

  if (primary) {
    for (const t of primary.core) core.add(normalize(t));
    for (const t of primary.support) support.add(normalize(t));
  }
  const userTerms = new Set();
  for (const t of contentTerms(message)) {
    if (!core.has(t)) userTerms.add(t);
  }

  return { core, support, userTerms, goals, primary };
}

// ---------------------------------------------------------------------------------------------
// Safety policy — what the loader is allowed to click / open. Mirrored in the loader for
// defence-in-depth; the loader re-validates everything before acting.
// ---------------------------------------------------------------------------------------------
const SAFE_DOC_RE = /\.(pdf|docx?|xlsx?)(?=$|[?#])/i;
const FORBIDDEN_HREF_RE =
  /(^javascript:|^mailto:|^tel:|\b(login|log-in|signin|sign-in|logout|log-out|deconnexion|authentification|password|mot-de-passe|motdepasse|\botp\b|\bpin\b|payment|paiement|\bpay\b|transfer|transfert|virement|delete|supprimer|cancel|annuler|submit|valider)\b)/i;

function registrableDomain(hostname) {
  const parts = String(hostname || '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  return parts.slice(-2).join('.');
}

function parseHref(href, baseUrl) {
  try {
    return new URL(href, baseUrl || undefined);
  } catch {
    return null;
  }
}

function sameRegistrableDomain(url, baseUrl) {
  const base = parseHref(baseUrl, baseUrl);
  if (!url) return false;
  if (!base) {
    // No page origin known (manual mode) → only accept relative/internal-looking hrefs.
    return url.protocol === 'http:' || url.protocol === 'https:';
  }
  return registrableDomain(url.hostname) === registrableDomain(base.hostname);
}

function classifyHref(href, baseUrl) {
  const raw = String(href || '').trim();
  if (!raw || raw === '#') return { kind: 'none' };
  if (FORBIDDEN_HREF_RE.test(raw)) return { kind: 'forbidden' };
  const url = parseHref(raw, baseUrl);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return { kind: 'none' };
  const internal = sameRegistrableDomain(url, baseUrl);
  if (SAFE_DOC_RE.test(url.pathname)) {
    const ext = (url.pathname.match(SAFE_DOC_RE) || [''])[0].replace('.', '').toLowerCase();
    return { kind: internal ? 'document' : 'forbidden', fileType: ext, internal };
  }
  if (!internal) return { kind: 'external' };
  return { kind: 'internal', internal: true };
}

// ---------------------------------------------------------------------------------------------
// Candidate construction + scoring.
// ---------------------------------------------------------------------------------------------
const TYPE_WEIGHT = {
  'link-sidebar': 3.4, 'link-nav': 3.2, 'link-header': 3.0, menuitem: 3.2, button: 2.6,
  'link-footer': 2.4, link: 2.4, heading: 1.6, section: 1.0,
};

function regionPhrase(kind) {
  switch (kind) {
    case 'sidebar': return 'left side menu';
    case 'nav': return 'navigation menu';
    case 'header': return 'top navigation bar';
    case 'footer': return 'bottom menu';
    case 'menu': return 'menu';
    default: return 'page';
  }
}

function buildCandidates(snapshot) {
  const baseUrl = snapshot.url || '';
  const candidates = [];

  const pushLink = (link, fallbackType) => {
    if (!link || !link.text) return;
    const kind = link.kind || 'link';
    const type = link.type === 'menuitem'
      ? 'menuitem'
      : (TYPE_WEIGHT[`link-${kind}`] ? `link-${kind}` : (fallbackType || 'link'));
    const cls = classifyHref(link.href || '', baseUrl);
    candidates.push({
      ref: link.ref,
      label: link.text,
      matchText: link.text,
      href: link.href || '',
      kind,
      clickable: true,
      isDocument: cls.kind === 'document',
      fileType: cls.fileType || '',
      safeInternal: cls.kind === 'internal',
      safeDocument: cls.kind === 'document',
      weight: TYPE_WEIGHT[type] || TYPE_WEIGHT.link,
    });
  };

  for (const link of snapshot.links || []) pushLink(link);
  for (const button of snapshot.buttons || []) {
    if (!button || !button.text) continue;
    candidates.push({
      ref: button.ref, label: button.text, matchText: button.text, href: '',
      kind: button.kind || 'button', clickable: true, isDocument: false,
      safeInternal: false, safeDocument: false, weight: TYPE_WEIGHT.button,
    });
  }
  for (const heading of snapshot.headings || []) {
    if (!heading || !heading.text) continue;
    candidates.push({
      ref: heading.ref, label: heading.text, matchText: heading.text, href: '',
      kind: 'heading', clickable: false, isDocument: false,
      safeInternal: false, safeDocument: false, weight: TYPE_WEIGHT.heading,
    });
  }
  for (const section of snapshot.sections || []) {
    if (!section || !section.label) continue;
    candidates.push({
      ref: section.ref, label: section.label,
      matchText: `${section.label} ${section.text || ''}`, href: '',
      kind: 'section', clickable: false, isDocument: false,
      safeInternal: false, safeDocument: false, weight: TYPE_WEIGHT.section,
    });
  }
  return candidates;
}

function scoreCandidate(candidate, ctx) {
  const normLabel = normalize(candidate.label);
  const labelWords = words(candidate.label);
  if (!normLabel) return { score: 0, specific: false };

  let raw = 0;
  let specific = false;

  // Explicit quoted target — highest priority.
  for (const target of ctx.quoted) {
    if (!target) continue;
    if (normLabel === target) { raw += 100; specific = true; }
    else if (hasWholeWord(normLabel, target)) { raw += 60; specific = true; }
    else if (normLabel.includes(target)) { raw += 40; specific = true; }
  }
  // Whole label appears verbatim in the query.
  if (normLabel.length >= 3 && ctx.normQuery.includes(normLabel)) { raw += 50; specific = true; }

  // Strong goal concepts (inflection-tolerant) — a hit makes the candidate a real target.
  for (const term of ctx.core) {
    if (wordMatches(labelWords, term)) { raw += 8; specific = true; }
    else if (normLabel.includes(term)) { raw += 2; }
  }
  // The user's own words — meaningful, but ranked below goal concepts so a brand name can't
  // outrank a goal concept.
  for (const term of ctx.userTerms || []) {
    if (wordMatches(labelWords, term)) { raw += 5; specific = true; }
    else if (normLabel.includes(term)) { raw += 1.5; }
  }
  // Weak/generic concepts — help ranking but don't make a candidate "specific" on their own.
  for (const term of ctx.support) {
    if (wordMatches(labelWords, term)) { raw += 3; }
    else if (normLabel.includes(term)) { raw += 1; }
  }

  // Document relevance for goals that need a form/document.
  if (candidate.isDocument && ctx.docGoal) raw += 4;
  // Prefer a tight label over a long one carrying the same hit.
  if (specific && normLabel.length <= 32) raw += 1.5;

  return { score: raw * (candidate.weight || 1), specific };
}

// ---------------------------------------------------------------------------------------------
// Enumeration fallback (no specific target / pure discovery).
// ---------------------------------------------------------------------------------------------
function enumerationAnswer(snapshot, primaryGoal) {
  const labels = [];
  const seen = new Set();
  const push = (text) => {
    const value = (text || '').trim();
    if (!value) return;
    const key = normalize(value);
    if (seen.has(key)) return;
    seen.add(key);
    labels.push(value);
  };

  for (const link of snapshot.links || []) {
    if (labels.length >= 12) break;
    if (link && (link.kind === 'sidebar' || link.kind === 'nav' || link.kind === 'header')) {
      push(link.text);
    }
  }
  if (labels.length === 0) {
    for (const heading of snapshot.headings || []) {
      if (heading && (heading.tag === 'h1' || heading.tag === 'h2')) push(heading.text);
    }
  }
  if (labels.length === 0) {
    for (const section of snapshot.sections || []) push(section.label);
  }

  const intro = primaryGoal
    ? `I understand you're looking for ${primaryGoal.label}. I couldn't pinpoint a single matching item on this page, so here are the main entry points you can explore:`
    : 'Here are the main entry points I can see on this page:';

  if (labels.length === 0) {
    return `${intro}\n\n(I could not detect clearly labelled navigation on this page.)`;
  }
  return `${intro}\n${labels.map((l) => `- ${l}`).join('\n')}`;
}

// ---------------------------------------------------------------------------------------------
// Answer phrasing — natural customer language, no technical verbs required from the user.
// ---------------------------------------------------------------------------------------------
function describeResult(primaryGoal, best, doc, mode, resuming) {
  const where = (() => {
    const region = regionPhrase(best.kind);
    return region === 'page' ? 'on this page' : `in the ${region}`;
  })();

  if (mode === 'document') {
    const opened = doc || best;
    const ext = opened.fileType ? ` (${opened.fileType.toUpperCase()})` : '';
    if (doc && best.ref !== doc.ref) {
      return `I found **${best.label}** ${where} and opened **${doc.label}**${ext} in a new tab.`;
    }
    return `I opened **${opened.label}**${ext} in a new tab for you.`;
  }

  if (mode === 'navigate') {
    const goalHint = primaryGoal ? ` — the right place for ${primaryGoal.label}` : '';
    return `I found **${best.label}** ${where}${goalHint}. Taking you there now.`;
  }

  // highlight only — no safe clickable action available (external/forbidden link, non-clickable element, or already navigated)
  if (resuming) {
    return `I navigated you here. **${best.label}** looks like the most relevant section — you can continue from here.`;
  }
  const goalText = primaryGoal ? ` for ${primaryGoal.label}` : '';
  return `I found **${best.label}** ${where}${goalText ? ` — the most relevant section ${goalText}` : ''}.`;
}

// ---------------------------------------------------------------------------------------------
// Plan builder. Returns { answer, actions, status, goalState, goal }.
//   actions: { type:'scrollTo'|'highlight'|'clickAnchor'|'clickLink'|'openDocument', ref }
//   status:  'done' (finished) | 'navigated' (page will reload — resume the goal after)
// ---------------------------------------------------------------------------------------------
function buildPagePlan(task, snapshot, state) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { answer: 'No page content was available to inspect.', actions: [], status: 'done' };
  }

  const { core, support, userTerms, primary } = expandSearchTerms(task);
  const quoted = extractQuoted(task).map(normalize);
  const ctx = {
    core, support, userTerms, quoted, normQuery: normalize(task),
    docGoal: primary ? DOC_GOALS.has(primary.id) : false,
  };
  const goalState = { goalId: primary ? primary.id : null, step: (state && state.step) || 0 };

  const candidates = buildCandidates(snapshot);
  const noTerms = core.size === 0 && support.size === 0 && userTerms.size === 0 && quoted.length === 0;
  if (candidates.length === 0 || noTerms) {
    return { answer: enumerationAnswer(snapshot, primary), actions: [], status: 'done', goalState };
  }

  let best = null;
  let bestScore = 0;
  let bestDoc = null;
  let bestDocScore = 0;
  for (const candidate of candidates) {
    const { score, specific } = scoreCandidate(candidate, ctx);
    if (score > bestScore) { bestScore = score; best = { ...candidate, specific }; }
    // Only open a document on a precise (core/user-word) match — never on generic support overlap,
    // so e.g. "open an account" won't open an unrelated card form just because both say "formulaire".
    if (candidate.isDocument && candidate.safeDocument && specific && score > bestDocScore) {
      bestDocScore = score; bestDoc = { ...candidate };
    }
  }

  if (!best || !best.specific) {
    return { answer: enumerationAnswer(snapshot, primary), actions: [], status: 'done', goalState };
  }

  const actions = [
    { type: 'scrollTo', ref: best.ref },
    { type: 'highlight', ref: best.ref },
  ];

  // Document handling: if the goal needs a form/document and we found a safe one, open it.
  const wantsDoc = primary && DOC_GOALS.has(primary.id);
  let mode = 'highlight';
  let doc = null;
  if (wantsDoc && bestDoc && bestDocScore > 0) {
    doc = bestDoc;
    mode = 'document';
    if (best.ref !== doc.ref) {
      actions.push({ type: 'highlight', ref: doc.ref });
    }
    actions.push({ type: 'openDocument', ref: doc.ref, fileType: doc.fileType });
  }

  // Safe internal navigation: automatically click any safe same-domain link when the goal hasn't
  // been completed yet. Terminal step — the page reloads and the widget resumes the goal after.
  const alreadyNavigated = Boolean(state && state.navigated);
  if (mode !== 'document' && best.clickable && best.safeInternal && !alreadyNavigated) {
    actions.push({ type: 'clickLink', ref: best.ref });
    mode = 'navigate';
    return {
      answer: describeResult(primary, best, null, mode, false),
      actions,
      status: 'navigated',
      goalState: { ...goalState, navigated: true },
      goal: goalState.goalId,
    };
  }

  return {
    answer: describeResult(primary, best, doc, mode, alreadyNavigated),
    actions,
    status: 'done',
    goalState,
    goal: goalState.goalId,
  };
}

// ---------------------------------------------------------------------------------------------
// Routing gate (only used when a host-page snapshot is present). Broader than the
// site-index navigation gate: any natural goal, navigation, find, or quoted target runs same-page control.
// Refuses transactional / private-data intents — EXCEPT support goals (lost card / complaint),
// which are public help requests even when phrased with "my card".
// ---------------------------------------------------------------------------------------------
const TRANSACTION_RE =
  /\b(transfer|virement|send\s+(money|funds)|pay\s+bill|wire|book\s+(appointment|meeting)|sign\s+in|log\s*in)\b/i;
const PERSONAL_RE =
  /\b(my\s+(account|balance|transaction|transfer|bill|statement|history|loan)\b)/i;
const PAGE_NAV_RE =
  /\b(find|search|look\s+for|locate|where|show\s+me|take\s+me|bring\s+me|go\s+to|jump\s+to|open|navigate|scroll|highlight|on\s+this\s+page|entry\s+points)\b/i;
const INFO_RE = /\b(what|how|where|which|tell\s+me|show\s+me|list|describe|explain|summarize)\b/i;
const PAGE_NOUN_RE =
  /\b(pages?|sites?|websites?|menus?|sections?|features?|options?|contents?|services?|products?|offers?|links?|tabs?|buttons?|documents?|forms?)\b/i;

function isPageControlTask(message) {
  const text = String(message || '').toLowerCase();
  if (!text) return false;

  const goals = detectGoals(message);
  const supportGoal = goals.some((g) => g.id === 'lost_card_support' || g.id === 'complaint_support');

  if (TRANSACTION_RE.test(text)) return false;
  if (PERSONAL_RE.test(text) && !supportGoal) return false;

  if (goals.length > 0) return true;
  if (PAGE_NAV_RE.test(text)) return true;
  if (extractQuoted(message).length > 0) return true;
  if (INFO_RE.test(text) && PAGE_NOUN_RE.test(text)) return true;
  return false;
}

module.exports = {
  buildPagePlan,
  isPageControlTask,
  detectGoals,
  expandSearchTerms,
  classifyHref,
};
