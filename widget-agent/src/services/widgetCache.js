import { widgetStorage } from './widgetRuntime.js';
const MODE_KEY = 'atb_widget_mode';
const CONTACT_FACTS_KEY = 'atb_widget_contact_facts';
const DOCUMENT_INDEX_KEY = 'atb_widget_document_index';
const SITE_CONTEXT_KEY = 'atb_widget_site_context';

const CONTACT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DOC_INDEX_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const SITE_CONTEXT_TTL_MS = 5 * 60 * 1000;   // 5 minutes

const DEFAULT_CONTACT_FACTS = {
  headOffice: '9 Rue Hédi Nouira, 1001 Tunis',
  phoneStandard: '71 351 155',
  phoneCRC: '+216 70 026 267',
};

function _lsGet(key) {
  try {
    if (typeof window === 'undefined' || !widgetStorage()) return null;
    const raw = widgetStorage().getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function _lsSet(key, value) {
  try {
    if (typeof window === 'undefined' || !widgetStorage()) return;
    widgetStorage().setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota/security errors */
  }
}

function _lsRemove(key) {
  try {
    if (typeof window === 'undefined' || !widgetStorage()) return;
    widgetStorage().removeItem(key);
  } catch {
    /* ignore */
  }
}

// ── Mode ──────────────────────────────────────────────────────────────────────

export function getMode() {
  const stored = _lsGet(MODE_KEY);
  if (stored === 'ask' || stored === 'act') return stored;
  return 'ask';
}

export function setMode(mode) {
  _lsSet(MODE_KEY, mode === 'act' ? 'act' : 'ask');
}

// ── Contact facts ─────────────────────────────────────────────────────────────

export function saveContactFacts(facts) {
  _lsSet(CONTACT_FACTS_KEY, { facts, ts: Date.now() });
}

export function getContactFacts() {
  const entry = _lsGet(CONTACT_FACTS_KEY);
  if (!entry) {
    // Return defaults (static seed — public ATB facts)
    return { facts: DEFAULT_CONTACT_FACTS, ageMs: null, hit: false };
  }
  const ageMs = Date.now() - (entry.ts || 0);
  const expired = ageMs > CONTACT_TTL_MS;
  if (expired) {
    _lsRemove(CONTACT_FACTS_KEY);
    return { facts: DEFAULT_CONTACT_FACTS, ageMs: null, hit: false };
  }
  return { facts: entry.facts, ageMs, hit: true };
}

// ── Document index ────────────────────────────────────────────────────────────

export function saveDocumentIndex(index) {
  _lsSet(DOCUMENT_INDEX_KEY, { index, ts: Date.now() });
}

export function getDocumentIndex() {
  const entry = _lsGet(DOCUMENT_INDEX_KEY);
  if (!entry) return null;
  const ageMs = Date.now() - (entry.ts || 0);
  const expired = ageMs > DOC_INDEX_TTL_MS;
  if (expired) {
    _lsRemove(DOCUMENT_INDEX_KEY);
    return null;
  }
  return { index: entry.index, ageMs, hit: true };
}

// ── Cache context (sent with every request) ───────────────────────────────────

export function buildCacheContext() {
  const contact = getContactFacts();
  const docIndex = getDocumentIndex();
  return {
    contactHit: contact.hit,
    contactAge: contact.ageMs,
    docIndexHit: docIndex ? docIndex.hit : null,
    docIndexAge: docIndex ? docIndex.ageMs : null,
  };
}

// ── Site context ──────────────────────────────────────────────────────────────

export function saveSiteContext(ctx) {
  _lsSet(SITE_CONTEXT_KEY, { ctx, ts: Date.now() });
}

export function getSiteContext() {
  const entry = _lsGet(SITE_CONTEXT_KEY);
  if (!entry) return null;
  const ageMs = Date.now() - (entry.ts || 0);
  if (ageMs > SITE_CONTEXT_TTL_MS) {
    _lsRemove(SITE_CONTEXT_KEY);
    return null;
  }
  return { ctx: entry.ctx, ageMs, hit: true };
}

// ── Clear ─────────────────────────────────────────────────────────────────────

export function clearWidgetCache() {
  _lsRemove(MODE_KEY);
  _lsRemove(CONTACT_FACTS_KEY);
  _lsRemove(DOCUMENT_INDEX_KEY);
  _lsRemove(SITE_CONTEXT_KEY);
}
