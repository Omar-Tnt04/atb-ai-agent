const axios = require('axios');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const env = require('../config/env');

const RESOURCE_SERVER_BASE_URL = env.resourceServerBaseUrl;
const RESOURCE_JSON_BASE_URL = env.resourceJsonBaseUrl;
const RESOURCE_DOCUMENT_BASE_URL = env.resourceDocumentBaseUrl;
const ALLOWED_RESOURCE_PREFIX = `${RESOURCE_SERVER_BASE_URL}/`;
const REQUEST_TIMEOUT_MS = 10000;
const TEXT_PREVIEW_LIMIT = 50000;
const PDF_MIN_READABLE_CHARS = Number(process.env.PDF_MIN_READABLE_CHARS || 20);

class ResourceResolverError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ResourceResolverError';
    this.statusCode = statusCode;
  }
}

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
  let allowedBase;
  try {
    parsed = new URL(urlValue);
    allowedBase = new URL(ALLOWED_RESOURCE_PREFIX);
  } catch {
    throw new ResourceResolverError('Invalid resource URL');
  }

  if (
    parsed.protocol !== allowedBase.protocol ||
    parsed.host !== allowedBase.host ||
    !parsed.pathname.startsWith(allowedBase.pathname) ||
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
  const resourceBase = new URL(ALLOWED_RESOURCE_PREFIX);
  const resourcePath = resourceBase.pathname.replace(/\/$/, '');

  if (trimmed.startsWith(`${resourcePath}/`)) {
    return assertAllowedResourceUrl(`${resourceBase.origin}${trimmed}`);
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

const isPdfFile = (fileUrl, contentType) => {
  const extension = path.extname(new URL(fileUrl).pathname).toLowerCase();
  return extension === '.pdf' || String(contentType || '').toLowerCase().includes('pdf');
};

const isTextFile = (fileUrl, contentType) => {
  const extension = path.extname(new URL(fileUrl).pathname).toLowerCase();
  const type = String(contentType || '').toLowerCase();
  return extension === '.txt' || extension === '.json' || type.startsWith('text/') || type.includes('json');
};

const isImageFile = (fileUrl, contentType) => {
  const extension = path.extname(new URL(fileUrl).pathname).toLowerCase();
  const type = String(contentType || '').toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff'].includes(extension) ||
    type.startsWith('image/');
};

const normalizeText = (value = '') =>
  String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const truncateText = (value = '') => {
  const text = normalizeText(value);
  return text.length > TEXT_PREVIEW_LIMIT
    ? `${text.slice(0, TEXT_PREVIEW_LIMIT)}\n[Content truncated for analysis]`
    : text;
};

const readableCharacterCount = (value = '') => {
  const matches = String(value || '').match(/[A-Za-z0-9]/g);
  return matches ? matches.length : 0;
};

const extractPdfText = async (fileBuffer) => {
  const parser = new PDFParse({ data: fileBuffer });
  try {
    const result = await parser.getText();
    return truncateText(result?.text || '');
  } finally {
    await parser.destroy().catch(() => {});
  }
};

const fetchTrustedResourceFile = async (fileUrl) => {
  console.log('[resource-resolver] trusted resource file URL validated');
  const response = await axios.get(fileUrl, {
    responseType: 'arraybuffer',
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: (status) => status >= 200 && status < 300,
  });
  const contentType = String(response.headers['content-type'] || '').split(';')[0];
  const fileBuffer = Buffer.from(response.data);

  if (isTextFile(fileUrl, contentType)) {
    const fileText = truncateText(fileBuffer.toString('utf8'));
    console.log('[resource-resolver] text bytes fetched:', {
      contentType,
      byteCount: fileBuffer.length,
      charCount: fileText.length,
    });
    return {
      contentType,
      fileText,
      fileTextPreview: '',
      fileSize: fileBuffer.length,
      resourceFileType: path.extname(new URL(fileUrl).pathname).toLowerCase() === '.json' ? 'json' : 'txt',
      needsVision: false,
      extractionStatus: fileText ? 'extracted' : 'empty_text',
    };
  }

  if (isImageFile(fileUrl, contentType)) {
    console.log('[resource-resolver] image bytes fetched:', {
      contentType,
      byteCount: fileBuffer.length,
    });
    return {
      contentType,
      fileBuffer,
      fileSize: fileBuffer.length,
      resourceFileType: 'image',
      needsVision: true,
      extractionStatus: 'visual_ready_for_vision',
    };
  }

  if (!isPdfFile(fileUrl, contentType)) {
    console.log('[resource-resolver] extractionStatus:', 'unsupported_file_type');
    return {
      contentType,
      resourceFileType: 'unsupported',
      needsVision: false,
      extractionStatus: 'unsupported_file_type',
    };
  }

  let fileText = '';
  let textExtractionError = null;
  try {
    fileText = await extractPdfText(fileBuffer);
  } catch (error) {
    textExtractionError = error.message || 'PDF text extraction failed';
  }
  const readableChars = readableCharacterCount(fileText);
  if (readableChars >= PDF_MIN_READABLE_CHARS) {
    console.log('[resource-resolver] PDF text extracted:', {
      contentType,
      byteCount: fileBuffer.length,
      charCount: fileText.length,
      readableChars,
    });
    return {
      contentType,
      fileText,
      fileTextPreview: '',
      fileSize: fileBuffer.length,
      resourceFileType: 'pdf',
      needsVision: false,
      extractionStatus: 'extracted',
    };
  }

  console.log('[resource-resolver] PDF bytes fetched:', {
    contentType,
    byteCount: fileBuffer.length,
    readableChars,
  });

  return {
    contentType,
    fileBuffer,
    fileSize: fileBuffer.length,
    resourceFileType: 'pdf',
    needsVision: true,
    extractionStatus: 'pdf_ready_for_vision',
    ...(textExtractionError ? { extractionError: textExtractionError } : {}),
  };
};

const resolveResourcePayload = async (resourceJson, resourceUrl = null) => {
  const rawFileUrl = findFileUrl(resourceJson);

  if (!rawFileUrl) {
    console.log('[resource-resolver] extractionStatus:', 'no_file_url');
    return {
      resourceJson,
      fileUrl: null,
      contentType: null,
      extractionStatus: 'no_file_url',
    };
  }

  let fileUrl;
  try {
    fileUrl = resolveFileUrl(rawFileUrl);
  } catch {
    console.log('[resource-resolver] blocked untrusted resource file URL');
    console.log('[resource-resolver] extractionStatus:', 'blocked_url');
    return {
      resourceJson,
      fileUrl: rawFileUrl,
      contentType: null,
      extractionStatus: 'blocked_url',
    };
  }

  try {
    const fileResult = await fetchTrustedResourceFile(fileUrl);
    console.log('[resource-resolver] extractionStatus:', fileResult.extractionStatus);
    return {
      resourceJson,
      fileUrl,
      ...fileResult,
    };
  } catch (error) {
    console.log('[resource-resolver] extractionStatus:', 'failed');
    return {
      resourceJson,
      fileUrl,
      contentType: null,
      extractionStatus: 'failed',
      extractionError: error.message || 'File fetch or extraction failed',
    };
  }
};

const resolveResource = async (jsonResourceUrl) => {
  const resourceUrl = assertAllowedResourceUrl(jsonResourceUrl);
  const resourceJson = await fetchJsonResource(resourceUrl);
  return resolveResourcePayload(resourceJson, resourceUrl);
};

module.exports = {
  ALLOWED_RESOURCE_PREFIX,
  RESOURCE_DOCUMENT_BASE_URL,
  RESOURCE_JSON_BASE_URL,
  RESOURCE_SERVER_BASE_URL,
  ResourceResolverError,
  resolveResource,
  resolveResourcePayload,
};
