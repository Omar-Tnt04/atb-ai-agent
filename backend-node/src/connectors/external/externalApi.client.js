const axios = require('axios');

const {
  isPlaceholder,
} = require('./externalService.config');

const normalizeExternalError = (error) => {
  if (error.code === 'ECONNABORTED') {
    return 'External service timeout';
  }

  if (error.response?.status) {
    return `External service returned HTTP ${error.response.status}`;
  }

  return 'External service unavailable';
};

const createExternalApiClient = ({ baseURL, apiKey, timeout }) => {
  const headers = {};

  if (apiKey && !isPlaceholder(apiKey)) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return axios.create({
    baseURL,
    headers,
    timeout,
  });
};

const safeExternalRequest = async ({ config, method, path, data }) => {
  if (!config.enabled) {
    return {
      success: false,
      shouldFallback: true,
      fallbackReason: 'External service disabled',
    };
  }

  if (isPlaceholder(config.baseURL)) {
    return {
      success: false,
      shouldFallback: true,
      fallbackReason: 'External service not configured',
    };
  }

  try {
    const client = createExternalApiClient(config);
    const response = await client.request({
      method,
      url: path,
      data,
    });

    return {
      success: true,
      data: response.data?.data ?? response.data,
    };
  } catch (error) {
    return {
      success: false,
      shouldFallback: true,
      fallbackReason: normalizeExternalError(error),
    };
  }
};

module.exports = {
  createExternalApiClient,
  safeExternalRequest,
};
