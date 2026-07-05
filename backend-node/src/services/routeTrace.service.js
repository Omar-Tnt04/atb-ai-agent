const { randomUUID } = require('crypto');
const env = require('./../config/env');

// Per-request logging, controlled by two env vars:
//   REQUEST_LOG_MODE = off | summary | verbose   (default summary)
//   DEBUG_AGENT_ROUTING = true | false
// - summary  → one compact [REQUEST_SUMMARY] line per request.
// - verbose  → full [ROUTE_TRACE] stage lines (requires DEBUG_AGENT_ROUTING=true) + summary.
// - off      → no per-request logs.
// data.debugTrace / debugBuild / debugRuntime are attached to the API response ONLY when
// DEBUG_AGENT_ROUTING=true. The X-ATB-Debug-Build header is always set.
// Never logs full prompts, full catalog, full files, large objects, or secrets.

// Bump on every backend change. Appears in the boot line + X-ATB-Debug-Build header.
const DEBUG_BUILD = 'live-route-trace-description-qa-v3';
const HANDLER_FILE = 'backend-node/src/controllers/chat.controller.js';

const MAX_TRACES = 200; // bound memory: oldest evicted
const PREVIEW_LIMIT = 140;
const store = new Map(); // traceId -> [{ stage, ...data }] (debugTrace buffer; only when debug flag)
const summaries = new Map(); // traceId -> accumulated summary fields (when mode !== off)
// Tracks consecutive browser_agent_running poll responses per request path to suppress noise.
const pollThrottle = new Map(); // path -> count

// Keys that must never be logged, even if a caller passes them by mistake.
const FORBIDDEN_KEY = /(authorization|cookie|token|jwt|otp|secret|password|apikey|api_key|bearer)/i;

const logMode = () => env.requestLogMode || 'summary';
const debugOn = () => Boolean(env.debugAgentRouting);
const isVerboseRequestLog = () => debugOn() && logMode() === 'verbose';
const summaryEnabled = () => logMode() !== 'off';

// Mask long digit runs (cards, accounts, IBAN, phone) to the last 4 digits, unless already masked.
const maskDigits = (text) =>
  String(text).replace(/\d[\d\s-]{6,}\d/g, (run) => {
    const digits = run.replace(/\D/g, '');
    if (digits.length < 7) return run;
    return `****${digits.slice(-4)}`;
  });

const compact = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  let text;
  if (typeof value === 'object') {
    try {
      text = JSON.stringify(value);
    } catch {
      text = '[unserializable]';
    }
  } else {
    text = String(value);
  }
  text = maskDigits(text).replace(/\s+/g, ' ').trim();
  if (text.length > PREVIEW_LIMIT) text = `${text.slice(0, PREVIEW_LIMIT)}…`;
  return /\s/.test(text) ? `"${text.replace(/"/g, "'")}"` : text;
};

const startRouteTrace = (incomingId) => {
  const traceId = String(incomingId || randomUUID())
    .replace(/[^a-zA-Z0-9_.:-]/g, '_')
    .slice(0, 120);
  if (debugOn()) {
    if (store.size >= MAX_TRACES) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
    store.set(traceId, []);
  }
  if (summaryEnabled()) {
    if (summaries.size >= MAX_TRACES) {
      const oldest = summaries.keys().next().value;
      if (oldest !== undefined) summaries.delete(oldest);
    }
    summaries.set(traceId, { startedAt: Date.now() });
  }
  return traceId;
};

// Pull the few summary-relevant fields out of each stage so a one-line summary can be built even
// when DEBUG_AGENT_ROUTING is false (no full trace buffer).
const accumulateSummary = (traceId, stage, data) => {
  const s = summaries.get(traceId);
  if (!s) return;
  s.lastStage = stage;
  switch (stage) {
    case 'request_entered':
      s.method = data.method;
      s.path = data.path;
      break;
    case 'router_decision':
      s.intent = data.intent || data.mode || s.intent;
      break;
    case 'resource_selected':
      if (data.selectedResourceId && data.selectedResourceId !== 'none') s.resource = data.selectedResourceId;
      break;
    case 'trusted_fetch':
      if (data.fetchStatus && ['failed', 'blocked_url', 'metadata_only'].includes(data.fetchStatus)) {
        s.fetchStatus = data.fetchStatus;
      }
      break;
    case 'catalog_description_qa':
      if (data.matchType) s.match = data.matchType;
      if (data.branch) s.branch = data.branch;
      if (data.finalAnswerSource) s.source = data.finalAnswerSource;
      break;
    case 'deterministic_answer':
      if (data.matchedEntity && !s.branch) s.branch = data.matchedEntity;
      break;
    case 'writer_decision':
      s.writerCalled = Boolean(data.writerCalled);
      break;
    case 'final_response':
      s.status = data.status;
      s.source = data.finalAnswerSource || s.source;
      s.containsBold = data.containsBold;
      break;
    default:
      break;
  }
};

const traceRoute = (traceId, stage, data = {}) => {
  if (!traceId) return;
  const safeEntries = Object.entries(data).filter(([key]) => !FORBIDDEN_KEY.test(key));

  if (summaryEnabled()) accumulateSummary(traceId, stage, Object.fromEntries(safeEntries));

  // Buffer full stage for the API response debugTrace (only when the debug flag is on).
  if (debugOn()) {
    const buffer = store.get(traceId);
    if (buffer) {
      try {
        const record = { stage };
        for (const [key, value] of safeEntries) {
          if (value === null || value === undefined || value === '') continue;
          record[key] = typeof value === 'object'
            ? JSON.parse(JSON.stringify(value, (k, v) =>
                (typeof v === 'string' ? maskDigits(v).slice(0, PREVIEW_LIMIT) : v)))
            : maskDigits(String(value)).slice(0, PREVIEW_LIMIT);
        }
        buffer.push(record);
      } catch {
        buffer.push({ stage });
      }
    }
  }

  // Print verbose stage lines only in verbose mode.
  if (isVerboseRequestLog()) {
    const line = safeEntries
      .map(([key, value]) => `${key}=${compact(value)}`)
      .filter((pair) => !pair.endsWith('='))
      .join(' ');
    console.log(`[ROUTE_TRACE] traceId=${traceId} stage=${stage}${line ? ` ${line}` : ''}`);
  }
};

const getRouteTrace = (traceId) => (debugOn() ? store.get(traceId) || [] : []);

const endRouteTrace = (traceId) => {
  store.delete(traceId);
  summaries.delete(traceId);
};

// Builds the single [REQUEST_SUMMARY] line. Only includes fields that are actually known.
const buildSummaryLine = (traceId, body, statusCode) => {
  const s = summaries.get(traceId) || {};
  const ai = body?.data?.ai || {};
  const method = s.method || '?';
  const path = s.path || '?';
  const status = s.status || body?.status || (body?.success === false ? 'error' : 'ok');
  const source = s.source || ai.finalAnswerSource || ai.source || null;
  const intent = s.intent || ai.intent || null;
  const duration = s.startedAt ? `${Date.now() - s.startedAt}ms` : null;
  const ok = body?.success !== false && Number(statusCode || 200) < 400 && status !== 'error';
  const fallback = source === 'trusted_deterministic' || source === 'deterministic_fallback';

  const parts = [`${method} ${path}`, `status=${status}`];
  if (!ok) {
    const errStage = s.fetchStatus ? 'trusted_fetch' : s.lastStage || 'unknown';
    const errMsg = body?.message || body?.error || (s.fetchStatus ? `trusted fetch ${s.fetchStatus}` : 'request failed');
    parts.push(`stage=${errStage}`, `error="${String(errMsg).replace(/"/g, "'").slice(0, 120)}"`);
  } else {
    if (source) parts.push(`source=${source}`);
    if (intent) parts.push(`intent=${intent}`);
    if (s.resource) parts.push(`resource=${s.resource}`);
    if (s.match) parts.push(`match=${s.match}`);
    if (s.branch) parts.push(`branch="${String(s.branch).replace(/"/g, "'")}"`);
    if (fallback) parts.push('fallback=true');
    if (s.writerCalled !== undefined) parts.push(`writer=${s.writerCalled}`);
    if (s.containsBold !== undefined) parts.push(`bold=${s.containsBold}`);
  }
  if (duration) parts.push(`duration=${duration}`);
  parts.push(`ok=${ok}`);
  return `[REQUEST_SUMMARY] ${parts.join(' ')}`;
};

const routeTraceMiddleware = (req, res, next) => {
  const traceId = startRouteTrace(req.headers['x-request-id'] || req.body?.requestId);
  req.traceId = traceId;

  // Build header is always stamped (cheap, no terminal spam).
  try {
    res.setHeader('X-ATB-Debug-Build', DEBUG_BUILD);
  } catch {
    // headers already sent — ignore
  }

  const instrument = summaryEnabled() || debugOn();
  if (!instrument) return next();

  const debugRuntime = {
    pid: String(process.pid),
    cwd: process.cwd(),
    handlerFile: HANDLER_FILE,
    route: req.originalUrl || req.path,
  };

  traceRoute(traceId, 'request_entered', {
    method: req.method,
    path: req.originalUrl || req.path,
    messagePreview: req.body?.message || '',
    conversationId: req.body?.conversationId || req.body?.threadId || '',
  });

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    try {
      const ai = body?.data?.ai || {};
      const assistantMessage = body?.assistantMessage || ai.assistantMessage || body?.message || '';
      traceRoute(traceId, 'final_response', {
        status: body?.status,
        agentMode: body?.agentMode || ai.agentMode,
        finalAnswerSource: ai.finalAnswerSource || ai.source,
        assistantMessagePreview: assistantMessage,
        containsBold: /\*\*[^*\n]+\*\*/.test(String(assistantMessage)),
        returnedDataKeys: body?.data ? Object.keys(body.data).join(',') : '',
      });

      // Debug markers in the response only when DEBUG_AGENT_ROUTING=true.
      if (debugOn() && body && typeof body === 'object') {
        body.data = body.data || {};
        body.data.debugBuild = DEBUG_BUILD;
        body.data.debugRuntime = debugRuntime;
        body.data.debugTrace = getRouteTrace(traceId);
      }

      // One summary line in summary/verbose mode.
      // Poll requests (browser_agent_running) are suppressed when LOG_BROWSER_POLLING=false
      // to keep the terminal clean during demo mode. When LOG_BROWSER_POLLING=true, throttle
      // to poll#1 then every 10th to avoid flooding even in debug mode.
      if (summaryEnabled()) {
        const pollKey = req.originalUrl || req.path;
        const logPolling = Boolean(env.logBrowserPolling);
        if (body?.status === 'browser_agent_running') {
          const n = (pollThrottle.get(pollKey) || 0) + 1;
          pollThrottle.set(pollKey, n);
          if (logPolling && (n === 1 || n % 10 === 0)) {
            console.log(buildSummaryLine(traceId, body, res.statusCode) + ` [poll#${n}]`);
          }
        } else {
          const suppressed = pollThrottle.get(pollKey);
          if (suppressed) {
            pollThrottle.delete(pollKey);
            if (logPolling) {
              console.log(`[REQUEST_SUMMARY] ${req.method || '?'} ${pollKey} browser_agent_running ×${suppressed} suppressed`);
            }
          }
          console.log(buildSummaryLine(traceId, body, res.statusCode));
        }
      }
    } catch {
      // logging must never break a response
    } finally {
      endRouteTrace(traceId);
    }
    return originalJson(body);
  };

  return next();
};

module.exports = {
  DEBUG_BUILD,
  HANDLER_FILE,
  isVerboseRequestLog,
  startRouteTrace,
  traceRoute,
  getRouteTrace,
  endRouteTrace,
  routeTraceMiddleware,
};
