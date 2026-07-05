'use strict';
/**
 * Dual-mode console logger.
 *
 * DEMO_CONSOLE=true  → only clean [DEMO] step lines reach the terminal.
 * DEMO_CONSOLE=false → all existing verbose debug output (unchanged behavior).
 *
 * Reads env at call time — no restart needed to toggle.
 */

const { AsyncLocalStorage } = require('async_hooks');
const { appendTrace, getTraceIdForJob } = require('../services/traceBuffer.service');

const _bool = (name) =>
  ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());

const isDemoMode = () => _bool('DEMO_CONSOLE');
const isDebugMode = () => _bool('DEBUG_AGENT_ROUTING');

// Stores the current traceId for the async execution chain (request or job).
const _traceCtx = new AsyncLocalStorage();

function _ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * stepLog — always printed in demo mode.
 * start.js whitelists the [DEMO] prefix so it reaches the terminal from subprocesses.
 *
 *   stepLog('Route', 'DOM fast path')
 *   → [DEMO] [18:57:01] Route: DOM fast path
 *
 * Also appends to the trace buffer when a traceId is active in the current
 * async context (set via runWithTrace) or supplied via { jobId }.
 */
function stepLog(label, message, { jobId } = {}) {
  const line = `[${_ts()}] ${label}: ${message}`;
  console.log(`[DEMO] ${line}`);

  // Resolve traceId: async context first (request chain), jobId mapping second (browser jobs).
  const traceId = _traceCtx.getStore() || (jobId ? getTraceIdForJob(jobId) : null);
  if (traceId) appendTrace(traceId, line);
}

/**
 * runWithTrace — runs fn inside a named async context so that all stepLog calls
 * within it (including nested async callbacks) automatically append to the trace buffer.
 *
 *   runWithTrace(traceId, () => someAsyncWork())
 */
function runWithTrace(traceId, fn) {
  return _traceCtx.run(traceId, fn);
}

/**
 * debugLog — printed only when NOT in demo mode, or when DEBUG_AGENT_ROUTING=true.
 * Drop-in replacement for raw console.log('[PREFIX] ...') calls.
 */
function debugLog(label, data) {
  if (isDemoMode() && !isDebugMode()) return;
  const text =
    data !== undefined && data !== null
      ? typeof data === 'object'
        ? JSON.stringify(data).slice(0, 300)
        : String(data).slice(0, 300)
      : '';
  console.log(`[${label}]${text ? ` ${text}` : ''}`);
}

/**
 * errorLog — always printed; compact in demo mode, full in debug mode.
 */
function errorLog(label, message, err) {
  if (isDemoMode()) {
    const detail = err
      ? ` — ${String(err.message || err).split('\n')[0].slice(0, 120)}`
      : '';
    console.error(`[${_ts()}] Error (${label}): ${message}${detail}`);
  } else {
    console.error(`[${label}] ${message}${err ? ` — ${err.message || err}` : ''}`);
  }
}

module.exports = { isDemoMode, isDebugMode, stepLog, debugLog, errorLog, runWithTrace };
