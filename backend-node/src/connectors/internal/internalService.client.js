const axios = require('axios');

const { getInternalServiceConfig } = require('./internalService.config');

const SERVICE_UNAVAILABLE_MESSAGE =
  'The internal service is currently unavailable.';

// Calls a separate internal demo service over HTTP. There is no mock/sandbox
// fallback: if the service is disabled, offline, or unreachable we return a
// clean service_unavailable result so the action path can audit and surface it.
const callInternalService = async ({ serviceName, method, path, data }) => {
  const config = getInternalServiceConfig(serviceName);

  if (!config.enabled || !config.baseURL) {
    return {
      success: false,
      status: 'service_unavailable',
      message: SERVICE_UNAVAILABLE_MESSAGE,
      serviceName,
    };
  }

  try {
    const response = await axios.request({
      baseURL: config.baseURL,
      url: path,
      method,
      data,
      timeout: config.timeout,
    });

    if (response.data && response.data.success === false) {
      return {
        success: false,
        status: 'service_error',
        message: SERVICE_UNAVAILABLE_MESSAGE,
        serviceName,
      };
    }

    return {
      success: true,
      data: response.data,
      serviceName,
      source: 'internal_demo_service',
      fallbackUsed: false,
    };
  } catch (error) {
    // A reachable service that returns 404 is a real "not found", not an outage.
    if (error.response?.status === 404) {
      return {
        success: false,
        status: 'not_found',
        message: error.response.data?.error || 'Resource not found',
        serviceName,
      };
    }

    return {
      success: false,
      status: 'service_unavailable',
      message: SERVICE_UNAVAILABLE_MESSAGE,
      serviceName,
    };
  }
};

module.exports = {
  SERVICE_UNAVAILABLE_MESSAGE,
  callInternalService,
};
