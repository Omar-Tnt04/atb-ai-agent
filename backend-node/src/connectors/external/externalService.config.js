const isEnabled = (value) => String(value).toLowerCase() === 'true';

const isPlaceholder = (value) => {
  return !value || value === 'replace_with_url' || value === 'replace_with_key';
};

const getServiceConfig = (serviceName) => {
  const prefix = `${serviceName.toUpperCase()}_SERVICE`;

  return {
    serviceName,
    enabled:
      isEnabled(process.env.EXTERNAL_SERVICE_ENABLED) &&
      isEnabled(process.env[`${prefix}_ENABLED`]),
    baseURL: process.env[`${prefix}_BASE_URL`] || process.env.EXTERNAL_SERVICE_BASE_URL,
    apiKey: process.env[`${prefix}_API_KEY`] || process.env.EXTERNAL_SERVICE_API_KEY,
    timeout: Number(process.env.EXTERNAL_SERVICE_TIMEOUT_MS || 15000),
  };
};

const getSafeServiceStatus = (serviceName) => {
  const config = getServiceConfig(serviceName);

  return {
    service: serviceName,
    enabled: config.enabled,
    configured: config.enabled && !isPlaceholder(config.baseURL),
  };
};

const getAllExternalServiceStatuses = () => [
  getSafeServiceStatus('document'),
  getSafeServiceStatus('payment'),
  getSafeServiceStatus('complaint'),
  getSafeServiceStatus('appointment'),
];

module.exports = {
  getAllExternalServiceStatuses,
  getSafeServiceStatus,
  getServiceConfig,
  isPlaceholder,
};
