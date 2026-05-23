const {
  ResourceResolverError,
  resolveResource,
} = require('../services/resourceResolver.service');

const TEXT_PREVIEW_LIMIT = 2000;

const buildPreview = (value = '') => {
  if (!value || value.length <= TEXT_PREVIEW_LIMIT) {
    return value || '';
  }

  return `${value.slice(0, TEXT_PREVIEW_LIMIT)}\n[Preview truncated]`;
};

const resolveResourceUrl = async (req, res) => {
  const { url } = req.query;

  try {
    const resolved = await resolveResource(url);

    return res.json({
      success: true,
      data: {
        ...resolved,
        fileTextPreview: buildPreview(resolved.fileText),
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

module.exports = {
  resolveResourceUrl,
};
