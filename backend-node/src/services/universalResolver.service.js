'use strict';

// ── Universal Resource Resolver ───────────────────────────────────────────────
// Evidence-based. No site-specific knowledge. Compares a TargetSpec derived
// from user intent against Resource metadata produced by siteIndex normalizers.

// ── Text normalization ────────────────────────────────────────────────────────

// Lowercase, strip accent combining marks, collapse non-alphanum to spaces.
function _strip(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Stop words — accent-normalized lowercase.
const STOP = new Set([
  // English filler / action verbs
  'the','and','for','are','this','that','with','from','what','how','can','you','have',
  'will','not','all','any','about','would','could','should','their','which','when','were',
  'find','search','get','want','please','open','show','download','page','site','web',
  // French articles, particles (3+ chars allowed through length filter)
  'les','des','pour','dans','sur','une','est','qui','que','par','pas','cette','aux',
  'votre','notre','mon','mes','son','ses','nous','vous','lui',
  // French action verbs (accent-stripped)
  'veux','voudrais','voulez','cherche','chercher','trouver','ouvrir','aller',
  'telecharger','vouloir','acceder','naviguer',
  // Proximity / spatial
  'pres','aupres','proche','vers','chez',
]);

// Generic bilingual alias groups. No site-specific product names.
// All terms must be accent-stripped (applied at build time via _strip).
const _ALIAS_GROUPS_RAW = [
  ['contact', 'contacter', 'joindre', 'reach'],
  ['card', 'carte', 'cartes', 'bancaire', 'bancaires'],
  ['request', 'demande', 'demander'],
  ['form', 'formulaire', 'formulaires'],
  ['credit', 'credit', 'pret', 'financement', 'loan'],
  ['tariff', 'tariffs', 'tarif', 'tarifs', 'fees', 'fee', 'frais'],
  ['agency', 'agence', 'agences', 'branch', 'branches'],
  ['list', 'liste'],
  ['messenger', 'atbmessenger'],
  ['mobile', 'mobilink'],
  ['transfer', 'transfert', 'virement'],
  ['engagement', 'normes', 'delais', 'qualite', 'norms'],
  ['abonnement', 'subscription', 'subscribe'],
  ['region', 'regions', 'zone'],
];

const _aliasMap = new Map();
for (const group of _ALIAS_GROUPS_RAW) {
  const normed = group.map(_strip);
  for (const t of normed) {
    if (!_aliasMap.has(t)) _aliasMap.set(t, normed);
  }
}

function _tok(text) {
  return _strip(text)
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

// Prefix stem match covers plural / gender / verb morphological variants.
// n < 4 prevents very short tokens (e.g. "atb") from matching longer compound
// tokens via prefix (e.g. "atbmessenger"), which would cause alias bleed.
function _stem(a, b) {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n < 4) return false;
  return a.startsWith(b.slice(0, n)) || b.startsWith(a.slice(0, n));
}

// Fraction of original query concepts matched in fieldText.
// Denominator = original token count; expansion never inflates it.
function _overlap(origToks, fieldText) {
  if (!fieldText || origToks.length === 0) return 0;
  const fieldToks = _tok(fieldText);
  if (fieldToks.length === 0) return 0;
  let hits = 0;
  for (const ot of origToks) {
    const group = _aliasMap.has(ot) ? [ot, ..._aliasMap.get(ot)] : [ot];
    let matched = false;
    outer: for (const qt of group) {
      for (const ft of fieldToks) {
        if (_stem(qt, ft)) { matched = true; break outer; }
      }
    }
    if (matched) hits++;
  }
  return hits / origToks.length;
}

// ── TargetSpec builder ────────────────────────────────────────────────────────

/**
 * Build a TargetSpec from intent classifier output + raw user message.
 * Generic — no site-specific patterns.
 *
 * @param {{ type: string, target: string }} intentClass
 * @param {string} message
 * @returns {TargetSpec}
 */
function buildTargetSpec(intentClass, message) {
  const type   = String(intentClass?.type   || 'unclear');
  const target = String(intentClass?.target || '').trim();

  let action             = 'find';
  let resourceType       = null;
  let requiresDownload   = false;
  let requiresNavigation = false;
  let extensions         = null;

  switch (type) {
    case 'find_document':
      action           = 'download';
      resourceType     = 'document';
      requiresDownload = true;
      extensions       = ['pdf', 'docx', 'doc', 'xls', 'xlsx', 'zip'];
      break;
    case 'open_page':
      action             = 'navigate';
      resourceType       = 'page';
      requiresNavigation = true;
      break;
    case 'complex_browser_task':
      action       = 'find';
      resourceType = null;
      break;
    default:
      break;
  }

  // intentClass.target is already stripped of most action filler by _extractTarget.
  // Fall back to raw message when target is absent.
  const targetDescription = _strip(target || message);

  return {
    action,
    resourceType,
    targetDescription,
    constraints: { extensions, mustHaveFilename: requiresDownload },
    requiresDownload,
    requiresNavigation,
  };
}

// ── Evidence scorer ───────────────────────────────────────────────────────────

function _scoreResource(origToks, resource) {
  // title_match: page or document container title
  const title_match  = _overlap(origToks, resource.title);

  // anchor_match: display text of the link (dl.text for documents)
  const anchor_match = _overlap(origToks, resource.anchorText);

  // filename_match: URL basename without extension, word-separated
  const filenameReadable = _strip(
    (resource.filename || '').replace(/\.[a-z0-9]+$/i, '').replace(/[-_.]+/g, ' '),
  );
  const filename_match = _overlap(origToks, filenameReadable);

  // nearby_match: headings, text blocks, URL slug — contextual metadata
  const nearbyField = [resource.headingText, resource.urlSlug, resource.nearbyText]
    .filter(Boolean).join(' ');
  const nearby_match = _overlap(origToks, nearbyField);

  return { title_match, anchor_match, filename_match, nearby_match };
}

// ── Resolver ──────────────────────────────────────────────────────────────────

/**
 * Resolve user intent (TargetSpec) against a set of Resource objects.
 * Returns a decision: "execute" | "clarify" | "no_match".
 *
 * @param {TargetSpec} spec
 * @param {Resource[]} resources
 * @returns {ResolverResult}
 */
function resolveResource(spec, resources) {
  const _empty = (reason) => ({
    resource: null, decision: 'no_match',
    evidence: null, activeSignals: [], ambiguity: false,
    reason, _score: 0, _allScored: [],
  });

  if (!resources || resources.length === 0) return _empty('no resources provided');

  const origToks = _tok(spec.targetDescription);
  if (origToks.length === 0) return _empty('target description yielded no scoreable tokens');

  // Deduplicate — same PDF can appear on multiple pages with different URL paths.
  // Dedup by URL first, then by lowercase filename (handles /doc/x.pdf vs /x.pdf).
  const _seenUrls   = new Set();
  const _seenFiles  = new Set();
  const uniqueResources = resources.filter((r) => {
    if (_seenUrls.has(r.url)) return false;
    _seenUrls.add(r.url);
    if (r.filename) {
      const fn = r.filename.toLowerCase();
      if (_seenFiles.has(fn)) return false;
      _seenFiles.add(fn);
    }
    return true;
  });

  const scored = uniqueResources.map((r) => {
    const ev = _scoreResource(origToks, r);

    // type_match: 1.0 exact, 0.5 unconstrained (null resourceType), 0.0 mismatch
    let type_match = 0.5;
    if (spec.resourceType !== null) {
      type_match = r.type === spec.resourceType ? 1.0 : 0.0;
    }

    // Small extension bonus — never penalizes.
    let extBonus = 0;
    if (spec.constraints.extensions && r.extension) {
      extBonus = spec.constraints.extensions.includes(r.extension) ? 0.05 : 0;
    }

    const textSignal = Math.max(ev.title_match, ev.anchor_match, ev.filename_match, ev.nearby_match);
    const score = textSignal * 0.80 + type_match * 0.20 + extBonus;

    return { resource: r, score, evidence: { ...ev, type_match } };
  }).sort((a, b) => b.score - a.score);

  const best   = scored[0];
  const second = scored[1];
  const top2Gap = second ? best.score - second.score : 1.0;

  let decision;
  let ambiguity = false;
  let reason;

  if (best.score >= 0.72) {
    if (top2Gap < 0.12 && second && second.score >= 0.60) {
      decision  = 'clarify';
      ambiguity = true;
      reason    = `two close matches (gap=${top2Gap.toFixed(2)}, best=${best.score.toFixed(2)})`;
    } else {
      decision = 'execute';
      reason   = `strong match score=${best.score.toFixed(2)}`;
    }
  } else if (best.score >= 0.50) {
    decision = 'clarify';
    reason   = `moderate match score=${best.score.toFixed(2)} — needs confirmation`;
  } else {
    decision = 'no_match';
    reason   = `best score=${best.score.toFixed(2)} below threshold`;
  }

  const activeSignals = Object.entries(best.evidence)
    .filter(([, v]) => v >= 0.30)
    .map(([k]) => k);

  return {
    resource:   best.resource,
    decision,
    evidence:   best.evidence,
    activeSignals,
    ambiguity,
    reason,
    _score:     best.score,
    _allScored: scored.map((s) => ({
      id:    s.resource.id,
      score: s.score,
      type:  s.resource.type,
      label: (s.resource.anchorText || s.resource.title || s.resource.filename).slice(0, 60),
    })),
  };
}

module.exports = { buildTargetSpec, resolveResource };
