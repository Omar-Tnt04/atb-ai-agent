'use strict';
// Per-task trace buffer: stores clean demo step lines keyed by traceId.
// Expires after 10 minutes of inactivity. Small only — never stores raw LLM
// output, screenshots, DOM snapshots, or full model responses.

const TRACE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const _traces = new Map(); // traceId → { lines: string[], done: bool, ts: number }
const _jobMap = new Map();  // jobId  → traceId

function _cleanup() {
  const cutoff = Date.now() - TRACE_TTL_MS;
  for (const [id, t] of _traces) {
    if (t.ts < cutoff) _traces.delete(id);
  }
}

function createTrace(traceId) {
  _cleanup();
  _traces.set(traceId, { lines: [], done: false, ts: Date.now() });
}

function appendTrace(traceId, line) {
  const t = _traces.get(traceId);
  if (!t) return;
  t.lines.push(line);
  t.ts = Date.now();
}

function getTrace(traceId) {
  const t = _traces.get(traceId);
  if (!t) return null;
  if (Date.now() - t.ts > TRACE_TTL_MS) {
    _traces.delete(traceId);
    return null;
  }
  return { lines: [...t.lines], done: t.done };
}

function markTraceDone(traceId) {
  const t = _traces.get(traceId);
  if (t) {
    t.done = true;
    t.ts = Date.now();
  }
}

function linkJobToTrace(jobId, traceId) {
  _jobMap.set(jobId, traceId);
}

function getTraceIdForJob(jobId) {
  return _jobMap.get(jobId) || null;
}

module.exports = {
  createTrace,
  appendTrace,
  getTrace,
  markTraceDone,
  linkJobToTrace,
  getTraceIdForJob,
};
