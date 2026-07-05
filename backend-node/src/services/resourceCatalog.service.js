const fs = require('fs/promises');
const path = require('path');
const env = require('../config/env');
const { findAliasMatchesInCatalog, scoreAliasForTitle } = require('./resourceAlias.service');
const { logArchitecture } = require('./architectureLogger.service');
const { logAgentStep } = require('./agentLogger.service');

const RESOURCE_SERVER_BASE_URL = env.resourceServerBaseUrl;
const RESOURCE_JSON_BASE_URL = env.resourceJsonBaseUrl;
const RESOURCE_DOCUMENT_BASE_URL = env.resourceDocumentBaseUrl;
const JSON_RESOURCE_BASE_URL = `${RESOURCE_JSON_BASE_URL}/`;
const CATALOG_URL = env.resourceCatalogPath;
const MIN_MATCH_SCORE = 10;
const ALLOWED_CATALOG_FOLDERS = new Set(['documents', 'json', 'txt', 'images']);
const ALLOWED_CATALOG_EXTENSIONS = new Set(['.pdf', '.json', '.txt', '.png', '.jpg', '.jpeg']);
let catalogStartupLogged = false;
const debugResourceSearchLog = (...args) => {
  if (env.debugResourceSearch) {
    console.log(...args);
  }
};
const APPROVED_RESOURCE_MATCH_FIELDS = [
  'description',
  'exampleQueries',
  'title',
  'category',
  'intents',
];
const GENERIC_QUERY_TERMS = new Set([
  'receipt',
  'document',
  'form',
  'profile',
  'overview',
  'request',
  'status',
  'statement',
]);

class ResourceCatalogUnavailableError extends Error {
  constructor(message = 'Laragon resource catalog is unavailable') {
    super(message);
    this.name = 'ResourceCatalogUnavailableError';
    this.code = 'RESOURCE_SERVER_UNREACHABLE';
  }
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'can',
  'could',
  'do',
  'does',
  'for',
  'from',
  'get',
  'have',
  'how',
  'i',
  'in',
  'is',
  'me',
  'my',
  'of',
  'please',
  'read',
  'recommend',
  'recommends',
  'recommended',
  'show',
  'summarize',
  'summary',
  'the',
  'this',
  'to',
  'was',
  'with',
  'what',
  'when',
  'will',
  'you',
]);

const RESOURCE_TYPE_HINTS = {
  account_statement: ['statement', 'balance', 'movement', 'transactions', 'current', 'savings'],
  rib_certificate: ['rib', 'certificate'],
  loan_schedule: ['loan', 'payment', 'due', 'schedule'],
  loan_offer: ['loan', 'credit', 'financing', 'offer', 'student', 'student pack', 'education', 'young'],
  card_dispute: ['card', 'dispute', 'status'],
  card_pickup_appointment: ['card', 'pickup', 'appointment', 'status'],
  transfer_order: ['transfer', 'order', 'beneficiary', 'hiba'],
  account_certificate: ['ownership', 'certificate', 'account'],
  bill_notice: ['bill', 'invoice', 'payment', 'provider', 'sonede', 'steg', 'water', 'electricity', 'telecom', 'internet'],
  utility_bill: ['bill', 'invoice', 'provider', 'sonede', 'steg', 'water', 'electricity'],
  bill_payment: ['bill', 'payment', 'provider', 'reference', 'amount'],
  invoice: ['invoice', 'bill', 'reference', 'amount'],
  fees_notice: ['fees', 'fee', 'charges', 'june'],
  kyc_summary: ['customer', 'profile', 'kyc', 'summary'],
  customer_profile: ['customer', 'profile', 'kyc', 'summary'],
  account_profile: ['account', 'profile', 'details', 'information'],
  account_summary: ['account', 'summary', 'details', 'information'],
  appointment_confirmation: ['appointment', 'branch', 'confirmed', 'confirmation'],
  appointment_request: ['appointment', 'branch', 'date', 'time', 'request'],
  atm_receipt: ['atm', 'cash', 'withdrawal', 'receipt'],
  card_limit_notice: ['card', 'limit', 'notice'],
  card_service_request: ['debit', 'card', 'replacement', 'request', 'status'],
  complaint_document: ['complaint', 'claim', 'dispute', 'issue'],
  complaint_request: ['complaint', 'claim', 'dispute', 'issue'],
  digital_banking_guide: ['atb', 'connect', 'activate', 'activation', 'digital'],
  fx_receipt: ['foreign', 'currency', 'exchange', 'receipt'],
  international_transfer_request: ['international', 'transfer', 'request', 'france', 'beneficiary', 'amount', 'details', 'status'],
  payment_receipt: ['payment', 'receipt', 'bill'],
  product_sheet: ['product', 'sheet', 'package', 'pack', 'account', 'student', 'sme'],
  salary_certificate: ['salary', 'domiciliation', 'certificate'],
  security_notice: ['mobile', 'banking', 'security', 'notice'],
  standing_order: ['standing', 'order', 'rent', 'monthly'],
  tax_form: ['tax', 'residency', 'self', 'certification', 'form'],
  transfer_dispute: ['complaint', 'transfer', 'failed', 'dispute'],
  branch_directory: ['branch', 'branches', 'tunis', 'available'],
  branch_list: ['branch', 'branches', 'tunis', 'available'],
  atb_connect_guide: ['atb', 'connect', 'activate', 'activation', 'digital'],
  account_closure_request: ['account', 'closure', 'request', 'draft'],
  beneficiary_profile: ['beneficiary', 'profile', 'hiba', 'msallem'],
  insurance_policy: ['home', 'insurance', 'policy', 'summary'],
  checkbook_request: ['checkbook', 'chequebook', 'request', 'status'],
  cheque_book_request: ['checkbook', 'chequebook', 'request', 'status'],
};

const BILL_RESOURCE_TYPES = new Set([
  'bill',
  'bill_notice',
  'bill_payment',
  'bill_payment_notice',
  'bill_resource',
  'bill_invoice',
  'utility_bill',
  'utility_invoice',
  'invoice',
  'invoice_notice',
  'payment_request',
  'payment_notice',
  'payment_resource',
]);

const ACCOUNT_RESOURCE_TYPES = new Set([
  'account_statement',
  'account_certificate',
  'account_profile',
  'account_summary',
  'rib_certificate',
  'kyc_summary',
  'customer_profile',
]);

const COMPLAINT_RESOURCE_TYPES = new Set([
  'complaint_document',
  'complaint_request',
  'transfer_dispute',
  'card_dispute',
  'card_dispute_report',
]);

const BILL_PROVIDER_KEYWORDS = [
  'sonede',
  'steg',
  'internet',
  'telecom',
  'water',
  'electricity',
  'ooredoo',
  'orange',
];

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

// Fold accents (NFD) so accented catalog text tokenizes to the same ASCII tokens
// as a plain query ("crédit" → "credit"). No-op for pure-ASCII text.
const normalizeText = (value = '') =>
  String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeResourceType = (value = '') =>
  normalizeText(value).replace(/\s+/g, '_');

const tokenize = (value = '') =>
  normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));

// Whole-word containment: avoids "pick" matching "pickup" or "card" matching
// "discard". Used for precise title-anchor scoring.
const wholeWordIncludes = (text = '', token = '') => {
  if (!text || !token) return false;
  return new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text);
};

const SEARCH_QUERY_FILLERS = new Set([
  ...STOP_WORDS,
  'about',
  'answer',
  'ask',
  'can',
  'check',
  'could',
  'display',
  'fetch',
  'find',
  'give',
  'mine',
  'open',
  'question',
  'read',
  'retrieve',
  'tell',
  'view',
]);

const GENERIC_RESOURCE_QUERY_TERMS = new Set([
  ...GENERIC_QUERY_TERMS,
  'bill',
  'certificate',
  'detail',
  'details',
  'file',
  'guide',
  'image',
  'notice',
  'pdf',
  'policy',
  'read',
  'record',
  'request',
  'show',
  'status',
  'summary',
  // field-request words: asking for a field value shouldn't penalise image resources
  'amount',
  'balance',
  'billing',
  'date',
  'estimated',
  'include',
  'merchant',
  'number',
  'percentage',
  'progress',
  'recommendation',
  'saved',
  'scheduled',
  'target',
  'threshold',
  'time',
  'transaction',
  'wait',
]);

const normalizeResourceSearchQuery = (value = '') => {
  const text = normalizeText(value)
    .replace(/^(what|which)\s+(is|are|was|were)\s+/g, ' ')
    .replace(/^what\s+does\s+/g, ' ')
    .replace(/^what\s+do\s+/g, ' ')
    .replace(/^(show|get|find|open|summarize|view|display|fetch|download)\s+(me\s+)?/g, ' ')
    .replace(/\b(recommend|recommends|recommended|summary|summarize)\b/g, ' ');

  const tokens = text
    .split(/\s+/)
    // Keep pure-digit tokens (e.g. the "1" in "Lac 1") — branch/account identifiers matter.
    .filter((token) => (token.length >= 2 || /^\d+$/.test(token)) && !SEARCH_QUERY_FILLERS.has(token))
    .map((token) => {
      if (['payments', 'receipts', 'documents', 'statements', 'certificates', 'notices'].includes(token)) {
        return token.slice(0, -1);
      }
      return token;
    });

  return unique(tokens).join(' ').trim();
};

const unique = (values) => Array.from(new Set(values.filter(Boolean)));

const hasPhrase = (text = '', phrase = '') =>
  text.includes(normalizeText(phrase));

const isUnsupportedImageResourceQuery = () => false;

const ruleMatchesMessage = (rule, messageText = '') => {
  const text = normalizeText(messageText);
  const anyMatch = !rule.any?.length || rule.any.some((phrase) => hasPhrase(text, phrase));
  const allMatch = !rule.all?.length || rule.all.every((phrase) => hasPhrase(text, phrase));
  return anyMatch && allMatch;
};

const matchedSpecificResourceRules = (messageText = '') =>
  SPECIFIC_RESOURCE_RULES.filter((rule) => ruleMatchesMessage(rule, messageText));

const QUERY_SYNONYMS = {
  student: ['student', 'students', 'student pack', 'young', 'education'],
  students: ['student', 'students', 'student pack', 'young', 'education'],
  loan: ['loan', 'credit', 'financing', 'offer'],
  credit: ['credit', 'loan', 'financing', 'offer'],
  financing: ['financing', 'loan', 'credit', 'offer'],
  offer: ['offer', 'loan', 'credit', 'financing'],
  product: ['product', 'package', 'pack', 'sheet'],
  package: ['package', 'product', 'pack'],
  pack: ['pack', 'package', 'product'],
  sheet: ['sheet', 'product', 'package', 'pack'],
  rib: ['rib', 'certificate', 'bank details'],
  certificate: ['certificate', 'rib', 'bank details'],
  water: ['water', 'sonede', 'utility'],
  electricity: ['electricity', 'steg', 'utility'],
  telecom: ['telecom', 'telephone', 'internet'],
  phone: ['phone', 'telephone', 'hotline'],
  internet: ['internet', 'telecom', 'online'],
};

const RESOURCE_OPTION_TYPES = {
  'account statement': ['account_statement'],
  'rib certificate': ['rib_certificate'],
  receipt: ['payment_receipt', 'atm_receipt', 'fx_receipt'],
  appointment: ['appointment_confirmation', 'card_pickup_appointment'],
  complaint: ['complaint_document', 'complaint_request', 'transfer_dispute', 'card_dispute'],
  'branch directory': ['branch_directory', 'branch_list'],
};

const SPECIFIC_RESOURCE_RULES = [
  {
    type: 'customer_profile',
    any: ['customer profile overview', 'customer profile'],
    all: ['profile', 'overview'],
    exclude: ['payment_receipt', 'atm_receipt', 'fx_receipt'],
  },
  {
    type: 'digital_banking_guide',
    any: ['atb connect', 'connect activation', 'activation guide'],
  },
  {
    type: 'security_notice',
    any: ['mobile banking security notice'],
    all: ['mobile', 'banking', 'security'],
    exclude: ['card_limit_notice'],
  },
  {
    type: 'atm_receipt',
    any: ['atm cash withdrawal', 'atm withdrawal', 'cash withdrawal receipt'],
    exclude: ['fx_receipt', 'payment_receipt'],
  },
  {
    type: 'payment_receipt',
    any: ['steg bill payment receipt', 'bill payment receipt'],
    all: ['payment', 'receipt'],
    exclude: ['atm_receipt', 'fx_receipt'],
  },
  {
    type: 'tax_form',
    any: ['tax residency', 'self certification', 'self certification form'],
  },
  {
    type: 'salary_certificate',
    any: ['salary domiciliation', 'domiciliation certificate'],
  },
  {
    type: 'insurance_policy',
    any: ['home insurance', 'insurance policy', 'policy summary'],
  },
  {
    type: 'fx_receipt',
    any: ['foreign currency exchange', 'currency exchange receipt', 'foreign exchange receipt'],
    exclude: ['atm_receipt', 'payment_receipt'],
  },
  {
    type: 'account_closure_request',
    any: ['account closure', 'closure request', 'closure request draft'],
    exclude: ['customer_profile', 'account_profile', 'account_summary'],
  },
  {
    type: 'product_sheet',
    any: ['sme current account product sheet', 'student pack product sheet'],
  },
  {
    type: 'beneficiary_profile',
    any: ['beneficiary profile', 'hiba msallem', 'saved beneficiary'],
    exclude: ['customer_profile', 'international_transfer_request', 'transfer_order'],
  },
  {
    type: 'card_service_request',
    any: ['debit card replacement', 'card replacement request'],
    exclude: ['checkbook_request', 'cheque_book_request'],
  },
  {
    type: 'checkbook_request',
    any: ['checkbook request', 'chequebook request'],
    exclude: ['card_service_request'],
  },
  {
    type: 'card_dispute',
    any: ['online purchase dispute', 'card dispute'],
  },
  {
    type: 'appointment_confirmation',
    any: ['card pickup appointment', 'appointment confirmation', 'card pickup'],
    exclude: ['appointment_request', 'card_service_request'],
  },
  {
    type: 'international_transfer_request',
    any: ['international transfer request', 'transfer request to france'],
    all: ['transfer', 'france'],
    exclude: ['payment_receipt', 'atm_receipt', 'fx_receipt'],
  },
  {
    type: 'card_limit_notice',
    any: ['credit card limit', 'card limit'],
  },
  {
    type: 'standing_order',
    any: ['standing order', 'order for rent', 'monthly rent'],
  },
];

const isAppointmentBookingRequest = (messageText = '') => {
  const text = normalizeText(messageText);
  return (
    /\b(book|schedule|reserve)\b.{0,40}\b(appointment|meeting|visit|rendez vous)\b/.test(text) ||
    /\b(create|make)\b.{0,20}\b(an?\s+)?appointment\b/.test(text) ||
    /\b(appointment|meeting|visit|rendez vous)\b.{0,40}\b(book|scheduled|reserved)\b/.test(text)
  );
};

const isAppointmentLookupRequest = (messageText = '') => {
  const text = normalizeText(messageText);
  if (!text || isAppointmentBookingRequest(text)) return false;

  return (
    /\bdo i have\b.*\b(appointment|meeting|visit|rendez vous)\b/.test(text) ||
    /\b(appointment|meeting|visit|rendez vous)\b.*\b(status|confirmed|confirmation|existing)\b/.test(text) ||
    /\b(status|confirmed|confirmation|existing)\b.*\b(appointment|meeting|visit|rendez vous)\b/.test(text) ||
    (text.includes('card pickup') && text.includes('appointment')) ||
    (text.includes('branch appointment') && (text.includes('confirmed') || text.includes('have')))
  );
};

const expandQueryParts = (messageText = '') => {
  const tokens = tokenize(messageText);
  const parts = [...tokens];

  for (const token of tokens) {
    parts.push(...(QUERY_SYNONYMS[token] || []));
    if (token.endsWith('s') && token.length > 3) {
      parts.push(token.slice(0, -1));
    }
  }

  const text = normalizeText(messageText);
  if (text.includes('student pack')) parts.push('student', 'students', 'young', 'education');
  if (text.includes('product sheet')) parts.push('product', 'package', 'pack', 'sheet');
  if (text.includes('rib certificate')) parts.push('rib', 'certificate', 'bank details');

  return unique(parts.flatMap((part) => tokenize(part)));
};

const isSafeCatalogPathPart = (value = '') => {
  const text = String(value || '').trim();
  if (!text) return false;
  if (text.includes('..') || text.includes('/') || text.includes('\\')) return false;
  if (path.isAbsolute(text)) return false;
  return true;
};

const normalizeCatalogFileType = (file = {}) => {
  const explicit = normalizeText(file.fileType || '');
  if (['pdf', 'json', 'txt', 'image'].includes(explicit)) return explicit;
  const ext = path.extname(file.fileName || '').toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.json') return 'json';
  if (ext === '.txt') return 'txt';
  if (['.png', '.jpg', '.jpeg'].includes(ext)) return 'image';
  return explicit || 'unknown';
};

const buildCatalogFileUrl = (folder, fileName) => {
  if (!folder || !fileName) return null;
  if (!ALLOWED_CATALOG_FOLDERS.has(folder)) return null;
  if (!isSafeCatalogPathPart(folder) || !isSafeCatalogPathPart(fileName)) return null;
  const ext = path.extname(fileName).toLowerCase();
  if (!ALLOWED_CATALOG_EXTENSIONS.has(ext)) return null;
  return `${RESOURCE_SERVER_BASE_URL}/${folder}/${fileName}`;
};

const withCatalogFileUrl = (file = {}) => {
  const fileType = normalizeCatalogFileType(file);
  const fileUrl = buildCatalogFileUrl(file.folder, file.fileName);
  if (!fileUrl) return null;
  return {
    ...file,
    fileType,
    fileUrl,
  };
};

const isImageIntent = (messageText = '', route = '') => {
  const text = normalizeText(messageText);
  return (
    route === 'image' ||
    /\b(qr|image|img|photo|picture|screenshot|scan|scanned|visual|png|jpg|jpeg)\b/.test(text)
  );
};

const isDocumentRetrievalIntent = (messageText = '') => {
  const text = normalizeText(messageText);
  if (!text) return false;
  const hasRetrievalVerb = /\b(show|open|view|display|download|get|give|fetch|retrieve|send|provide|share)\b/.test(text);
  const hasDocumentNoun = /\b(pdf|document|file|form|guide|sheet|policy|notice|certificate|statement|receipt|image)\b/.test(text);
  const hasContentQuestion = /\b(read|extract|summarize|summary|what|when|which|how much|details?|recommend|contain|say|happened)\b/.test(text);
  return hasRetrievalVerb && hasDocumentNoun && !hasContentQuestion;
};

const selectCatalogFile = (files = [], { messageText = '', route = 'text' } = {}) => {
  const safeFiles = files.map(withCatalogFileUrl).filter(Boolean);
  if (!safeFiles.length) return null;

  const byType = (type) => safeFiles.find((file) => file.fileType === type);
  if (isImageIntent(messageText, route)) {
    return byType('image') || safeFiles[0];
  }

  if (isDocumentRetrievalIntent(messageText)) {
    return byType('pdf') || byType('json') || byType('txt') || safeFiles[0];
  }

  // Natural QA (which/where/when/status/hours/payment/amount): honor the catalog's `preferredFor`
  // hint so the structured sibling (preferredFor includes "qa"/"field_extraction") is used for
  // answering, never the view/download PDF. This keeps deterministic builders fed with parsed JSON.
  const qaPreferred = safeFiles.find(
    (file) =>
      Array.isArray(file.preferredFor) &&
      file.preferredFor.some((hint) => ['qa', 'field_extraction'].includes(normalizeText(hint))),
  );
  if (qaPreferred) return qaPreferred;

  for (const type of ['json', 'txt', 'pdf']) {
    const found = byType(type);
    if (found) return found;
  }
  return safeFiles[0];
};

const selectPrimaryCatalogFile = (files = []) => {
  const safeFiles = files.map(withCatalogFileUrl).filter(Boolean);
  if (!safeFiles.length) return null;
  for (const type of ['json', 'txt', 'pdf', 'image']) {
    const found = safeFiles.find((file) => file.fileType === type);
    if (found) return found;
  }
  return safeFiles[0];
};

const normalizeCatalogPolicies = (catalogJson = {}) => ({
  catalogVersion: catalogJson.catalogVersion || null,
  generatedAt: catalogJson.generatedAt || null,
  name: catalogJson.name || null,
  description: catalogJson.description || null,
  environment: catalogJson.environment || null,
  resourceBaseUrlEnv: catalogJson.resourceBaseUrlEnv || null,
  supportedLanguages: Array.isArray(catalogJson.supportedLanguages)
    ? catalogJson.supportedLanguages
    : [],
  selectionPolicy: catalogJson.selectionPolicy || {},
  routingPolicy: catalogJson.routingPolicy || {},
});

const normalizeResourceRelatedActions = (resource = {}) =>
  Array.isArray(resource.relatedActions)
    ? resource.relatedActions
    : [];

const inferCatalogResourceFileType = (files = []) => {
  const safeFiles = files.map(withCatalogFileUrl).filter(Boolean);
  if (safeFiles.some((file) => file.fileType === 'image')) return 'image';
  if (safeFiles.some((file) => file.fileType === 'json')) return 'json';
  if (safeFiles.some((file) => file.fileType === 'txt')) return 'txt';
  if (safeFiles.some((file) => file.fileType === 'pdf')) return 'pdf';
  return safeFiles[0]?.fileType || 'json';
};

const inferCatalogResourceType = (resource = {}, resourceFileType = 'json') => {
  if (resource.type) return normalizeResourceType(resource.type);
  const text = normalizeText([
    resource.id,
    resource.title,
    resource.category,
    resource.description,
  ].filter(Boolean).join(' '));
  for (const type of Object.keys(RESOURCE_TYPE_HINTS)) {
    const normalizedType = normalizeText(type);
    if (text.includes(normalizedType)) {
      return type;
    }
  }
  if (/\batm\b.*\b(withdrawal|receipt)\b|\bcash withdrawal receipt\b/.test(text)) return 'atm_receipt';
  if (/\bsalary\b.*\b(domiciliation|certificate)\b/.test(text)) return 'salary_certificate';
  if (/\bstanding order\b/.test(text)) return 'standing_order';
  if (/\b(sonede|steg|telecom|utility|water|electricity)\b.*\bbill\b/.test(text)) return 'bill_payment';
  if (/\bqr\b.*\b(payment|receipt|merchant)\b/.test(text)) return 'payment_receipt';
  if (/\b(student pack|sme).*product sheet\b|\bproduct sheet\b/.test(text)) return 'product_sheet';
  for (const [type, hints] of Object.entries(RESOURCE_TYPE_HINTS)) {
    const matches = hints
      .map((hint) => normalizeText(hint))
      .filter((hint) => hint && text.includes(hint));
    const strongMatches = matches.filter((hint) => hint.includes(' '));
    if (matches.length >= 2 || strongMatches.length >= 1) return type;
  }
  if (resource.category) return normalizeResourceType(resource.category);
  return resourceFileType === 'image' ? 'image_resource' : `${resourceFileType}_resource`;
};

const semanticCatalogMetadata = (resource = {}, catalogPolicies = {}) => ({
  catalogVersion: catalogPolicies.catalogVersion,
  generatedAt: catalogPolicies.generatedAt,
  catalogName: catalogPolicies.name,
  catalogDescription: catalogPolicies.description,
  environment: catalogPolicies.environment,
  resourceBaseUrlEnv: catalogPolicies.resourceBaseUrlEnv,
  supportedLanguages: catalogPolicies.supportedLanguages,
  selectionPolicy: catalogPolicies.selectionPolicy,
  routingPolicy: catalogPolicies.routingPolicy,
  resourceId: resource.id,
  id: resource.id,
  title: resource.title,
  category: resource.category,
  type: resource.type,
  description: resource.description,
  exampleQueries: Array.isArray(resource.exampleQueries) ? resource.exampleQueries : [],
  intents: Array.isArray(resource.intents) ? resource.intents : [],
  relatedActions: normalizeResourceRelatedActions(resource),
  keyFields: resource.keyFields && typeof resource.keyFields === 'object'
    ? resource.keyFields
    : {},
});

const normalizeGlobalCatalogResources = (catalogJson = {}) => {
  if (!Array.isArray(catalogJson?.resources)) return [];
  const catalogPolicies = normalizeCatalogPolicies(catalogJson);

  return catalogJson.resources.map((resource) => {
    // Minimal description-only schema: id, title, description, files are the only
    // required fields. Everything else (category, type, exampleQueries, intents,
    // keyFields, relatedActions) is optional and absent in the v4.x catalog.
    const hasRequiredFields =
      resource &&
      typeof resource.id === 'string' && resource.id.trim() &&
      typeof resource.title === 'string' && resource.title.trim() &&
      typeof resource.description === 'string' && resource.description.trim() &&
      Array.isArray(resource.files) && resource.files.length > 0;
    if (!hasRequiredFields) {
      debugResourceSearchLog('[resource-catalog] skipped invalid resource entry:', {
        id: resource?.id || null,
        reason: 'missing required field (id/title/description/files)',
      });
      return null;
    }

    const files = Array.isArray(resource.files)
      ? resource.files.map(withCatalogFileUrl).filter(Boolean)
      : [];
    const primaryFile = selectPrimaryCatalogFile(files);
    if (!primaryFile) return null;

    const resourceFileType = inferCatalogResourceFileType(files);
    const resourceType = inferCatalogResourceType(resource, resourceFileType);
    const metadata = semanticCatalogMetadata(resource, catalogPolicies);

    return {
      fileName: primaryFile.fileName,
      url: null,
      metadata: {
        ...metadata,
        files,
        resourceFileType,
        fileUrl: primaryFile.fileUrl,
        mimeType: primaryFile.mimeType,
        resourceType,
      },
    };
  }).filter(Boolean);
};

// In-memory cache of the parsed + normalized catalog, keyed on the file's mtime so an edit to
// catalog.json is picked up automatically (the file is re-read only when it actually changes).
let catalogCache = null; // { mtimeMs, catalog }

const loadConfiguredGlobalCatalog = async () => {
  const catalogPath = path.resolve(env.resourceCatalogPath);

  let mtimeMs = null;
  try {
    mtimeMs = (await fs.stat(catalogPath)).mtimeMs;
  } catch {
    mtimeMs = null;
  }
  if (catalogCache && mtimeMs !== null && catalogCache.mtimeMs === mtimeMs) {
    debugResourceSearchLog('[resource-catalog] served catalog from in-memory cache');
    return catalogCache.catalog;
  }

  let catalogJson;
  try {
    const raw = await fs.readFile(catalogPath, 'utf8');
    catalogJson = JSON.parse(raw);
  } catch (error) {
    throw new ResourceCatalogUnavailableError(
      `Unable to read Laragon resource catalog at ${catalogPath}: ${error.message}`,
    );
  }

  if (!Array.isArray(catalogJson?.resources)) {
    throw new ResourceCatalogUnavailableError(
      `Invalid Laragon resource catalog at ${catalogPath}: expected a resources array.`,
    );
  }
  const catalog = normalizeGlobalCatalogResources(catalogJson);
  catalogCache = { mtimeMs, catalog };
  if (!catalogStartupLogged) {
    console.log('[resource-catalog] startup:', {
      catalogPath,
      catalogVersion: catalogJson.catalogVersion || null,
      resourceCount: catalog.length,
      resourceBaseUrl: RESOURCE_SERVER_BASE_URL,
    });
    catalogStartupLogged = true;
  }
  return catalog;
};

const isResourceMetadata = (metadata) =>
  Boolean(
    metadata &&
      typeof metadata === 'object' &&
      (
        metadata.resourceType ||
        metadata.title ||
        metadata.fileUrl ||
        metadata.documentUrl ||
        metadata.url
      ),
  );

const loadResourceCatalog = async ({ catalog: catalogOverride = null } = {}) => {
  if (Array.isArray(catalogOverride)) {
    const entries = catalogOverride.some((entry) => entry?.metadata)
      ? catalogOverride
      : normalizeGlobalCatalogResources({ resources: catalogOverride });
    return entries.filter((entry) => isResourceMetadata(entry.metadata));
  }

  if (catalogOverride && typeof catalogOverride === 'object' && Array.isArray(catalogOverride.resources)) {
    return normalizeGlobalCatalogResources(catalogOverride)
      .filter((entry) => isResourceMetadata(entry.metadata));
  }

  debugResourceSearchLog('[resource-catalog] loading configured Laragon catalog');

  let catalog;
  try {
    catalog = await loadConfiguredGlobalCatalog();
  } catch (error) {
    if (error instanceof ResourceCatalogUnavailableError) throw error;
    throw new ResourceCatalogUnavailableError(error.message);
  }

  if (!catalog.length) {
    throw new ResourceCatalogUnavailableError(
      `Laragon resource catalog at ${env.resourceCatalogPath} contains no usable resources.`,
    );
  }

  const resourceCatalog = catalog.filter((entry) => isResourceMetadata(entry.metadata));
  debugResourceSearchLog('[resource-catalog] resources loaded count:', resourceCatalog.length);
  return resourceCatalog;
};

const flattenSearchParts = (value, parts = []) => {
  if (value === null || value === undefined) {
    return parts;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => flattenSearchParts(item, parts));
    return parts;
  }

  if (typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      parts.push(key);
      flattenSearchParts(item, parts);
    });
    return parts;
  }

  parts.push(String(value));
  return parts;
};

const semanticMetadataText = (metadata = {}) =>
  normalizeText([
    fieldText(metadata, APPROVED_RESOURCE_MATCH_FIELDS),
    ...flattenSearchParts(metadata.exampleQueries || []),
    ...flattenSearchParts(metadata.intents || []),
  ].join(' '));

const metadataText = (entry) => semanticMetadataText(entry.metadata || {});

const detectRequestedResourceTypes = (messageText) => {
  const text = normalizeText(messageText);
  const requested = [];
  const hasBillProvider = BILL_PROVIDER_KEYWORDS.some((keyword) => text.includes(keyword));
  const accountDetailsRequested =
    /\baccounts?\b.*\b(details?|information|info|summary|status)\b/.test(text) ||
    /\b(details?|information|info|summary|status)\b.*\baccounts?\b/.test(text) ||
    /\b(show|view|give|get|display|list)\b.*\bmy accounts?\b/.test(text) ||
    /\b(show|view|give|get|display|list)\b.*\baccounts?\b/.test(text);

  if (RESOURCE_OPTION_TYPES[text]) {
    requested.push(...RESOURCE_OPTION_TYPES[text]);
  }

  if (text.includes('account statement') || text.includes('statement') || text.includes('closing balance') || text.includes('balance movement')) {
    requested.push('account_statement');
  }
  if (
    text.includes('rib') ||
    text.includes('bank details') ||
    (text.includes('certificate') && text.includes('bank'))
  ) {
    requested.push('rib_certificate');
  }
  if (accountDetailsRequested) {
    requested.push(
      'account_statement',
      'account_certificate',
      'account_profile',
      'account_summary',
      'rib_certificate',
      'kyc_summary',
      'customer_profile',
    );
  }
  if (
    text.includes('loan offer') ||
    text.includes('student loan') ||
    (text.includes('loan') && text.includes('student')) ||
    (text.includes('credit') && text.includes('student')) ||
    (text.includes('financing') && text.includes('student'))
  ) {
    requested.push('loan_offer');
  }
  if (text.includes('loan')) requested.push('loan_schedule');
  if (
    text.includes('product sheet') ||
    (text.includes('product') && text.includes('sheet')) ||
    (text.includes('student pack') && text.includes('sheet')) ||
    (text.includes('sme') && text.includes('sheet'))
  ) {
    requested.push('product_sheet');
  }
  if (
    (text.includes('card') && text.includes('limit')) ||
    text.includes('available card limit') ||
    text.includes('card payment due') ||
    text.includes('card payment due date') ||
    text.includes('card notice') ||
    (text.includes('card') && text.includes('minimum payment')) ||
    (text.includes('card') && text.includes('payment due'))
  ) {
    requested.push('card_limit_notice');
  }
  if (text.includes('standing order') || (text.includes('order') && text.includes('rent'))) {
    requested.push('standing_order');
  }
  if (text.includes('dispute') || (text.includes('card') && text.includes('status'))) {
    requested.push('card_dispute');
  }
  if (
    text.includes('card service') ||
    text.includes('card replacement') ||
    (text.includes('debit') && text.includes('replacement')) ||
    (text.includes('card') && text.includes('replacement'))
  ) {
    requested.push('card_service_request');
  }
  if (
    text.includes('atm') ||
    (text.includes('withdrawal') && text.includes('receipt'))
  ) {
    requested.push('atm_receipt');
  }
  if (
    text.includes('foreign currency') ||
    text.includes('currency exchange') ||
    text.includes('foreign exchange') ||
    /\bfx\b/.test(text) ||
    (text.includes('exchange') && text.includes('receipt'))
  ) {
    requested.push('fx_receipt');
  }
  if (
    text.includes('tax') ||
    text.includes('self certification') ||
    text.includes('self-certification') ||
    (text.includes('residency') && text.includes('form'))
  ) {
    requested.push('tax_form');
  }
  if (text.includes('salary') || text.includes('domiciliation')) {
    requested.push('salary_certificate');
  }
  if (text.includes('insurance') || text.includes('home policy') || text.includes('home insurance')) {
    requested.push('insurance_policy');
  }
  if (text.includes('account closure') || (text.includes('closure') && text.includes('request'))) {
    requested.push('account_closure_request');
  }
  if (
    text.includes('beneficiary profile') ||
    text.includes('saved beneficiary') ||
    text.includes('hiba msallem')
  ) {
    requested.push('beneficiary_profile');
  }
  if (text.includes('receipt')) {
    requested.push('payment_receipt', 'atm_receipt', 'fx_receipt');
  }
  if (text.includes('transfer') && (text.includes('order') || text.includes('hiba'))) {
    requested.push('transfer_order');
  }
  if (
    text.includes('international transfer') ||
    (text.includes('transfer') && text.includes('request')) ||
    (text.includes('transfer') && text.includes('france'))
  ) {
    requested.push('international_transfer_request', 'transfer_order');
  }
  if (
    /\bbill\b/.test(text) ||
    text.includes('invoice') ||
    (text.includes('pay') && hasBillProvider) ||
    hasBillProvider
  ) {
    requested.push('bill_notice');
  }
  if (text.includes('fee') || text.includes('fees') || text.includes('charges')) {
    requested.push('fees_notice');
  }
  if (text.includes('customer profile')) requested.push('customer_profile');
  if (text.includes('profile') || text.includes('kyc')) requested.push('kyc_summary');
  if (text.includes('mobile banking security') || (text.includes('security') && text.includes('notice'))) {
    requested.push('security_notice');
  }
  if (text.includes('atb connect') || (text.includes('connect') && text.includes('activate'))) {
    requested.push('atb_connect_guide', 'digital_banking_guide');
  }
  if (text.includes('branch') || text.includes('branches')) {
    requested.push('branch_directory', 'branch_list');
  }
  if (text.includes('checkbook') || text.includes('chequebook')) {
    requested.push('checkbook_request', 'cheque_book_request');
  }
  if (text.includes('card') && text.includes('pickup')) {
    requested.push('appointment_confirmation', 'card_pickup_appointment');
  }
  if (text.includes('appointment') || (text.includes('branch') && text.includes('confirmed'))) {
    requested.push('appointment_confirmation');
    if (isAppointmentBookingRequest(text)) {
      requested.push('appointment_request');
    }
  }
  if (text.includes('ownership certificate')) requested.push('account_certificate');
  if (text.includes('complaint') || text.includes('claim') || text.includes('reclamation')) {
    requested.push('complaint_document', 'complaint_request');
    if (text.includes('transfer') || text.includes('failed')) {
      requested.push('transfer_dispute');
    }
    if (text.includes('card') || text.includes('dispute')) {
      requested.push('card_dispute');
    }
  }

  return unique(requested);
};

const isBillResourceType = (resourceType = '') =>
  BILL_RESOURCE_TYPES.has(normalizeResourceType(resourceType));

const isAccountResourceType = (resourceType = '') =>
  ACCOUNT_RESOURCE_TYPES.has(normalizeResourceType(resourceType));

const isComplaintResourceType = (resourceType = '') =>
  COMPLAINT_RESOURCE_TYPES.has(normalizeResourceType(resourceType));

const scoreEntry = (entry, messageText) => {
  const queryTokens = expandQueryParts(messageText);
  const entryText = metadataText(entry);
  const entryTokens = new Set(tokenize(entryText));
  const resourceType = normalizeResourceType(entry.metadata?.resourceType);
  const requestedTypes = detectRequestedResourceTypes(messageText);
  const specificRules = matchedSpecificResourceRules(messageText);
  const aliasMatch = scoreAliasForTitle(messageText, entry.metadata?.title || '');
  let score = 0;

  if (aliasMatch.score > 0) {
    score += aliasMatch.score;
  }

  score += businessIdentifierOverlapScore(messageText, entry.metadata || {});

  for (const token of queryTokens) {
    const tokenWeight = GENERIC_QUERY_TERMS.has(token) ? 0.5 : 2;
    if (entryTokens.has(token)) score += tokenWeight;
    else if (entryText.includes(token)) score += GENERIC_QUERY_TERMS.has(token) ? 0.25 : 1;
  }

  if (requestedTypes.includes(resourceType)) score += 12;

  for (const rule of specificRules) {
    if (resourceType === normalizeResourceType(rule.type)) {
      score += rule.boost || 34;
    } else if ((rule.exclude || []).map(normalizeResourceType).includes(resourceType)) {
      score -= rule.penalty || 36;
    }
  }

  const receiptRequested = requestedTypes.some((type) =>
    ['payment_receipt', 'atm_receipt', 'fx_receipt'].includes(type),
  );
  const billRequested = requestedTypes.includes('bill_notice') && !receiptRequested;
  if (billRequested) {
    if (isBillResourceType(resourceType)) {
      score += 8;
    } else {
      score -= 100;
    }
  }

  const accountRequested = requestedTypes.some((type) =>
    ACCOUNT_RESOURCE_TYPES.has(type),
  );
  if (accountRequested && isAccountResourceType(resourceType)) {
    score += 5;
  }

  const complaintRequested = requestedTypes.some((type) =>
    COMPLAINT_RESOURCE_TYPES.has(type),
  );
  if (complaintRequested && isComplaintResourceType(resourceType)) {
    score += 5;
  }

  const normalizedMessage = normalizeText(messageText);

  // Strong title-phrase boost for image resources: thin metadata shouldn't compete on tokens alone.
  const isImageEntry = /\bimage\b/.test(normalizeText(
    entry.metadata?.mimeType || entry.metadata?.contentType || ''
  )) || resourceType === 'image_test_resource';
  if (isImageEntry) {
    const entryTitle = normalizeText(entry.metadata?.title || '');
    if (entryTitle && normalizedMessage.includes(entryTitle)) {
      score += 50;
    }
  }

  const appointmentLookupRequested = isAppointmentLookupRequest(normalizedMessage);
  const fxRequested =
    normalizedMessage.includes('foreign currency') ||
    normalizedMessage.includes('currency exchange') ||
    normalizedMessage.includes('foreign exchange') ||
    /\bfx\b/.test(normalizedMessage) ||
    (normalizedMessage.includes('exchange') && normalizedMessage.includes('receipt'));
  const atmRequested =
    normalizedMessage.includes('atm') ||
    normalizedMessage.includes('cash withdrawal') ||
    (normalizedMessage.includes('withdrawal') && normalizedMessage.includes('receipt'));
  const transferRequestRequested =
    normalizedMessage.includes('transfer request') ||
    normalizedMessage.includes('international transfer');
  const customerProfileRequested =
    normalizedMessage.includes('customer profile') ||
    (normalizedMessage.includes('profile') && normalizedMessage.includes('overview'));
  const accountClosureRequested =
    normalizedMessage.includes('account closure') ||
    (normalizedMessage.includes('closure') && normalizedMessage.includes('request'));
  const checkbookRequested =
    normalizedMessage.includes('checkbook') ||
    normalizedMessage.includes('chequebook');
  const cardReplacementRequested =
    normalizedMessage.includes('card replacement') ||
    (normalizedMessage.includes('debit') && normalizedMessage.includes('replacement'));
  const beneficiaryProfileRequested =
    normalizedMessage.includes('beneficiary profile') ||
    normalizedMessage.includes('saved beneficiary') ||
    normalizedMessage.includes('hiba msallem');

  if (fxRequested) {
    if (resourceType === 'fx_receipt') score += 24;
    if (resourceType === 'atm_receipt' || resourceType === 'payment_receipt') score -= 30;
  }

  if (atmRequested) {
    if (resourceType === 'atm_receipt') score += 24;
    if (resourceType === 'fx_receipt') score -= 30;
  }

  if (transferRequestRequested) {
    if (resourceType === 'international_transfer_request' || resourceType === 'transfer_order') score += 18;
    if (resourceType.includes('receipt')) score -= 30;
  }

  if (customerProfileRequested) {
    if (resourceType === 'customer_profile') score += 24;
    if (resourceType.includes('receipt')) score -= 30;
  }

  if (accountClosureRequested) {
    if (resourceType === 'account_closure_request') score += 30;
    if (['customer_profile', 'account_profile', 'account_summary'].includes(resourceType)) {
      score -= 34;
    }
  }

  if (checkbookRequested) {
    if (resourceType === 'checkbook_request' || resourceType === 'cheque_book_request') score += 24;
    if (resourceType === 'card_service_request') score -= 30;
  }

  if (cardReplacementRequested) {
    if (resourceType === 'card_service_request') score += 24;
    if (resourceType === 'checkbook_request' || resourceType === 'cheque_book_request') score -= 30;
  }

  if (beneficiaryProfileRequested) {
    if (resourceType === 'beneficiary_profile') score += 30;
    if (['customer_profile', 'international_transfer_request', 'transfer_order'].includes(resourceType)) {
      score -= 24;
    }
  }

  if (appointmentLookupRequested) {
    if (resourceType === 'appointment_confirmation') score += 10;
    if (resourceType === 'card_pickup_appointment') score += 8;
    if (resourceType === 'appointment_request') score -= 100;
  }

  if (
    normalizedMessage.includes('card pickup') &&
    normalizedMessage.includes('appointment') &&
    (
      normalizedMessage.includes('related to card pickup') ||
      normalizedMessage.includes('card pickup appointment') ||
      normalizedMessage.includes('appointment resource') ||
      normalizedMessage.includes('do i have')
    )
    && !normalizedMessage.includes('card debit card credit card')
  ) {
    if (resourceType === 'appointment_confirmation' && entryText.includes('card pickup')) {
      score += 30;
    } else if (resourceType === 'card_pickup_appointment') {
      score += 30;
    } else if (resourceType.includes('card')) {
      score -= 40;
    }
  }

  for (const hint of RESOURCE_TYPE_HINTS[resourceType] || []) {
    const normalizedHint = normalizeText(hint);
    if (queryTokens.includes(normalizedHint) || normalizedMessage.includes(normalizedHint)) {
      score += 1;
    }
  }

  if (billRequested && isBillResourceType(resourceType)) {
    for (const provider of BILL_PROVIDER_KEYWORDS) {
      if (normalizeText(messageText).includes(provider)) {
        score += entryText.includes(provider) ? 5 : -2;
      }
    }
  }

  if (receiptRequested) {
    for (const provider of BILL_PROVIDER_KEYWORDS) {
      if (!normalizedMessage.includes(provider)) continue;
      if (resourceType === 'payment_receipt') {
        score += entryText.includes(provider) ? 12 : -8;
      } else if (['atm_receipt', 'fx_receipt'].includes(resourceType)) {
        score -= 10;
      }
    }
  }

  for (const month of MONTHS) {
    if (normalizedMessage.includes(month)) {
      score += entryText.includes(month) ? 4 : -2;
    }
  }

  if (normalizedMessage.includes('current') && entryText.includes('current')) score += 4;
  if (normalizedMessage.includes('savings') && entryText.includes('savings')) score += 4;
  if (normalizedMessage.includes('hiba') && entryText.includes('hiba')) score += 5;
  if (normalizedMessage.includes('confirmed') && entryText.includes('confirmed')) score += 3;
  if (normalizedMessage.includes('tunis') && entryText.includes('tunis')) score += 4;
  if (normalizedMessage.includes('checkbook') && entryText.includes('checkbook')) score += 5;
  if (normalizedMessage.includes('chequebook') && entryText.includes('chequebook')) score += 5;
  if (normalizedMessage.includes('pickup') && entryText.includes('pickup')) score += 4;
  if (normalizedMessage.includes('atb connect') && entryText.includes('atb connect')) score += 6;
  if (normalizedMessage.includes('debit') && entryText.includes('debit')) score += 3;
  if (normalizedMessage.includes('replacement') && entryText.includes('replacement')) score += 4;
  if (normalizedMessage.includes('receipt') && entryText.includes('receipt')) score += 4;
  if (normalizedMessage.includes('atm') && entryText.includes('atm')) score += 5;
  if (normalizedMessage.includes('tax') && entryText.includes('tax')) score += 4;
  if (normalizedMessage.includes('self certification') && entryText.includes('self certification')) score += 5;
  if (normalizedMessage.includes('self-certification') && entryText.includes('self certification')) score += 5;
  if (normalizedMessage.includes('student') && entryText.includes('student')) score += 5;
  if (normalizedMessage.includes('students') && entryText.includes('student')) score += 5;
  if (normalizedMessage.includes('student pack') && entryText.includes('student pack')) score += 6;
  if (normalizedMessage.includes('loan offer') && resourceType === 'loan_offer') score += 6;
  if (normalizedMessage.includes('loan') && resourceType === 'loan_offer' && entryText.includes('offer')) score += 4;
  if (normalizedMessage.includes('credit') && resourceType === 'loan_offer') score += 3;
  if (normalizedMessage.includes('financing') && resourceType === 'loan_offer') score += 3;
  if (normalizedMessage.includes('product sheet') && resourceType === 'product_sheet') score += 6;
  if (normalizedMessage.includes('sme') && entryText.includes('sme')) score += 6;
  if (normalizedMessage.includes('rib certificate') && resourceType === 'rib_certificate') score += 6;

  return score;
};

const matchedTokensForEntry = (entry, messageText) => {
  const entryText = metadataText(entry);
  return unique(tokenize(messageText).filter((token) => entryText.includes(token)));
};

const summarizeMatchedEntry = (entry, messageText) => ({
  fileName: entry.fileName,
  url: entry.url,
  score: entry.score,
  matchedTokens: matchedTokensForEntry(entry, messageText),
  title: entry.metadata?.title,
  resourceType: entry.metadata?.resourceType,
  service: entry.metadata?.service,
  provider: entry.metadata?.provider,
  fileUrl: entry.metadata?.fileUrl || entry.metadata?.url,
});

const safeResourceId = (entry = {}) =>
  entry.metadata?.resourceId ||
  entry.fileName ||
  'unknown_resource';

const scoreCatalogEntries = (catalog, messageText, options = {}) => {
  const allowedResourceTypes = Array.isArray(options.allowedResourceTypes)
    ? new Set(options.allowedResourceTypes.map(normalizeResourceType))
    : null;
  const excludedResourceTypes = Array.isArray(options.excludedResourceTypes)
    ? new Set(options.excludedResourceTypes.map(normalizeResourceType))
    : new Set();

  const scored = catalog
    .filter((entry) => {
      const resourceType = normalizeResourceType(entry.metadata?.resourceType);
      if (allowedResourceTypes && !allowedResourceTypes.has(resourceType)) return false;
      if (excludedResourceTypes.has(resourceType)) return false;
      return true;
    })
    .map((entry) => ({
      ...entry,
      score: scoreEntry(entry, messageText),
    }))
    .sort((a, b) => b.score - a.score);

  if (env.debugResourceSearch) {
    scored.slice(0, 6).forEach((entry) => {
      const resourceType = normalizeResourceType(entry.metadata?.resourceType);
      const matchedTokens = matchedTokensForEntry(entry, messageText);
      console.log('[resource-catalog] candidate:', {
        title: entry.metadata?.title || entry.fileName,
        type: resourceType,
        score: entry.score,
        matchedTerms: matchedTokens,
      });
    });
  }

  return scored;
};

const fieldText = (metadata = {}, keys = []) =>
  keys
    .map((key) => metadata?.[key])
    .filter((value) => value !== null && value !== undefined)
    .flatMap((value) => flattenSearchParts(value, []))
    .join(' ');

const exactPhraseBonus = (queryText = '', targetText = '', weight = 0) => {
  if (!queryText || !targetText) return 0;
  return targetText.includes(queryText) ? weight : 0;
};

const tokenOverlapScore = (queryTokens = [], targetText = '', weight = 1) => {
  if (!targetText || !queryTokens.length) return 0;
  const targetTokens = new Set(tokenize(targetText));
  return queryTokens.reduce((score, token) => {
    if (targetTokens.has(token)) return score + weight;
    if (targetText.includes(token)) return score + weight * 0.5;
    return score;
  }, 0);
};

const businessIdentifierOverlapScore = (queryText = '', metadata = {}) => {
  const idText = normalizeText(fieldText(metadata, [
    'accountId',
    'sourceAccountId',
    'debitAccountId',
    'customerId',
    'requestId',
    'billId',
    'billReference',
    'reference',
  ]));
  if (!idText) return 0;

  const queryTokens = tokenize(queryText);
  return queryTokens.reduce((score, token) => (
    idText.includes(token) ? score + 8 : score
  ), 0);
};

const semanticResourceText = (entry = {}) => {
  const metadata = entry.metadata || {};
  const exampleQueryText = fieldText(metadata, ['exampleQueries']);
  const intentText = fieldText(metadata, ['intents']);
  return {
    title: normalizeText(fieldText(metadata, ['title', 'name', 'label'])),
    category: normalizeText(fieldText(metadata, [
      'category',
    ])),
    description: normalizeText(fieldText(metadata, [
      'description',
    ])),
    examples: normalizeText(exampleQueryText),
    intents: normalizeText(intentText),
  };
};

const resourceFileKind = (entry = {}) => {
  const metadata = entry.metadata || {};
  const explicitType = normalizeText(metadata.resourceFileType || '');
  if (explicitType === 'image' || explicitType === 'txt' || explicitType === 'json' || explicitType === 'pdf') {
    return explicitType;
  }

  const fileText = normalizeText([
    metadata.fileUrl,
    metadata.documentUrl,
    metadata.url,
    entry.fileName,
  ].filter(Boolean).join(' '));
  const mimeText = normalizeText(metadata.mimeType || metadata.contentType || '');

  if (/\bimage\b/.test(mimeText) || /\b(png|jpg|jpeg|webp|tif|tiff)\b/.test(fileText)) return 'image';
  if (/\btext\b/.test(mimeText) || /\btxt\b/.test(fileText)) return 'txt';
  if (/\bjson\b/.test(mimeText) || /\bjson\b/.test(fileText)) return 'json';
  if (/\bpdf\b/.test(mimeText) || /\bpdf\b/.test(fileText)) return 'pdf';
  return 'unknown';
};

const queryRequestsVisualResource = (queryText = '', originalText = queryText) => {
  const text = normalizeText(`${queryText} ${originalText}`);
  return /\b(qr|image|img|photo|picture|screenshot|scan|scanned|visual|png|jpg|jpeg|webp)\b/.test(text);
};

const queryRequestsReadableResource = (queryText = '', originalText = queryText) => {
  const text = normalizeText(`${queryText} ${originalText}`);
  return /\b(read|text|txt|pdf|document|file|open|show|view|download)\b/.test(text);
};

const specificQueryTokens = (queryTokens = []) =>
  queryTokens.filter((token) => !GENERIC_RESOURCE_QUERY_TERMS.has(token));

const DISTINCTIVE_QUERY_NOISE_TERMS = new Set([
  ...GENERIC_RESOURCE_QUERY_TERMS,
  'details',
  'happened',
  'notice',
  'resource',
]);

const distinctiveQueryTokens = (queryTokens = []) =>
  queryTokens.filter((token) => token.length >= 3 && !DISTINCTIVE_QUERY_NOISE_TERMS.has(token));

// The catalog selectionPolicy can restrict semantic scoring to a subset of
// fields. The description-only catalog (v4.x) sets matchFields = ["description"]:
// id/title/files are metadata only and must NOT contribute to scoring.
const isDescriptionOnlyPolicy = (selectionPolicy = {}) => {
  const fields = Array.isArray(selectionPolicy?.matchFields)
    ? selectionPolicy.matchFields.map((field) => String(field).trim().toLowerCase()).filter(Boolean)
    : [];
  return fields.length === 1 && fields[0] === 'description';
};

// Pure description scorer. Scores only resource.description — no title, id,
// category, type, fileName, intents, exampleQueries, or resourceType signals.
// File names are used only after a resource has been selected.
const scoreDescriptionOnlyEntry = (entry, messageText) => {
  const queryText = normalizeResourceSearchQuery(messageText) || normalizeText(messageText);
  const semanticQueryText = normalizeText([...expandQueryParts(queryText), queryText].join(' '));
  const queryTokens = tokenize(semanticQueryText);
  if (!queryText || !queryTokens.length) return 0;

  const description = normalizeText(fieldText(entry.metadata || {}, ['description']));
  if (!description) return 0;

  let score = 0;
  score += tokenOverlapScore(queryTokens, description, 16);
  score += exactPhraseBonus(queryText, description, 28);

  const distinctiveTokens = distinctiveQueryTokens(queryTokens);
  for (const token of distinctiveTokens) {
    score += wholeWordIncludes(description, token) ? 12 : -6;
  }

  const matchedTokenCount = queryTokens.filter((token) => description.includes(token)).length;
  const coverage = matchedTokenCount / Math.max(queryTokens.length, 1);
  if (coverage >= 0.8) score += 8;
  else if (coverage >= 0.5) score += 4;
  else if (coverage < 0.25) score -= 4;

  return Number(score.toFixed(2));
};

const scoreSemanticEntry = (entry, messageText) => {
  if (isDescriptionOnlyPolicy(entry.metadata?.selectionPolicy)) {
    return scoreDescriptionOnlyEntry(entry, messageText);
  }

  const queryText = normalizeResourceSearchQuery(messageText) || normalizeText(messageText);
  const semanticQueryText = normalizeText([...expandQueryParts(queryText), queryText].join(' '));
  const queryTokens = tokenize(semanticQueryText);
  const parts = semanticResourceText(entry);
  const resourceType = normalizeResourceType(entry.metadata?.resourceType);
  const originalText = normalizeText(messageText);

  if (!queryText || !queryTokens.length) return 0;

  let score = 0;
  score += tokenOverlapScore(queryTokens, parts.description, 16);
  score += exactPhraseBonus(queryText, parts.description, 28);
  score += tokenOverlapScore(queryTokens, parts.examples, 11);
  score += exactPhraseBonus(queryText, parts.examples, 20);
  score += tokenOverlapScore(queryTokens, parts.title, 7);
  score += exactPhraseBonus(queryText, parts.title, 12);
  score += tokenOverlapScore(queryTokens, parts.category, 3);
  score += exactPhraseBonus(queryText, parts.category, 4);
  score += tokenOverlapScore(queryTokens, parts.intents, 3);
  score += exactPhraseBonus(queryText, parts.intents, 4);
  score += businessIdentifierOverlapScore(queryText, entry.metadata || {});

  const semanticText = normalizeText([
    parts.title,
    parts.description,
    parts.category,
    parts.examples,
    parts.intents,
  ].join(' '));
  const distinctiveTokens = distinctiveQueryTokens(queryTokens);
  for (const token of distinctiveTokens) {
    score += semanticText.includes(token) ? 8 : -8;
  }

  // Description-first anchor. The catalog selectionPolicy lists `title` as the
  // primary match field: a resource whose title names the query's distinctive
  // object (e.g. "checkbook" -> "Checkbook Request Status") is the intended
  // match. Without this, generic fulfillment words that only overlap in prose
  // ("pick up", "ready", "appointment") let unrelated resources outscore the
  // object-specific one. Whole-word match on the title keeps the boost precise.
  const titleText = normalizeText(parts.title);
  for (const token of distinctiveTokens) {
    if (wholeWordIncludes(titleText, token)) score += 22;
  }

  if (/\bsms\s+card\s+alert\b/.test(originalText)) {
    score += /\bsms\b/.test(semanticText) && /\bcard\b/.test(semanticText) && /\balert\b/.test(semanticText)
      ? 42
      : -24;
  }

  for (const provider of BILL_PROVIDER_KEYWORDS) {
    if (!queryText.includes(provider)) continue;
    if (semanticText.includes(provider)) score += 14;
    else if (isBillResourceType(resourceType) || resourceType.includes('payment')) score -= 8;
  }

  const matchedTokenCount = queryTokens.filter((token) => semanticText.includes(token)).length;
  const coverage = matchedTokenCount / Math.max(queryTokens.length, 1);
  if (coverage >= 0.8) score += 8;
  else if (coverage >= 0.5) score += 4;
  else if (coverage < 0.25) score -= 4;

  // Extra boost when image resource title appears verbatim in the original query.
  if (resourceFileKind(entry) === 'image' && parts.title && originalText.includes(parts.title)) {
    score += 50;
  }

  const specificTokens = specificQueryTokens(queryTokens);
  // Skip specificTokens penalty for image resources when their title phrase matches the query —
  // image metadata is intentionally thin so token absence is not a mismatch signal.
  const isImageTitleMatch =
    resourceFileKind(entry) === 'image' &&
    parts.title &&
    (originalText.includes(parts.title) || queryText.includes(parts.title));
  if (
    !isImageTitleMatch &&
    specificTokens.length &&
    !specificTokens.some((token) => semanticText.includes(token))
  ) {
    score -= Math.max(20, specificTokens.length * 12);
  }

  if (
    resourceFileKind(entry) === 'image' &&
    !queryRequestsVisualResource(queryText, originalText) &&
    queryRequestsReadableResource(queryText, originalText) &&
    !/\b(payment|receipt|invoice|merchant|qr|notice|alert)\b/.test(queryText)
  ) {
    score -= 18;
  }

  const asksAccountBalance =
    /\baccounts?\b.*\bbalance\b/.test(queryText) ||
    /\bbalance\b.*\baccounts?\b/.test(queryText);
  if (
    asksAccountBalance &&
    !['account_statement', 'account_summary', 'account_profile'].includes(resourceType)
  ) {
    score -= 30;
  }

  return Number(score.toFixed(2));
};

const scoreSemanticCatalogEntries = (catalog, messageText, options = {}) => {
  const allowedResourceTypes = Array.isArray(options.allowedResourceTypes)
    ? new Set(options.allowedResourceTypes.map(normalizeResourceType))
    : null;
  const excludedResourceTypes = Array.isArray(options.excludedResourceTypes)
    ? new Set(options.excludedResourceTypes.map(normalizeResourceType))
    : new Set();

  return catalog
    .filter((entry) => {
      const resourceType = normalizeResourceType(entry.metadata?.resourceType);
      if (allowedResourceTypes && !allowedResourceTypes.has(resourceType)) return false;
      if (excludedResourceTypes.has(resourceType)) return false;
      return true;
    })
    .map((entry) => ({
      ...entry,
      score: scoreSemanticEntry(entry, messageText),
    }))
    .sort((a, b) => b.score - a.score);
};

const isLiveAccountBalanceQuery = (messageText = '') => {
  const text = normalizeText(messageText);
  if (!text) return false;
  const asksBalance =
    /\bwhat\s+(?:is|are)\s+(?:my\s+)?accounts?\s+balance\b/.test(text) ||
    /\b(show|check|get|view)\b.{0,40}\b(?:my\s+)?(?:account\s+)?balance\b/.test(text) ||
    /\b(?:my\s+)?account\s+balance\b/.test(text);
  if (!asksBalance) return false;
  return !/\b(statement|document|pdf|certificate|receipt|notice|summary|closing|opening|transaction|movement)\b/.test(text);
};

// IMPORTANT (policy vs. real thresholds): the catalog selectionPolicy fields `minConfidence` (0.75),
// `maxCandidates`, and `fileNameUse` are DESCRIPTIVE METADATA ONLY — no code reads them. The real
// retrieval gates are RAW SCORE/MARGIN values in points (not a 0–1 confidence):
//   minScore  = env.semanticResourceMinScore  (SEMANTIC_RESOURCE_MIN_SCORE, default 12)
//   minMargin = env.semanticResourceMinMargin  (SEMANTIC_RESOURCE_MIN_MARGIN, default 3)
// `fileNameUse: only_after_selection` is honored in spirit because scoreDescriptionOnlyEntry scores
// ONLY the description; file names are used only after a resource is selected.
const applySemanticSelectionRules = (scoredEntries = [], options = {}) => {
  const minScore = Number.isFinite(options.minScore)
    ? options.minScore
    : env.semanticResourceMinScore;
  const minMargin = Number.isFinite(options.minMargin)
    ? options.minMargin
    : env.semanticResourceMinMargin;
  const best = scoredEntries[0] || null;
  const second = scoredEntries[1] || null;

  if (!best || best.score < minScore) {
    return {
      matches: [],
      reason: 'below_minimum_threshold',
      bestScore: best?.score || 0,
      minScore,
      minMargin,
    };
  }

  const margin = second ? best.score - second.score : best.score;
  if (second && margin < minMargin && best.score < minScore + minMargin * 2) {
    return {
      matches: [],
      ambiguousMatches: scoredEntries
        .filter((entry) => entry.score >= minScore && best.score - entry.score <= minMargin)
        .slice(0, 5),
      reason: 'weak_margin',
      bestScore: best.score,
      secondScore: second.score,
      minScore,
      minMargin,
    };
  }

  return {
    matches: scoredEntries.filter((entry) => entry.score >= minScore),
    reason: 'matched',
    bestScore: best.score,
    secondScore: second?.score || null,
    minScore,
    minMargin,
  };
};

const findMatchingResources = async (messageText, options = {}) => {
  if (!messageText || typeof messageText !== 'string') {
    return [];
  }

  const catalog = await loadResourceCatalog(options);
  const searchText = normalizeResourceSearchQuery(messageText) || messageText;
  // Description-only safety default: if the loaded catalog declares matchFields = ["description"],
  // force semantic (description-only) scoring even when a caller forgot to pass searchMode:'semantic'.
  // This makes the legacy keyword scorer (scoreEntry, which reads title/type/intents) unreachable for
  // a description-only catalog, so resource selection can never silently fall back to those fields.
  const catalogIsDescriptionOnly = catalog.some((entry) =>
    isDescriptionOnlyPolicy(entry.metadata?.selectionPolicy));
  if (catalogIsDescriptionOnly && !(options.searchMode === 'semantic' || options.semanticSearch === true)) {
    debugResourceSearchLog('[resource-catalog] description-only catalog: forcing semantic description scoring');
  }
  const useSemanticSearch =
    options.searchMode === 'semantic' || options.semanticSearch === true || catalogIsDescriptionOnly;
  const minScore = Number.isFinite(options.minScore)
    ? options.minScore
    : useSemanticSearch
      ? env.semanticResourceMinScore
      : MIN_MATCH_SCORE;
  const limit = Number.isFinite(options.limit) ? options.limit : 5;
  if (isLiveAccountBalanceQuery(messageText)) {
    debugResourceSearchLog('[resource-catalog] no match: live account balance query');
    return [];
  }
  if (isUnsupportedImageResourceQuery(messageText)) {
    const reason = 'image_resources_disabled';
    if (useSemanticSearch) {
      logAgentStep(options.requestId, 'semantic_resource_search_started', {
        searchQueryLength: messageText.length,
        filters: {
          limit,
          minScore,
          minMargin: options.minMargin || env.semanticResourceMinMargin,
          allowedResourceTypes: options.allowedResourceTypes || null,
          excludedResourceTypes: options.excludedResourceTypes || null,
        },
        indexPath: CATALOG_URL,
      });
      logAgentStep(options.requestId, 'semantic_resource_no_match', {
        searchQueryLength: messageText.length,
        reason,
        bestScore: 0,
        secondScore: null,
        minScore,
        minMargin: options.minMargin || env.semanticResourceMinMargin,
        topCandidates: [],
      });
    }
    debugResourceSearchLog('[resource-catalog] no match: image resources are disabled');
    return [];
  }
  if (useSemanticSearch) {
    logAgentStep(options.requestId, 'semantic_resource_search_started', {
      searchQueryLength: messageText.length,
      filters: {
        limit,
        minScore,
        minMargin: options.minMargin || env.semanticResourceMinMargin,
        allowedResourceTypes: options.allowedResourceTypes || null,
        excludedResourceTypes: options.excludedResourceTypes || null,
      },
      indexPath: CATALOG_URL,
      searchFields: [
        'description',
        'exampleQueries',
        'title',
        'category',
        'intents',
      ],
    });
    const scoredEntries = scoreSemanticCatalogEntries(catalog, searchText, options);
    const selection = applySemanticSelectionRules(scoredEntries, {
      minScore,
      minMargin: options.minMargin,
    });
    const topCandidates = scoredEntries.slice(0, 3).map((entry) => ({
      resourceId: safeResourceId(entry),
      type: entry.metadata?.resourceType || entry.metadata?.type || entry.metadata?.category,
      score: entry.score,
    }));

    logAgentStep(options.requestId, 'semantic_resource_candidates_found', {
      count: selection.matches.length,
      topCandidates,
      minScore: selection.minScore,
      minMargin: selection.minMargin,
      selectionReason: selection.reason,
    });
    logArchitecture('semantic_resource_search', {
      requestId: options.requestId,
      threadId: options.threadId,
      queryLength: messageText.length,
      minScore: selection.minScore,
      minMargin: selection.minMargin,
      selectionReason: selection.reason,
      topMatches: topCandidates,
    });

    if (!selection.matches.length) {
      logAgentStep(options.requestId, 'semantic_resource_no_match', {
        searchQueryLength: messageText.length,
        reason: selection.reason,
        bestScore: selection.bestScore,
        secondScore: selection.secondScore || null,
        minScore: selection.minScore,
        minMargin: selection.minMargin,
        topCandidates,
      });
      debugResourceSearchLog('[resource-catalog] semantic no confident match:', {
        queryLength: messageText.length,
        reason: selection.reason,
        bestScore: selection.bestScore,
        minScore: selection.minScore,
        minMargin: selection.minMargin,
      });
      if (selection.reason === 'weak_margin' && selection.ambiguousMatches?.length) {
        return selection.ambiguousMatches.map((entry) => ({
          fileName: entry.fileName,
          url: entry.url,
          metadata: entry.metadata,
          score: entry.score,
          ambiguous: true,
          selectionReason: selection.reason,
        }));
      }
      return [];
    }

    const best = selection.matches[0];
    debugResourceSearchLog('[resource-catalog] semantic selected resource:', {
      resourceId: safeResourceId(best),
      resourceType: best.metadata?.resourceType,
      score: best.score,
    });
    logArchitecture('semantic_resource_selected', {
      requestId: options.requestId,
      threadId: options.threadId,
      selectedResourceId: safeResourceId(best),
      category: best.metadata?.resourceType,
      score: best.score,
    });

    return selection.matches.slice(0, limit).map((entry) => ({
      fileName: entry.fileName,
      url: entry.url,
      metadata: entry.metadata,
      score: entry.score,
    }));
  }
  const scoredEntries = scoreCatalogEntries(catalog, searchText, options);
  const queryTokens = expandQueryParts(searchText);
  const genericOnlyQuery =
    queryTokens.length > 0 && queryTokens.every((token) => GENERIC_QUERY_TERMS.has(token));
  const topResourceTypes = unique(
    scoredEntries
      .slice(0, 3)
      .filter((entry) => entry.score >= minScore)
      .map((entry) => normalizeResourceType(entry.metadata?.resourceType)),
  );
  const ambiguousGenericMatch =
    genericOnlyQuery &&
    topResourceTypes.length > 1 &&
    scoredEntries[0]?.score - scoredEntries[1]?.score <= 2;
  let scored = ambiguousGenericMatch
    ? []
    : scoredEntries.filter((entry) => entry.score >= minScore);
  if (!scored.length) {
    const aliasMatches = findAliasMatchesInCatalog(searchText, catalog)
      .slice(0, limit)
      .map((entry) => ({
        ...entry,
        score: Math.max(entry.score || 0, entry.aliasScore),
      }));
    if (aliasMatches.length) {
      scored = aliasMatches;
    }
  }
  if (!scored.length) {
    const semanticEntries = scoreSemanticCatalogEntries(catalog, searchText, options);
    const semanticSelection = applySemanticSelectionRules(semanticEntries, {
      minScore: env.semanticResourceMinScore,
      minMargin: options.minMargin,
    });
    if (semanticSelection.matches.length) {
      scored = semanticSelection.matches;
      logAgentStep(options.requestId, 'semantic_resource_fallback_selected', {
        searchQueryLength: messageText.length,
        normalizedQueryLength: searchText.length,
        bestScore: semanticSelection.bestScore,
        secondScore: semanticSelection.secondScore || null,
        minScore: semanticSelection.minScore,
        minMargin: semanticSelection.minMargin,
        topCandidates: semanticEntries.slice(0, 3).map((entry) => ({
          resourceId: safeResourceId(entry),
          type: entry.metadata?.resourceType || entry.metadata?.type || entry.metadata?.category,
          score: entry.score,
        })),
      });
    }
  }
  const topCandidates = scoredEntries.slice(0, 3).map((entry) => ({
    resourceId: safeResourceId(entry),
    resourceType: entry.metadata?.resourceType,
    score: entry.score,
  }));

  debugResourceSearchLog('[resource-catalog] resource query:', {
    queryLength: messageText.length,
  });
  debugResourceSearchLog('[resource-catalog] top candidates:', topCandidates);
  logArchitecture('laragon_resource_search', {
    requestId: options.requestId,
    threadId: options.threadId,
    queryLength: messageText.length,
    topMatches: topCandidates.map((entry) => ({
      resourceId: entry.resourceId,
      score: entry.score,
      category: entry.resourceType,
    })),
  });

  if (!scored.length) {
    const bestScore = scoredEntries[0]?.score ?? 0;
    debugResourceSearchLog('[resource-catalog] no confident match:', {
      minScore,
      bestScore,
      reason: ambiguousGenericMatch ? 'ambiguous_generic_query' : 'below_minimum_threshold',
    });
  } else {
    const best = scored[0];
    debugResourceSearchLog('[resource-catalog] selected resource:', {
      resourceId: safeResourceId(best),
      resourceType: best.metadata?.resourceType,
      score: best.score,
    });
    logArchitecture('laragon_resource_selected', {
      requestId: options.requestId,
      threadId: options.threadId,
      selectedResourceId: safeResourceId(best),
      category: best.metadata?.resourceType,
      fileUrlExists: Boolean(best.metadata?.fileUrl || best.metadata?.documentUrl || best.metadata?.url),
    });
  }

  return scored.slice(0, limit).map((entry) => ({
    fileName: entry.fileName,
    url: entry.url,
    metadata: entry.metadata,
    score: entry.score,
  }));
};

const debugResourceCatalogMatch = async (messageText, options = {}) => {
  const query = String(messageText || '').trim();
  const catalog = await loadResourceCatalog(options);
  const minScore = Number.isFinite(options.minScore)
    ? options.minScore
    : MIN_MATCH_SCORE;
  const limit = Number.isFinite(options.limit) ? options.limit : 8;
  const scored = query ? scoreCatalogEntries(catalog, query, options) : [];
  const topMatches = scored
    .slice(0, limit)
    .map((entry) => summarizeMatchedEntry(entry, query));
  const selected = scored.find((entry) => entry.score >= minScore);

  let reason = null;
  if (!query) {
    reason = 'No q query parameter was provided.';
  } else if (!selected) {
    reason = topMatches.length
      ? `Best score ${topMatches[0].score} is below the minimum score ${minScore}.`
      : 'Catalog loaded, but no resources were available to score.';
  }

  return {
    activeBaseUrl: RESOURCE_SERVER_BASE_URL,
    jsonBaseUrl: RESOURCE_JSON_BASE_URL,
    documentBaseUrl: RESOURCE_DOCUMENT_BASE_URL,
    catalogUrl: CATALOG_URL,
    loadedResourcesCount: catalog.length,
    query,
    minScore,
    topMatches,
    selectedMatch: selected ? summarizeMatchedEntry(selected, query) : null,
    reason,
  };
};

const findMatchingResource = async (messageText, options = {}) => {
  const matches = await findMatchingResources(messageText, { ...options, limit: 1 });
  const best = matches[0];

  if (!best) {
    debugResourceSearchLog('[resource-catalog] no match found');
    return null;
  }

  debugResourceSearchLog(
    '[resource-catalog] matched resource title/resourceType:',
    best.metadata?.title || best.fileName,
    best.metadata?.resourceType,
  );

  return best;
};

/**
 * Search catalog entries (metadata only) for document-like resources matching the query.
 * Operates purely on in-memory catalog metadata — does NOT require Laragon to be running.
 * Returns [{entry, score}] sorted by score desc, filtered to score > 0.
 */
const searchCatalogDocuments = (query, catalog) => {
  if (!catalog || !Array.isArray(catalog)) return [];
  const q = normalizeText(query);
  const isDocQuery = /\b(document|formulaire|form|pdf|fichier|t[eé]l[eé]charger|download|demande|dossier|certificate|attestation|relev[eé]|re[cç]u|receipt)\b/i.test(query);
  if (!isDocQuery) return [];

  const qTokens = tokenize(q).filter((t) => !GENERIC_RESOURCE_QUERY_TERMS.has(t));
  if (qTokens.length === 0) return [];

  const scored = [];
  for (const entry of catalog) {
    const title   = normalizeText(entry.title || entry.name || '');
    const desc    = normalizeText(entry.description || '');
    const ext     = (entry.fileType || entry.extension || '').toLowerCase().replace('.', '');
    const intents = (entry.intents || []).map(normalizeText).join(' ');
    let score = 0;

    for (const tok of qTokens) {
      if (wholeWordIncludes(title, tok)) score += 2.0;
      else if (title.includes(tok))       score += 1.0;
      if (desc.includes(tok))             score += 0.5;
      if (intents.includes(tok))          score += 0.3;
    }

    if (['pdf', 'doc', 'docx', 'xls', 'xlsx'].includes(ext)) score += 0.5;

    if (score > 0) scored.push({ entry, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5);
};

module.exports = {
  CATALOG_URL,
  JSON_RESOURCE_BASE_URL,
  RESOURCE_DOCUMENT_BASE_URL,
  RESOURCE_JSON_BASE_URL,
  RESOURCE_SERVER_BASE_URL,
  ResourceCatalogUnavailableError,
  findMatchingResource,
  findMatchingResources,
  buildCatalogFileUrl,
  debugResourceCatalogMatch,
  loadResourceCatalog,
  normalizeResourceSearchQuery,
  selectCatalogFile,
  searchCatalogDocuments,
};
