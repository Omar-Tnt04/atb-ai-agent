require('dotenv').config();

const trimTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');
const { modelRoutingConfig } = require('./modelRouting');

const numberEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

const resourceServerBaseUrl = trimTrailingSlash(
  process.env.RESOURCE_SERVER_BASE_URL ||
    'http://localhost/atb-general-resources',
);

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: process.env.PORT || 5000,
  jwtSecret: process.env.JWT_SECRET || 'replace_with_secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1d',
  aiServiceUrl: process.env.AI_SERVICE_URL || 'http://localhost:8000',
  modelRouting: modelRoutingConfig,
  maxContextChars: numberEnv('MAX_CONTEXT_CHARS', 4000),
  maxAiResponseTokens: numberEnv('MAX_AI_RESPONSE_TOKENS', 500),
  enableVisionPdfAnalysis: process.env.ENABLE_VISION_PDF_ANALYSIS !== 'false',
  enableVisionSummaryCache: process.env.ENABLE_VISION_SUMMARY_CACHE === 'true',
  visionSummaryCacheMaxItems: numberEnv('VISION_SUMMARY_CACHE_MAX_ITEMS', 20),
  visionSummaryCacheTtlMs: numberEnv('VISION_SUMMARY_CACHE_TTL_MS', 300000),
  architectureLogsEnabled: process.env.ARCHITECTURE_LOGS_ENABLED !== 'false',
  logLevel: process.env.LOG_LEVEL || 'debug',
  logDir: process.env.LOG_DIR || '../logs',
  logPretty: process.env.LOG_PRETTY !== 'false',
  widgetDemoMode: process.env.WIDGET_DEMO_MODE === 'true',
  resourceServerBaseUrl,
  resourceJsonBaseUrl: trimTrailingSlash(
    process.env.RESOURCE_JSON_BASE_URL ||
      `${resourceServerBaseUrl}/json`,
  ),
  resourceDocumentBaseUrl: trimTrailingSlash(
    process.env.RESOURCE_DOCUMENT_BASE_URL ||
      `${resourceServerBaseUrl}/documents`,
  ),
  semanticResourceMinScore: numberEnv('SEMANTIC_RESOURCE_MIN_SCORE', 12),
  semanticResourceMinMargin: numberEnv('SEMANTIC_RESOURCE_MIN_MARGIN', 3),
};

module.exports = env;
