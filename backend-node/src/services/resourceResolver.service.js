const axios = require('axios');
const path = require('path');
const { PDFParse } = require('pdf-parse');

const ALLOWED_RESOURCE_PREFIX = 'http://localhost/atb-resources/';
const REQUEST_TIMEOUT_MS = 10000;
const TEXT_LIMIT = 120000;

class ResourceResolverError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ResourceResolverError';
    this.statusCode = statusCode;
  }
}

const truncate = (value = '', limit = TEXT_LIMIT) => {
  if (!value || value.length <= limit) {
    return value || '';
  }

  return `${value.slice(0, limit)}\n[Content truncated]`;
};

const normalizeText = (value = '') =>
  String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const hasReadableText = (value = '') => /[A-Za-z0-9]/.test(value);

const hasTraversalSegment = (url) =>
  url.pathname
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .includes('..');

const assertAllowedResourceUrl = (urlValue) => {
  if (!urlValue || typeof urlValue !== 'string') {
    throw new ResourceResolverError('A resource URL is required');
  }

  let parsed;
  try {
    parsed = new URL(urlValue);
  } catch {
    throw new ResourceResolverError('Invalid resource URL');
  }

  if (
    parsed.protocol !== 'http:' ||
    parsed.host !== 'localhost' ||
    !parsed.pathname.startsWith('/atb-resources/') ||
    !parsed.href.startsWith(ALLOWED_RESOURCE_PREFIX) ||
    hasTraversalSegment(parsed)
  ) {
    throw new ResourceResolverError(
      `Only ${ALLOWED_RESOURCE_PREFIX} URLs are allowed`,
    );
  }

  return parsed.href;
};

const resolveFileUrl = (fileUrl) => {
  if (!fileUrl || typeof fileUrl !== 'string') {
    return null;
  }

  const trimmed = fileUrl.trim();

  if (trimmed.startsWith('/atb-resources/')) {
    return assertAllowedResourceUrl(`http://localhost${trimmed}`);
  }

  if (trimmed.startsWith('documents/') || trimmed.startsWith('json/')) {
    return assertAllowedResourceUrl(`${ALLOWED_RESOURCE_PREFIX}${trimmed}`);
  }

  return assertAllowedResourceUrl(trimmed);
};

const findFileUrl = (value) => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (typeof value.fileUrl === 'string' && value.fileUrl.trim()) {
    return value.fileUrl.trim();
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nestedFileUrl = findFileUrl(item);
      if (nestedFileUrl) return nestedFileUrl;
    }
    return null;
  }

  for (const item of Object.values(value)) {
    const nestedFileUrl = findFileUrl(item);
    if (nestedFileUrl) return nestedFileUrl;
  }

  return null;
};

const fetchJsonResource = async (resourceUrl) => {
  const response = await axios.get(resourceUrl, {
    responseType: 'json',
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: (status) => status >= 200 && status < 300,
  });

  return response.data;
};

const extractPdfText = async (buffer) => {
  const parser = new PDFParse({ data: buffer });

  try {
    const result = await parser.getText();
    return normalizeText(truncate(result.text || ''));
  } finally {
    await parser.destroy();
  }
};

const isPdfFile = (fileUrl, contentType) => {
  const extension = path.extname(new URL(fileUrl).pathname).toLowerCase();
  return extension === '.pdf' || String(contentType || '').toLowerCase().includes('pdf');
};

const fetchAndExtractFile = async (fileUrl) => {
  const response = await axios.get(fileUrl, {
    responseType: 'arraybuffer',
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: (status) => status >= 200 && status < 300,
  });
  const contentType = String(response.headers['content-type'] || '').split(';')[0];

  if (!isPdfFile(fileUrl, contentType)) {
    return {
      contentType,
      fileText: '',
      extractionStatus: 'unsupported_file_type',
    };
  }

  const fileText = await extractPdfText(Buffer.from(response.data));

  return {
    contentType,
    fileText,
    extractionStatus: hasReadableText(fileText) ? 'extracted' : 'empty',
  };
};

const resolveResource = async (jsonResourceUrl) => {
  const resourceUrl = assertAllowedResourceUrl(jsonResourceUrl);
  const resourceJson = await fetchJsonResource(resourceUrl);
  const rawFileUrl = findFileUrl(resourceJson);

  if (!rawFileUrl) {
    return {
      resourceJson,
      fileUrl: null,
      fileText: '',
      contentType: null,
      extractionStatus: 'no_file_url',
    };
  }

  let fileUrl;
  try {
    fileUrl = resolveFileUrl(rawFileUrl);
  } catch {
    return {
      resourceJson,
      fileUrl: rawFileUrl,
      fileText: '',
      contentType: null,
      extractionStatus: 'blocked_url',
    };
  }

  try {
    const fileResult = await fetchAndExtractFile(fileUrl);
    return {
      resourceJson,
      fileUrl,
      ...fileResult,
    };
  } catch (error) {
    return {
      resourceJson,
      fileUrl,
      fileText: '',
      contentType: null,
      extractionStatus: 'failed',
      extractionError: error.message || 'File fetch or extraction failed',
    };
  }
};

module.exports = {
  ALLOWED_RESOURCE_PREFIX,
  ResourceResolverError,
  resolveResource,
};
