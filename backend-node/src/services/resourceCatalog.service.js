const axios = require('axios');

const JSON_RESOURCE_BASE_URL = 'http://localhost/atb-resources/json/';
const CATALOG_URL = `${JSON_RESOURCE_BASE_URL}catalog.json`;
const REQUEST_TIMEOUT_MS = 10000;
const MIN_MATCH_SCORE = 7;

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'can',
  'could',
  'do',
  'for',
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
  'what',
  'when',
  'will',
  'you',
]);

const RESOURCE_TYPE_HINTS = {
  account_statement: ['statement', 'balance', 'movement', 'transactions', 'current', 'savings'],
  rib_certificate: ['rib', 'certificate'],
  loan_schedule: ['loan', 'payment', 'due', 'schedule'],
  card_dispute: ['card', 'dispute', 'status'],
  transfer_order: ['transfer', 'order', 'beneficiary', 'hiba'],
  account_certificate: ['ownership', 'certificate', 'account'],
  bill_notice: ['bill', 'invoice', 'payment', 'provider', 'sonede', 'steg', 'water', 'electricity', 'telecom', 'internet'],
  utility_bill: ['bill', 'invoice', 'provider', 'sonede', 'steg', 'water', 'electricity'],
  bill_payment: ['bill', 'payment', 'provider', 'reference', 'amount'],
  invoice: ['invoice', 'bill', 'reference', 'amount'],
  fees_notice: ['fees', 'fee', 'charges', 'june'],
  kyc_summary: ['customer', 'profile', 'kyc', 'summary'],
  appointment_confirmation: ['appointment', 'branch', 'confirmed', 'confirmation'],
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
  'payment_notice',
  'payment_resource',
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
    .replace(/[^a-z0-9\s.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeResourceType = (value = '') =>
  normalizeText(value).replace(/\s+/g, '_');

const tokenize = (value = '') =>
  normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));

const unique = (values) => Array.from(new Set(values.filter(Boolean)));

const isAllowedJsonResourceUrl = (urlValue) => {
  try {
    const parsed = new URL(urlValue);
    return (
      parsed.protocol === 'http:' &&
      parsed.host === 'localhost' &&
      parsed.pathname.startsWith('/atb-resources/json/') &&
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
    : catalogJson?.resources || catalogJson?.items || [];

  return items
    .map((item) => {
      if (typeof item === 'string') {
      return {
        fileName: item.split('/').pop(),
        url: item.startsWith('http') ? item : `${JSON_RESOURCE_BASE_URL}${item}`,
        metadata: null,
        };
      }

      const url = item.url || item.jsonUrl || item.resourceUrl;
      const fileName = item.fileName || item.name || (url ? url.split('/').pop() : null);

      return {
        fileName,
        url: url && url.startsWith('http') ? url : `${JSON_RESOURCE_BASE_URL}${fileName}`,
        metadata: item,
      };
    })
    .filter(
      (item) =>
        item.fileName &&
        item.fileName.endsWith('.json') &&
        isAllowedJsonResourceUrl(item.url),
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
    entries.map(async (entry) => ({
      ...entry,
      metadata: entry.metadata || (await fetchJson(entry.url).catch(() => null)),
    })),
  );
};

const loadResourceCatalog = async ({ forceRefresh = false } = {}) => {
  const now = Date.now();

  if (!forceRefresh && catalogCache && catalogCacheExpiresAt > now) {
    return catalogCache;
  }

  let catalog = [];

  try {
    catalog = await loadDirectoryCatalog();
  } catch {
    catalog = [];
  }

  if (!catalog.length) {
    try {
      catalog = await loadFallbackCatalog();
    } catch {
      catalog = [];
    }
  }

  catalogCache = catalog.filter((entry) => entry.metadata);
  catalogCacheExpiresAt = now + 60 * 1000;
  return catalogCache;
};

const metadataText = (entry) =>
  normalizeText(
    [
      entry.fileName,
      entry.metadata?.resourceId,
      entry.metadata?.resourceType,
      entry.metadata?.title,
      entry.metadata?.period,
      entry.metadata?.accountId,
      entry.metadata?.loanId,
      entry.metadata?.disputeId,
      entry.metadata?.reference,
      entry.metadata?.billReference,
      entry.metadata?.provider,
      entry.metadata?.amount,
      entry.metadata?.currency,
      entry.metadata?.dueDate,
      entry.metadata?.serviceType,
      entry.metadata?.category,
      entry.metadata?.beneficiaryName,
      entry.metadata?.holder,
      entry.metadata?.customerName,
      entry.metadata?.fullName,
      entry.metadata?.branch,
      entry.metadata?.status,
    ]
      .filter(Boolean)
      .join(' '),
  );

const detectRequestedResourceTypes = (messageText) => {
  const text = normalizeText(messageText);
  const requested = [];
  const hasBillProvider = BILL_PROVIDER_KEYWORDS.some((keyword) => text.includes(keyword));

  if (text.includes('statement') || text.includes('closing balance') || text.includes('balance movement')) {
    requested.push('account_statement');
  }
  if (text.includes('rib')) requested.push('rib_certificate');
  if (text.includes('loan')) requested.push('loan_schedule');
  if (text.includes('dispute') || (text.includes('card') && text.includes('status'))) {
    requested.push('card_dispute');
  }
  if (text.includes('transfer') && (text.includes('order') || text.includes('hiba'))) {
    requested.push('transfer_order');
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
  if (text.includes('profile') || text.includes('kyc')) requested.push('kyc_summary');
  if (text.includes('appointment') || (text.includes('branch') && text.includes('confirmed'))) {
    requested.push('appointment_confirmation');
  }
  if (text.includes('ownership certificate')) requested.push('account_certificate');

  return requested;
};

const isBillResourceType = (resourceType = '') =>
  BILL_RESOURCE_TYPES.has(normalizeResourceType(resourceType));

const scoreEntry = (entry, messageText) => {
  const queryTokens = tokenize(messageText);
  const entryText = metadataText(entry);
  const entryTokens = new Set(tokenize(entryText));
  const resourceType = normalizeResourceType(entry.metadata?.resourceType);
  const requestedTypes = detectRequestedResourceTypes(messageText);
  let score = 0;

  for (const token of queryTokens) {
    if (entryTokens.has(token)) score += 2;
    else if (entryText.includes(token)) score += 1;
  }

  if (requestedTypes.includes(resourceType)) score += 8;

  const billRequested = requestedTypes.includes('bill_notice');
  if (billRequested) {
    if (isBillResourceType(resourceType)) {
      score += 8;
    } else {
      score -= 10;
    }
  }

  for (const hint of RESOURCE_TYPE_HINTS[resourceType] || []) {
    if (queryTokens.includes(hint)) score += 1;
  }

  if (billRequested && isBillResourceType(resourceType)) {
    for (const provider of BILL_PROVIDER_KEYWORDS) {
      if (normalizeText(messageText).includes(provider)) {
        score += entryText.includes(provider) ? 5 : -2;
      }
    }
  }

  const normalizedMessage = normalizeText(messageText);
  for (const month of MONTHS) {
    if (normalizedMessage.includes(month)) {
      score += entryText.includes(month) ? 4 : -2;
    }
  }

  if (normalizedMessage.includes('current') && entryText.includes('current')) score += 4;
  if (normalizedMessage.includes('savings') && entryText.includes('savings')) score += 4;
  if (normalizedMessage.includes('hiba') && entryText.includes('hiba')) score += 5;
  if (normalizedMessage.includes('confirmed') && entryText.includes('confirmed')) score += 3;

  return score;
};

const findMatchingResource = async (messageText, options = {}) => {
  if (!messageText || typeof messageText !== 'string') {
    return null;
  }

  const catalog = await loadResourceCatalog(options);
  const scored = catalog
    .map((entry) => ({
      ...entry,
      score: scoreEntry(entry, messageText),
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  if (!best || best.score < MIN_MATCH_SCORE) {
    return null;
  }

  return {
    fileName: best.fileName,
    url: best.url,
    metadata: best.metadata,
    score: best.score,
  };
};

module.exports = {
  JSON_RESOURCE_BASE_URL,
  findMatchingResource,
  loadResourceCatalog,
};
