require('dotenv').config();

const fs = require('fs');
const path = require('path');
const trimTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');
const { modelRoutingConfig } = require('./modelRouting');

const numberEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

const boolEnv = (name, fallback) => {
  if (process.env[name] === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name]).trim().toLowerCase());
};

const resourceBaseUrl = trimTrailingSlash(
  process.env.RESOURCE_BASE_URL ||
    process.env.RESOURCE_SERVER_BASE_URL ||
    'http://localhost/atb-general-resources',
);

const normalizeFsPath = (value = '') =>
  String(value || '').trim().replace(/^file:\/+/, '');

const resourceRootDir = normalizeFsPath(process.env.RESOURCE_ROOT_DIR);
const resourceCatalogPath = normalizeFsPath(process.env.RESOURCE_CATALOG_PATH);

const requiredResourceConfigError = () => [
  'Laragon resource configuration is required.',
  'Set RESOURCE_ROOT_DIR=C:/laragon/www/atb-general-resources',
  'Set RESOURCE_CATALOG_PATH=C:/laragon/www/atb-general-resources/catalog.json',
  'Set RESOURCE_BASE_URL=http://localhost/atb-general-resources',
  'The repo-local resources folder is not a supported fallback.',
].join(' ');

if (!resourceRootDir || !resourceCatalogPath) {
  throw new Error(requiredResourceConfigError());
}

if (!fs.existsSync(resourceRootDir) || !fs.statSync(resourceRootDir).isDirectory()) {
  throw new Error(`${requiredResourceConfigError()} RESOURCE_ROOT_DIR does not exist or is not a directory: ${resourceRootDir}`);
}

if (!fs.existsSync(resourceCatalogPath) || !fs.statSync(resourceCatalogPath).isFile()) {
  throw new Error(`${requiredResourceConfigError()} RESOURCE_CATALOG_PATH does not exist or is not a file: ${resourceCatalogPath}`);
}

const resolvedRoot = path.resolve(resourceRootDir);
const resolvedCatalog = path.resolve(resourceCatalogPath);
if (resolvedCatalog !== path.join(resolvedRoot, 'catalog.json')) {
  throw new Error(`${requiredResourceConfigError()} RESOURCE_CATALOG_PATH must point to catalog.json inside RESOURCE_ROOT_DIR.`);
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: process.env.PORT || 5000,
  jwtSecret: process.env.JWT_SECRET || 'replace_with_secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1d',
  aiServiceUrl: process.env.AI_SERVICE_URL || 'http://localhost:8000',
  modelRouting: modelRoutingConfig,
  maxContextChars: numberEnv('MAX_CONTEXT_CHARS', 4000),
  maxAiResponseTokens: numberEnv('MAX_AI_RESPONSE_TOKENS', 500),
  enableVisionPdfAnalysis: false,
  enableVisionSummaryCache: false,
  visionSummaryCacheMaxItems: 0,
  visionSummaryCacheTtlMs: 0,
  visionRequestTimeoutMs: numberEnv('OCR_REQUEST_TIMEOUT_MS', 60000),
  architectureLogsEnabled: boolEnv('ENABLE_ARCHITECTURE_LOGS', false),
  backendDebugBoot: boolEnv('BACKEND_DEBUG_BOOT', false),
  debugAgentRouting: boolEnv('DEBUG_AGENT_ROUTING', false),
  // Per-request terminal logging: off | summary | verbose. Default summary (one line/request).
  requestLogMode: ['off', 'summary', 'verbose'].includes(
    String(process.env.REQUEST_LOG_MODE || 'summary').trim().toLowerCase(),
  )
    ? String(process.env.REQUEST_LOG_MODE || 'summary').trim().toLowerCase()
    : 'summary',
  debugResourceSearch: boolEnv('RESOURCE_MATCH_DEBUG', boolEnv('DEBUG_RESOURCE_SEARCH', false)),
  debugResourceAnswer: boolEnv('DEBUG_RESOURCE_ANSWER', false),
  logLevel: process.env.LOG_LEVEL || 'debug',
  logDir: process.env.LOG_DIR || '../logs',
  logPretty: process.env.LOG_PRETTY !== 'false',
  widgetDemoMode: process.env.WIDGET_DEMO_MODE === 'true',
  mvpLocalActionSimulation: boolEnv('MVP_LOCAL_ACTION_SIMULATION', false),
  resourceBaseUrl,
  resourceServerBaseUrl: resourceBaseUrl,
  resourceRootDir: resolvedRoot,
  resourceCatalogPath: resolvedCatalog,
  resourceJsonBaseUrl: trimTrailingSlash(
    process.env.RESOURCE_JSON_BASE_URL ||
      `${resourceBaseUrl}/json`,
  ),
  resourceDocumentBaseUrl: trimTrailingSlash(
    process.env.RESOURCE_DOCUMENT_BASE_URL ||
      `${resourceBaseUrl}/documents`,
  ),
  semanticResourceMinScore: numberEnv('SEMANTIC_RESOURCE_MIN_SCORE', 12),
  semanticResourceMinMargin: numberEnv('SEMANTIC_RESOURCE_MIN_MARGIN', 3),
  // Trusted-QA confidence gate (raw description-score points, NOT a 0-1 confidence). A normal bank
  // question whose best match is below minScore, OR that only narrowly beats the runner-up
  // (margin < minMargin), is treated as low-confidence: the backend returns a clean "trusted info not
  // enough" reply instead of answering from a weak/wrong resource. Applies to trusted QA only —
  // never to file-view, OCR/image, or banking-action paths.
  resourceQaMinScore: numberEnv('RESOURCE_QA_MIN_SCORE', 30),
  resourceQaMinMargin: numberEnv('RESOURCE_QA_MIN_MARGIN', 18),
  // Demo / debug console flags
  demoConsole: boolEnv('DEMO_CONSOLE', false),
  logBrowserPolling: boolEnv('LOG_BROWSER_POLLING', false),
  devLauncherDebug: boolEnv('DEV_LAUNCHER_DEBUG', false),
};

module.exports = env;
