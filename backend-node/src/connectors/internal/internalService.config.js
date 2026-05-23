const axios = require('axios');

// Configuration for the separate internal demo services. These simulate ATB
// internal applications. In production the base URLs are replaced by the real
// ATB internal APIs without changing the connector layer above them.
const SERVICE_DEFAULTS = {
  payment: { port: 7101 },
  document: { port: 7102 },
  atb: { port: 7106 },
  appointment: { port: 7104 },
  account: { port: 7105 },
};

const INTERNAL_TIMEOUT_MS = Number(process.env.INTERNAL_SERVICE_TIMEOUT_MS || 5000);

const isEnabled = (value) => String(value).toLowerCase() === 'true';

const getInternalServiceConfig = (serviceName) => {
  const prefix = `${serviceName.toUpperCase()}_SERVICE`;
  const defaults = SERVICE_DEFAULTS[serviceName] || {};

  return {
    serviceName,
    enabled: isEnabled(process.env[`${prefix}_ENABLED`]),
    baseURL:
      process.env[`${prefix}_BASE_URL`] ||
      (defaults.port ? `http://localhost:${defaults.port}` : null),
    timeout: INTERNAL_TIMEOUT_MS,
  };
};

const checkInternalServiceHealth = async (serviceName) => {
  const config = getInternalServiceConfig(serviceName);

  if (!config.enabled) {
    return {
      service: serviceName,
      enabled: false,
      status: 'disabled',
    };
  }

  try {
    const response = await axios.get(`${config.baseURL}/health`, {
      timeout: config.timeout,
    });

    const healthy = response.data?.success === true;

    return {
      service: serviceName,
      enabled: true,
      baseURL: config.baseURL,
      status: healthy ? 'connected' : 'offline',
    };
  } catch (error) {
    return {
      service: serviceName,
      enabled: true,
      baseURL: config.baseURL,
      status: 'offline',
    };
  }
};

const getAllInternalServiceStatuses = async () => {
  return Promise.all(
    Object.keys(SERVICE_DEFAULTS).map((serviceName) =>
      checkInternalServiceHealth(serviceName),
    ),
  );
};

module.exports = {
  checkInternalServiceHealth,
  getAllInternalServiceStatuses,
  getInternalServiceConfig,
};
