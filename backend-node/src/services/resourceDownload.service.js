const crypto = require('crypto');
const path = require('path');
const axios = require('axios');
const env = require('../config/env');
const { logAgentStep } = require('./agentLogger.service');

const RESOURCE_SERVER_BASE_URL = env.resourceServerBaseUrl;
const ALLOWED_RESOURCE_PREFIX = `${RESOURCE_SERVER_BASE_URL}/`;
const DOWNLOAD_TTL_MS = 15 * 60 * 1000;
const downloads = new Map();

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
  return null;
};

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
  const isTrusted =
    parsed.protocol === allowedBase.protocol &&
    parsed.host === allowedBase.host &&
    parsed.pathname.startsWith(allowedBase.pathname) &&
    parsed.href.startsWith(ALLOWED_RESOURCE_PREFIX) &&
    Boolean(contentType) &&
    !hasTraversalSegment(parsed);

  if (!isTrusted) {
    throw new Error('Untrusted document URL');
  }

  return {
    href: parsed.href,
    contentType,
  };
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
  const safeFileName = path
    .basename(fileName || new URL(trusted.href).pathname)
    .replace(/[^a-z0-9._-]/gi, '_') || 'document';
  const extension = path.extname(new URL(trusted.href).pathname).toLowerCase();

  downloads.set(id, {
    fileUrl: trusted.href,
    fileName: path.extname(safeFileName) ? safeFileName : `${safeFileName}${extension}`,
    contentType: trusted.contentType,
    expiresAt: Date.now() + DOWNLOAD_TTL_MS,
  });

  return {
    id,
    downloadUrl: `/resources/download/${id}`,
  };
};

const getResourceDownload = (id) => {
  cleanupExpiredDownloads();
  return downloads.get(id) || null;
};

const logDownloadAttempt = ({ id, fileUrl = null, success, reason = null }) => {
  const payload = {
    downloadId: id,
    fileUrl,
    success,
    reason,
  };
  console.log('[resource-download] request:', payload);
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

  let response;
  try {
    response = await axios.get(download.fileUrl, {
      responseType: 'stream',
      timeout: 10000,
      validateStatus: (status) => status >= 200 && status < 300,
    });
  } catch (error) {
    logDownloadAttempt({
      id,
      fileUrl: download.fileUrl,
      success: false,
      reason: error.response?.status === 404
        ? 'source_file_not_found'
        : error.message || 'source_file_fetch_failed',
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
  return response.data.pipe(res);
};

module.exports = {
  createResourceDownload,
  streamResourceDownload,
};
