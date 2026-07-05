const {
  debugResourceCatalogMatch,
  ResourceCatalogUnavailableError,
} = require('../services/resourceCatalog.service');
const {
  ResourceResolverError,
  resolveResource,
} = require('../services/resourceResolver.service');
const {
  streamResourceDownload,
  streamResourceView,
} = require('../services/resourceDownload.service');
const { logAgentStep } = require('../services/agentLogger.service');

const TEXT_PREVIEW_LIMIT = 2000;

const buildPreview = (value = '') => {
  if (!value || value.length <= TEXT_PREVIEW_LIMIT) {
    return value || '';
  }

  return `${value.slice(0, TEXT_PREVIEW_LIMIT)}\n[Preview truncated]`;
};

const withoutInternalPdfPayload = (resolved) => {
  const { fileBuffer, pdfBase64, ...safeResolved } = resolved;
  void fileBuffer;
  void pdfBase64;
  return safeResolved;
};

const resolveResourceUrl = async (req, res) => {
  const { url } = req.query;

  try {
    const resolved = await resolveResource(url);

    return res.json({
      success: true,
      data: {
        ...withoutInternalPdfPayload(resolved),
        fileTextPreview: buildPreview(resolved.fileText || ''),
      },
    });
  } catch (error) {
    const statusCode =
      error instanceof ResourceResolverError ? error.statusCode : 502;

    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Resource resolution failed',
    });
  }
};

const debugCatalogMatch = async (req, res) => {
  const { q = '' } = req.query;

  try {
    const debug = await debugResourceCatalogMatch(q, { limit: 8 });
    return res.json({
      success: true,
      data: debug,
    });
  } catch (error) {
    const statusCode = error instanceof ResourceCatalogUnavailableError ? 503 : 502;
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Resource catalog debug failed',
    });
  }
};

const downloadApprovedResource = async (req, res) => {
  const { downloadId } = req.params;

  if (!/^[a-f0-9]{32}$/.test(downloadId)) {
    const payload = {
      downloadId,
      fileUrl: null,
      success: false,
      reason: 'invalid_download_id',
    };
    console.log('[resource-download] request:', payload);
    logAgentStep(null, 'resource_download_requested', payload);
    return res.status(404).json({ success: false, message: 'Download not found' });
  }

  try {
    return await streamResourceDownload(downloadId, res);
  } catch (error) {
    const payload = {
      downloadId,
      fileUrl: null,
      success: false,
      reason: error.message || 'resource_download_failed',
    };
    console.log('[resource-download] request:', payload);
    logAgentStep(null, 'resource_download_requested', payload);
    return res.status(404).json({ success: false, message: 'Download not found' });
  }
};

const viewApprovedResource = async (req, res) => {
  const { viewId } = req.params;

  if (!/^[a-f0-9]{32}$/.test(viewId)) {
    const payload = {
      downloadId: viewId,
      fileUrl: null,
      success: false,
      reason: 'invalid_view_id',
    };
    console.log('[resource-download] request:', payload);
    logAgentStep(null, 'resource_download_requested', payload);
    return res.status(404).json({ success: false, message: 'Image not found' });
  }

  try {
    return await streamResourceView(viewId, res);
  } catch (error) {
    const payload = {
      downloadId: viewId,
      fileUrl: null,
      success: false,
      reason: error.message || 'resource_view_failed',
    };
    console.log('[resource-download] request:', payload);
    logAgentStep(null, 'resource_download_requested', payload);
    return res.status(404).json({ success: false, message: 'Image not found' });
  }
};

module.exports = {
  debugCatalogMatch,
  downloadApprovedResource,
  resolveResourceUrl,
  viewApprovedResource,
};
