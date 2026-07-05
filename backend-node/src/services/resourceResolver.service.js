const fs = require('fs/promises');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const env = require('../config/env');
const { selectCatalogFile } = require('./resourceCatalog.service');

const RESOURCE_SERVER_BASE_URL = env.resourceServerBaseUrl;
const RESOURCE_JSON_BASE_URL = env.resourceJsonBaseUrl;
const RESOURCE_DOCUMENT_BASE_URL = env.resourceDocumentBaseUrl;
const RESOURCE_ROOT_DIR = env.resourceRootDir;
const ALLOWED_RESOURCE_PREFIX = `${RESOURCE_SERVER_BASE_URL}/`;
const TEXT_PREVIEW_LIMIT = 50000;
const PDF_MIN_READABLE_CHARS = Number(process.env.PDF_MIN_READABLE_CHARS || 20);
const ALLOWED_RESOURCE_FOLDERS = new Set(['documents', 'json', 'txt', 'images']);
const ALLOWED_RESOURCE_EXTENSIONS = new Set(['.pdf', '.json', '.txt', '.png', '.jpg', '.jpeg']);

// Verbose resolver tracing is opt-in (DEBUG_RESOURCE_SEARCH=true). In normal mode only
// compact errors are logged — never URLs, file contents, OCR text, or base64.
const debugLog = (...args) => {
  if (env.debugResourceSearch) console.log(...args);
};

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

  const allowedPath = allowedBase.pathname.replace(/\/$/, '');
  const relativePath = parsed.pathname.slice(allowedPath.length).replace(/^\/+/, '');
  const segments = relativePath.split('/').filter(Boolean);
  const decodedSegments = segments.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  const [folder, fileName] = decodedSegments;
  const extension = path.extname(fileName || '').toLowerCase();

  if (
    parsed.protocol !== allowedBase.protocol ||
    parsed.host !== allowedBase.host ||
    !parsed.pathname.startsWith(`${allowedPath}/`) ||
    !parsed.href.startsWith(ALLOWED_RESOURCE_PREFIX) ||
    hasTraversalSegment(parsed) ||
    segments.length !== 2 ||
    !ALLOWED_RESOURCE_FOLDERS.has(folder) ||
    !ALLOWED_RESOURCE_EXTENSIONS.has(extension) ||
    path.isAbsolute(folder || '') ||
    path.isAbsolute(fileName || '') ||
    String(fileName || '').includes('/') ||
    String(fileName || '').includes('\\')
  ) {
    throw new ResourceResolverError(
      `Only ${ALLOWED_RESOURCE_PREFIX} URLs are allowed`,
    );
  }

  return {
    href: parsed.href,
    folder,
    fileName,
  };
};

const resolveFileUrl = (fileUrl) => {
  if (!fileUrl || typeof fileUrl !== 'string') {
    return null;
  }

  const trimmed = fileUrl.trim();
  if (
    trimmed.startsWith('documents/') ||
    trimmed.startsWith('json/') ||
    trimmed.startsWith('txt/') ||
    trimmed.startsWith('images/')
  ) {
    return assertAllowedResourceUrl(`${ALLOWED_RESOURCE_PREFIX}${trimmed}`);
  }

  return assertAllowedResourceUrl(trimmed);
};

const resolveTrustedResourcePath = ({ folder, fileName }) => {
  const resolvedRoot = path.resolve(RESOURCE_ROOT_DIR);
  const resolvedFile = path.resolve(resolvedRoot, folder, fileName);
  if (
    !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`) ||
    path.dirname(resolvedFile) !== path.resolve(resolvedRoot, folder)
  ) {
    throw new ResourceResolverError('Invalid resource file path');
  }
  return resolvedFile;
};

const findSelectedCatalogFileUrl = (resourceJson = {}, options = {}) => {
  if (!Array.isArray(resourceJson.files) || !resourceJson.files.length) {
    return null;
  }

  const selectedFile = selectCatalogFile(resourceJson.files, {
    messageText: options.messageText || '',
  });
  return selectedFile?.fileUrl || null;
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

const contentTypeForPath = (filePath = '') => {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.pdf') return 'application/pdf';
  if (extension === '.json') return 'application/json';
  if (extension === '.txt') return 'text/plain';
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
};

const fetchJsonResource = async (resourceUrl) => {
  const trusted = assertAllowedResourceUrl(resourceUrl);
  const resourcePath = resolveTrustedResourcePath(trusted);
  const raw = await fs.readFile(resourcePath, 'utf8');
  return JSON.parse(raw);
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

// Fetches the actual resource file from RESOURCE_ROOT_DIR only. The public URL is validated
// against RESOURCE_BASE_URL first, then translated to <RESOURCE_ROOT_DIR>/<folder>/<fileName>.
const fetchTrustedResourceFile = async (fileUrl) => {
  debugLog('[resource-resolver] trusted resource file URL validated');
  const trusted = assertAllowedResourceUrl(fileUrl);
  const resourcePath = resolveTrustedResourcePath(trusted);
  const fileBuffer = await fs.readFile(resourcePath);
  const contentType = contentTypeForPath(resourcePath);

  if (isTextFile(fileUrl, contentType)) {
    const fileText = truncateText(fileBuffer.toString('utf8'));
    let resourceJsonData = null;
    if (path.extname(new URL(fileUrl).pathname).toLowerCase() === '.json') {
      try {
        const parsed = JSON.parse(fileText);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          resourceJsonData = parsed;
        }
      } catch {
        resourceJsonData = null;
      }
    }
    debugLog('[resource-resolver] text bytes fetched:', {
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
      ...(resourceJsonData ? { resourceJsonData } : {}),
    };
  }

  if (isImageFile(fileUrl, contentType)) {
    debugLog('[resource-resolver] image bytes fetched:', {
      contentType,
      byteCount: fileBuffer.length,
    });
    return {
      contentType,
      fileBuffer,
      fileSize: fileBuffer.length,
      resourceFileType: 'image',
      needsVision: false,
      needsOcr: true,
      extractionStatus: 'image_ready_for_ocr',
    };
  }

  if (!isPdfFile(fileUrl, contentType)) {
    debugLog('[resource-resolver] extractionStatus:', 'unsupported_file_type');
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
    debugLog('[resource-resolver] PDF text extracted:', {
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

  debugLog('[resource-resolver] PDF bytes fetched:', {
    contentType,
    byteCount: fileBuffer.length,
    readableChars,
  });

  return {
    contentType,
    fileText,
    fileSize: fileBuffer.length,
    resourceFileType: 'pdf',
    needsVision: false,
    extractionStatus: textExtractionError ? 'pdf_text_extraction_failed' : 'empty_text',
    ...(textExtractionError ? { extractionError: textExtractionError } : {}),
  };
};

// Resolves a resource's actual file strictly from the Laragon resource server. There is no local
// disk fallback: an untrusted/unreachable URL returns a status marker, never a locally read file.
const resolveResourcePayload = async (resourceJson, resourceUrl = null, options = {}) => {
  const rawFileUrl = findSelectedCatalogFileUrl(resourceJson, options) || findFileUrl(resourceJson);

  if (!rawFileUrl) {
    debugLog('[resource-resolver] extractionStatus:', 'no_file_url');
    return {
      resourceJson,
      fileUrl: null,
      contentType: 'application/json',
      resourceFileType: 'json',
      needsVision: false,
      extractionStatus: 'metadata_only',
    };
  }

  let fileUrl;
  try {
    fileUrl = resolveFileUrl(rawFileUrl);
  } catch {
    debugLog('[resource-resolver] blocked untrusted resource file URL');
    debugLog('[resource-resolver] extractionStatus:', 'blocked_url');
    return {
      resourceJson,
      fileUrl: rawFileUrl,
      contentType: null,
      extractionStatus: 'blocked_url',
    };
  }

  try {
    const fileResult = await fetchTrustedResourceFile(fileUrl.href);
    debugLog('[resource-resolver] extractionStatus:', fileResult.extractionStatus);
    const resolvedResourceJson = fileResult.resourceJsonData
      ? {
          ...resourceJson,
          ...fileResult.resourceJsonData,
          files: resourceJson.files,
          routingPolicy: resourceJson.routingPolicy,
          ...(fileResult.resourceFileType ? { resourceFileType: fileResult.resourceFileType } : {}),
        }
      : resourceJson;
    return {
      resourceJson: resolvedResourceJson,
      fileUrl: fileUrl.href,
      ...fileResult,
      resourceJsonData: undefined,
    };
  } catch (error) {
    console.error('[resource-resolver] resource fetch failed:', error.message || 'unknown error');
    return {
      resourceJson,
      fileUrl: fileUrl.href,
      contentType: null,
      extractionStatus: 'failed',
      extractionError: error.message || 'File fetch or extraction failed',
    };
  }
};

const resolveResource = async (jsonResourceUrl) => {
  const trusted = assertAllowedResourceUrl(jsonResourceUrl);
  const resourceJson = await fetchJsonResource(trusted.href);
  return resolveResourcePayload(resourceJson, trusted.href);
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
