const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const env = require('../config/env');
const { logAgentStep } = require('./agentLogger.service');

const RESOURCE_SERVER_BASE_URL = env.resourceServerBaseUrl;
const RESOURCE_ROOT_DIR = env.resourceRootDir;
const ALLOWED_RESOURCE_PREFIX = `${RESOURCE_SERVER_BASE_URL}/`;
const DOWNLOAD_TTL_MS = 15 * 60 * 1000;
const downloads = new Map();
const ALLOWED_RESOURCE_FOLDERS = new Set(['documents', 'images']);
const ALLOWED_RESOURCE_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg']);

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

const contentTypeForExtension = (urlValue = '') => {
  const extension = path.extname(new URL(urlValue).pathname).toLowerCase();
  if (extension === '.pdf') return 'application/pdf';
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  return null;
};

const isPdfContentType = (contentType = '') =>
  String(contentType || '').toLowerCase() === 'application/pdf';

const isImageContentType = (contentType = '') =>
  String(contentType || '').toLowerCase().startsWith('image/');

const assertTrustedDownloadUrl = (urlValue) => {
  let parsed;
  let allowedBase;
  try {
    parsed = new URL(urlValue);
    allowedBase = new URL(ALLOWED_RESOURCE_PREFIX);
  } catch {
    throw new Error('Invalid document URL');
  }

  const contentType = contentTypeForExtension(parsed.href);
  const allowedPath = allowedBase.pathname.replace(/\/$/, '');
  const relativePath = parsed.pathname.slice(allowedPath.length).replace(/^\/+/, '');
  const segments = relativePath.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  const [folder, fileName] = segments;
  const extension = path.extname(fileName || '').toLowerCase();
  const isTrusted =
    parsed.protocol === allowedBase.protocol &&
    parsed.host === allowedBase.host &&
    parsed.pathname.startsWith(`${allowedPath}/`) &&
    parsed.href.startsWith(ALLOWED_RESOURCE_PREFIX) &&
    Boolean(contentType) &&
    isPdfContentType(contentType) &&
    segments.length === 2 &&
    folder === 'documents' &&
    ALLOWED_RESOURCE_EXTENSIONS.has(extension) &&
    !hasTraversalSegment(parsed);

  if (!isTrusted) {
    throw new Error('Untrusted document URL');
  }

  return {
    href: parsed.href,
    contentType,
    folder,
    fileName,
  };
};

const assertTrustedViewUrl = (urlValue) => {
  let parsed;
  let allowedBase;
  try {
    parsed = new URL(urlValue);
    allowedBase = new URL(ALLOWED_RESOURCE_PREFIX);
  } catch {
    throw new Error('Invalid image URL');
  }

  const contentType = contentTypeForExtension(parsed.href);
  const allowedPath = allowedBase.pathname.replace(/\/$/, '');
  const relativePath = parsed.pathname.slice(allowedPath.length).replace(/^\/+/, '');
  const segments = relativePath.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  const [folder, fileName] = segments;
  const extension = path.extname(fileName || '').toLowerCase();
  const isTrusted =
    parsed.protocol === allowedBase.protocol &&
    parsed.host === allowedBase.host &&
    parsed.pathname.startsWith(`${allowedPath}/`) &&
    parsed.href.startsWith(ALLOWED_RESOURCE_PREFIX) &&
    Boolean(contentType) &&
    isImageContentType(contentType) &&
    segments.length === 2 &&
    folder === 'images' &&
    ALLOWED_RESOURCE_FOLDERS.has(folder) &&
    ALLOWED_RESOURCE_EXTENSIONS.has(extension) &&
    !hasTraversalSegment(parsed);

  if (!isTrusted) {
    throw new Error('Untrusted image URL');
  }

  return {
    href: parsed.href,
    contentType,
    folder,
    fileName,
  };
};

const resolveTrustedResourcePath = ({ folder, fileName }) => {
  const resolvedRoot = path.resolve(RESOURCE_ROOT_DIR);
  const resolvedFile = path.resolve(resolvedRoot, folder, fileName);
  if (
    !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`) ||
    path.dirname(resolvedFile) !== path.resolve(resolvedRoot, folder)
  ) {
    throw new Error('Invalid resource file path');
  }
  return resolvedFile;
};

const cleanupExpiredDownloads = () => {
  const now = Date.now();
  for (const [id, item] of downloads.entries()) {
    if (item.expiresAt <= now) {
      downloads.delete(id);
    }
  }
};

const createResourceDownload = ({ fileUrl, fileName }) => {
  const trusted = assertTrustedDownloadUrl(fileUrl);
  cleanupExpiredDownloads();

  const id = crypto.randomBytes(16).toString('hex');
  const sourceName = new URL(trusted.href).pathname;
  const safeFileName = path
    .basename(fileName || sourceName)
    .replace(/[^a-z0-9._-]/gi, '_') || 'document';
  const extension = path.extname(sourceName).toLowerCase();

  downloads.set(id, {
    fileUrl: trusted.href,
    filePath: resolveTrustedResourcePath(trusted),
    fileName: path.extname(safeFileName) ? safeFileName : `${safeFileName}${extension}`,
    contentType: trusted.contentType,
    expiresAt: Date.now() + DOWNLOAD_TTL_MS,
  });

  return {
    id,
    downloadUrl: `/resources/download/${id}`,
  };
};

const createResourceView = ({ fileUrl, fileName }) => {
  const trusted = assertTrustedViewUrl(fileUrl);
  cleanupExpiredDownloads();

  const id = crypto.randomBytes(16).toString('hex');
  const sourceName = new URL(trusted.href).pathname;
  const safeFileName = path
    .basename(fileName || sourceName)
    .replace(/[^a-z0-9._-]/gi, '_') || 'image';

  downloads.set(id, {
    fileUrl: trusted.href,
    filePath: resolveTrustedResourcePath(trusted),
    fileName: safeFileName,
    contentType: trusted.contentType,
    expiresAt: Date.now() + DOWNLOAD_TTL_MS,
  });

  return {
    id,
    viewUrl: `/resources/view/${id}`,
  };
};

const getResourceDownload = (id) => {
  cleanupExpiredDownloads();
  return downloads.get(id) || null;
};

const logDownloadAttempt = ({ id, fileUrl = null, success, reason = null }) => {
  const payload = {
    downloadId: id,
    hasFileUrl: Boolean(fileUrl),
    success,
    reason,
  };
  if (!success || env.debugResourceSearch) {
    console.log('[resource-download] request:', payload);
  }
  logAgentStep(null, 'resource_download_requested', payload);
};

const streamResourceDownload = async (id, res) => {
  const download = getResourceDownload(id);
  if (!download) {
    logDownloadAttempt({
      id,
      success: false,
      reason: 'download_id_not_found_or_expired',
    });
    return res.status(404).json({ success: false, message: 'Download not found' });
  }

  try {
    await fs.promises.access(download.filePath, fs.constants.R_OK);
  } catch (error) {
    logDownloadAttempt({
      id,
      fileUrl: download.fileUrl,
      success: false,
      reason: error.code === 'ENOENT'
        ? 'source_file_not_found'
        : error.message || 'source_file_access_failed',
    });
    return res.status(404).json({ success: false, message: 'Download not found' });
  }

  res.setHeader('Content-Type', download.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${download.fileName}"`);
  logDownloadAttempt({
    id,
    fileUrl: download.fileUrl,
    success: true,
  });
  return fs.createReadStream(download.filePath).pipe(res);
};

const streamResourceView = async (id, res) => {
  const download = getResourceDownload(id);
  if (!download || !isImageContentType(download.contentType)) {
    logDownloadAttempt({
      id,
      success: false,
      reason: 'view_id_not_found_or_expired',
    });
    return res.status(404).json({ success: false, message: 'Image not found' });
  }

  res.setHeader('Content-Type', download.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${download.fileName}"`);

  try {
    await fs.promises.access(download.filePath, fs.constants.R_OK);
  } catch (error) {
    logDownloadAttempt({
      id,
      fileUrl: download.fileUrl,
      success: false,
      reason: error.code === 'ENOENT'
        ? 'source_file_not_found'
        : error.message || 'source_file_access_failed',
    });
    return res.status(404).json({ success: false, message: 'Image not found' });
  }

  logDownloadAttempt({
    id,
    fileUrl: download.fileUrl,
    success: true,
  });
  return fs.createReadStream(download.filePath).pipe(res);
};

module.exports = {
  createResourceDownload,
  createResourceView,
  streamResourceDownload,
  streamResourceView,
};
