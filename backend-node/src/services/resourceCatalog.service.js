const axios = require('axios');
const env = require('../config/env');
const { findAliasMatchesInCatalog, scoreAliasForTitle } = require('./resourceAlias.service');
const { logArchitecture } = require('./architectureLogger.service');
const { logAgentStep } = require('./agentLogger.service');

const RESOURCE_SERVER_BASE_URL = env.resourceServerBaseUrl;
const RESOURCE_JSON_BASE_URL = env.resourceJsonBaseUrl;
const RESOURCE_DOCUMENT_BASE_URL = env.resourceDocumentBaseUrl;
const JSON_RESOURCE_BASE_URL = `${RESOURCE_JSON_BASE_URL}/`;
const CATALOG_URL = `${RESOURCE_JSON_BASE_URL}/catalog.json`;
const REQUEST_TIMEOUT_MS = 3000;
const MIN_MATCH_SCORE = 10;
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
  constructor(message = 'Resource server is not reachable') {
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
  'pay',
  'please',
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

let catalogCache = null;
let catalogCacheExpiresAt = 0;

const normalizeText = (value = '') =>
  String(value || '')
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

const unique = (values) => Array.from(new Set(values.filter(Boolean)));

const hasPhrase = (text = '', phrase = '') =>
  text.includes(normalizeText(phrase));

const isUnsupportedImageResourceQuery = (messageText = '') =>
  /\b(image|photo|picture|scan|scanned|screenshot)\b/.test(normalizeText(messageText));

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

const getUrlFileName = (value = '') => {
  const text = String(value || '').trim();
  if (!text) return null;

  try {
    return new URL(text).pathname.split('/').pop() || null;
  } catch {
    return text.split(/[\\/]/).pop() || null;
  }
};

const toCatalogJsonUrl = (value = '') => {
  const text = String(value || '').trim();
  if (!text) return null;

  if (/^https?:\/\//i.test(text)) {
    return text;
  }

  const fileName = getUrlFileName(text);
  return fileName ? `${JSON_RESOURCE_BASE_URL}${fileName}` : null;
};

const deriveJsonUrlFromFileUrl = (value = '') => {
  const fileName = getUrlFileName(value);
  if (!fileName) return null;

  const jsonFileName = fileName.replace(/\.[^.]+$/i, '.json');
  return jsonFileName.endsWith('.json')
    ? `${JSON_RESOURCE_BASE_URL}${jsonFileName}`
    : null;
};

const isAllowedJsonResourceUrl = (urlValue) => {
  try {
    const parsed = new URL(urlValue);
    const jsonBaseUrl = new URL(`${RESOURCE_JSON_BASE_URL}/`);
    return (
      parsed.protocol === jsonBaseUrl.protocol &&
      parsed.host === jsonBaseUrl.host &&
      parsed.pathname.startsWith(jsonBaseUrl.pathname) &&
      parsed.pathname.endsWith('.json') &&
      !parsed.pathname
        .split('/')
        .map((segment) => decodeURIComponent(segment))
        .includes('..')
    );
  } catch {
    return false;
  }
};

const fetchText = async (url) => {
  const response = await axios.get(url, {
    responseType: 'text',
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: (status) => status >= 200 && status < 300,
  });
  return String(response.data || '');
};

const fetchJson = async (url) => {
  const response = await axios.get(url, {
    responseType: 'json',
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: (status) => status >= 200 && status < 300,
  });
  return response.data;
};

const parseDirectoryListing = (html = '') => {
  const fileNames = [];
  const hrefPattern = /href=["']([^"']+\.json)["']/gi;
  let match;

  while ((match = hrefPattern.exec(html)) !== null) {
    const rawHref = match[1];
    const fileName = decodeURIComponent(rawHref.split('/').pop() || '');

    if (fileName && fileName !== 'catalog.json' && fileName.endsWith('.json')) {
      fileNames.push(fileName);
    }
  }

  return unique(fileNames);
};

const entriesFromCatalogJson = (catalogJson) => {
  const items = Array.isArray(catalogJson)
    ? catalogJson
    : catalogJson?.resources || catalogJson?.items || catalogJson?.documents || [];

  return items
    .map((item) => {
      if (typeof item === 'string') {
        const fileName = getUrlFileName(item);
        const jsonUrl = fileName?.endsWith('.json')
          ? toCatalogJsonUrl(item)
          : deriveJsonUrlFromFileUrl(item);
        return {
          fileName: jsonUrl ? getUrlFileName(jsonUrl) : fileName,
          url: jsonUrl,
          metadata: null,
        };
      }

      const explicitJsonUrl = item.jsonUrl || item.resourceUrl || (
        String(item.url || '').endsWith('.json') ? item.url : null
      );
      const fileUrl = item.fileUrl || item.documentUrl || (
        String(item.url || '').match(/\.[a-z0-9]+$/i) && !String(item.url || '').endsWith('.json')
          ? item.url
          : null
      );
      const rawFileName =
        item.fileName ||
        item.name ||
        getUrlFileName(explicitJsonUrl) ||
        getUrlFileName(fileUrl);
      const jsonUrl = explicitJsonUrl
        ? toCatalogJsonUrl(explicitJsonUrl)
        : deriveJsonUrlFromFileUrl(fileUrl || rawFileName);
      const fileName = jsonUrl ? getUrlFileName(jsonUrl) : rawFileName;

      return {
        fileName,
        url: jsonUrl,
        metadata: item,
      };
    })
    .filter(
      (item) =>
        item.fileName &&
        (item.metadata || item.url) &&
        (!item.url || isAllowedJsonResourceUrl(item.url)),
    );
};

const loadDirectoryCatalog = async () => {
  const html = await fetchText(JSON_RESOURCE_BASE_URL);
  const fileNames = parseDirectoryListing(html);

  if (!fileNames.length) {
    return [];
  }

  return Promise.all(
    fileNames.map(async (fileName) => {
      const url = `${JSON_RESOURCE_BASE_URL}${fileName}`;
      const metadata = await fetchJson(url).catch(() => null);
      return { fileName, url, metadata };
    }),
  );
};

const loadFallbackCatalog = async () => {
  const catalogJson = await fetchJson(CATALOG_URL);
  const entries = entriesFromCatalogJson(catalogJson);

  return Promise.all(
    entries.map(async (entry) => {
      const resourceJson = entry.url
        ? await fetchJson(entry.url).catch(() => null)
        : null;

      return {
        ...entry,
        metadata: {
          ...(entry.metadata || {}),
          ...(resourceJson || {}),
        },
      };
    }),
  );
};

const catalogEntryKey = (entry = {}) =>
  entry.metadata?.resourceId ||
  entry.fileName ||
  entry.url ||
  entry.metadata?.fileUrl ||
  entry.metadata?.title;

const mergeCatalogEntries = (...catalogs) => {
  const merged = new Map();

  catalogs.flat().forEach((entry) => {
    const key = catalogEntryKey(entry);
    if (!key) return;

    const existing = merged.get(key);
    merged.set(key, {
      ...(existing || {}),
      ...entry,
      metadata: {
        ...(existing?.metadata || {}),
        ...(entry.metadata || {}),
      },
    });
  });

  return Array.from(merged.values());
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

const loadResourceCatalog = async ({ forceRefresh = false, catalog: catalogOverride = null } = {}) => {
  if (Array.isArray(catalogOverride)) {
    return catalogOverride.filter((entry) => isResourceMetadata(entry.metadata));
  }

  const now = Date.now();

  if (!forceRefresh && catalogCache && catalogCacheExpiresAt > now) {
    return catalogCache;
  }

  console.log('[resource-catalog] active base URL:', RESOURCE_SERVER_BASE_URL);
  console.log('[resource-catalog] catalog URL:', CATALOG_URL);

  let catalog = [];
  let lastError = null;

  try {
    catalog = await loadDirectoryCatalog();
  } catch (error) {
    lastError = error;
    catalog = [];
  }

  if (!catalog.length) {
    try {
      catalog = await loadFallbackCatalog();
    } catch (error) {
      lastError = error;
      catalog = [];
    }
  } else {
    try {
      const fallbackCatalog = await loadFallbackCatalog();
      catalog = mergeCatalogEntries(fallbackCatalog, catalog);
    } catch (error) {
      lastError = lastError || error;
    }
  }

  if (!catalog.length && lastError) {
    console.log('[resource-catalog] no resources loaded:', lastError.message);
    throw new ResourceCatalogUnavailableError();
  }

  catalogCache = catalog.filter((entry) => isResourceMetadata(entry.metadata));
  catalogCacheExpiresAt = now + 60 * 1000;
  console.log('[resource-catalog] resources loaded count:', catalogCache.length);
  return catalogCache;
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

const metadataText = (entry) =>
  normalizeText([
    entry.fileName,
    entry.url,
    ...flattenSearchParts(entry.metadata),
  ].join(' '));

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
  if (text.includes('card') && text.includes('limit')) {
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
    text.includes('bill') ||
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
  const aliasMatch = scoreAliasForTitle(messageText, entry.metadata?.title || entry.fileName || '');
  let score = 0;

  if (aliasMatch.score > 0) {
    score += aliasMatch.score;
  }

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
  entry.metadata?.title ||
  'unknown_resource';

const scoreCatalogEntries = (catalog, messageText, options = {}) => {
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
      score: scoreEntry(entry, messageText),
    }))
    .sort((a, b) => b.score - a.score);
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

const idOverlapScore = (queryText = '', metadata = {}) => {
  const idText = normalizeText(fieldText(metadata, [
    'id',
    'resourceId',
    'accountId',
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
  return {
    title: normalizeText(fieldText(metadata, ['title', 'name', 'label']) || entry.fileName),
    category: normalizeText(fieldText(metadata, [
      'category',
      'type',
      'resourceType',
      'documentType',
      'service',
    ])),
    description: normalizeText(fieldText(metadata, [
      'description',
      'summary',
      'shortDescription',
      'details',
      'purpose',
    ])),
    tags: normalizeText(fieldText(metadata, [
      'tags',
      'aliases',
      'keywords',
      'searchTerms',
      'matchedAliases',
    ])),
    preview: normalizeText(fieldText(metadata, [
      'fileTextPreview',
      'textPreview',
      'extractedTextPreview',
      'pdfTextPreview',
      'contentPreview',
      'extractedText',
    ])),
    fileUrl: normalizeText(fieldText(metadata, ['fileUrl', 'documentUrl', 'url']) || entry.url),
    metadata: metadataText(entry),
  };
};

const scoreSemanticEntry = (entry, messageText) => {
  const queryText = normalizeText(messageText);
  const queryTokens = tokenize(queryText);
  const parts = semanticResourceText(entry);

  if (!queryText || !queryTokens.length) return 0;

  let score = 0;
  score += tokenOverlapScore(queryTokens, parts.title, 8);
  score += exactPhraseBonus(queryText, parts.title, 12);
  score += tokenOverlapScore(queryTokens, parts.category, 5);
  score += exactPhraseBonus(queryText, parts.category, 6);
  score += tokenOverlapScore(queryTokens, parts.description, 4);
  score += exactPhraseBonus(queryText, parts.description, 7);
  score += tokenOverlapScore(queryTokens, parts.tags, 5);
  score += exactPhraseBonus(queryText, parts.tags, 8);
  score += tokenOverlapScore(queryTokens, parts.preview, 3);
  score += exactPhraseBonus(queryText, parts.preview, 5);
  score += tokenOverlapScore(queryTokens, parts.fileUrl, 2);
  score += tokenOverlapScore(queryTokens, parts.metadata, 1.5);
  score += idOverlapScore(queryText, entry.metadata || {});

  const matchedTokenCount = queryTokens.filter((token) => parts.metadata.includes(token)).length;
  const coverage = matchedTokenCount / Math.max(queryTokens.length, 1);
  if (coverage >= 0.8) score += 8;
  else if (coverage >= 0.5) score += 4;
  else if (coverage < 0.25) score -= 4;

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
  const useSemanticSearch = options.searchMode === 'semantic' || options.semanticSearch === true;
  const minScore = Number.isFinite(options.minScore)
    ? options.minScore
    : useSemanticSearch
      ? env.semanticResourceMinScore
      : MIN_MATCH_SCORE;
  const limit = Number.isFinite(options.limit) ? options.limit : 5;
  if (isUnsupportedImageResourceQuery(messageText)) {
    const reason = 'image_resources_disabled';
    if (useSemanticSearch) {
      logAgentStep(options.requestId, 'semantic_resource_search_started', {
        searchQuery: messageText,
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
        searchQuery: messageText,
        reason,
        bestScore: 0,
        secondScore: null,
        minScore,
        minMargin: options.minMargin || env.semanticResourceMinMargin,
        topCandidates: [],
      });
    }
    console.log('[resource-catalog] no match: image resources are disabled');
    return [];
  }
  if (useSemanticSearch) {
    logAgentStep(options.requestId, 'semantic_resource_search_started', {
      searchQuery: messageText,
      filters: {
        limit,
        minScore,
        minMargin: options.minMargin || env.semanticResourceMinMargin,
        allowedResourceTypes: options.allowedResourceTypes || null,
        excludedResourceTypes: options.excludedResourceTypes || null,
      },
      indexPath: CATALOG_URL,
      searchFields: [
        'title/name',
        'category/type',
        'description/summary',
        'metadata',
        'extractedTextPreview',
        'tags/aliases',
        'fileUrl',
        'account/customer/resource IDs',
      ],
    });
    const scoredEntries = scoreSemanticCatalogEntries(catalog, messageText, options);
    const selection = applySemanticSelectionRules(scoredEntries, {
      minScore,
      minMargin: options.minMargin,
    });
    const topCandidates = scoredEntries.slice(0, 3).map((entry) => ({
      title: entry.metadata?.title || entry.metadata?.name || entry.fileName,
      type: entry.metadata?.resourceType || entry.metadata?.type || entry.metadata?.category,
      score: entry.score,
      fileUrl: entry.metadata?.fileUrl || entry.metadata?.documentUrl || entry.metadata?.url || null,
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
      query: messageText,
      minScore: selection.minScore,
      minMargin: selection.minMargin,
      selectionReason: selection.reason,
      topMatches: topCandidates,
    });

    if (!selection.matches.length) {
      logAgentStep(options.requestId, 'semantic_resource_no_match', {
        searchQuery: messageText,
        reason: selection.reason,
        bestScore: selection.bestScore,
        secondScore: selection.secondScore || null,
        minScore: selection.minScore,
        minMargin: selection.minMargin,
        topCandidates,
      });
      console.log('[resource-catalog] semantic no confident match:', {
        query: messageText,
        reason: selection.reason,
        bestScore: selection.bestScore,
        minScore: selection.minScore,
        minMargin: selection.minMargin,
      });
      return [];
    }

    const best = selection.matches[0];
    console.log('[resource-catalog] semantic selected resource:', {
      title: best.metadata?.title || best.fileName,
      resourceType: best.metadata?.resourceType,
      score: best.score,
    });
    logArchitecture('semantic_resource_selected', {
      requestId: options.requestId,
      threadId: options.threadId,
      selectedResourceTitle: best.metadata?.title || best.fileName,
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
  const scoredEntries = scoreCatalogEntries(catalog, messageText, options);
  const queryTokens = expandQueryParts(messageText);
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
    const aliasMatches = findAliasMatchesInCatalog(messageText, catalog)
      .slice(0, limit)
      .map((entry) => ({
        ...entry,
        score: Math.max(entry.score || 0, entry.aliasScore),
      }));
    if (aliasMatches.length) {
      scored = aliasMatches;
    }
  }
  const topCandidates = scoredEntries.slice(0, 3).map((entry) => ({
    title: entry.metadata?.title || entry.fileName,
    resourceType: entry.metadata?.resourceType,
    score: entry.score,
  }));

  console.log('[resource-catalog] resource query:', messageText);
  console.log('[resource-catalog] top candidates:', topCandidates);
  logArchitecture('laragon_resource_search', {
    requestId: options.requestId,
    threadId: options.threadId,
    query: messageText,
    topMatches: topCandidates.map((entry) => ({
      title: entry.title,
      score: entry.score,
      category: entry.resourceType,
    })),
  });

  if (!scored.length) {
    const bestScore = scoredEntries[0]?.score ?? 0;
    console.log('[resource-catalog] no confident match:', {
      minScore,
      bestScore,
      reason: ambiguousGenericMatch ? 'ambiguous_generic_query' : 'below_minimum_threshold',
    });
  } else {
    const best = scored[0];
    console.log('[resource-catalog] selected resource:', {
      title: best.metadata?.title || best.fileName,
      resourceType: best.metadata?.resourceType,
      score: best.score,
    });
    logArchitecture('laragon_resource_selected', {
      requestId: options.requestId,
      threadId: options.threadId,
      selectedResourceTitle: best.metadata?.title || best.fileName,
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
    console.log('[resource-catalog] no match found');
    return null;
  }

  console.log(
    '[resource-catalog] matched resource title/resourceType:',
    best.metadata?.title || best.fileName,
    best.metadata?.resourceType,
  );

  return best;
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
  debugResourceCatalogMatch,
  loadResourceCatalog,
};
