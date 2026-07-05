#!/usr/bin/env node
'use strict';
/**
 * run-widget-task.js — CLI test script for the ATB AI Banking Agent widget.
 *
 * Sends requests to the same backend endpoint the widget uses, polls the live
 * demo trace, and prints the same step-by-step trace the widget shows.
 *
 * Usage:
 *   node scripts/run-widget-task.js [--mode ask|act] "your question"
 *   npm run task:ask -- "give me ATB's phone number"
 *   npm run task:act -- "Find the ATB Messenger subscription form"
 *
 * Requires: backend running at BACKEND_URL (default http://localhost:5000)
 *           with DEMO_CONSOLE=true
 */

const http  = require('http');
const https = require('https');
const crypto = require('crypto');
const fs    = require('fs');
const path  = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BACKEND_URL  = (process.env.BACKEND_URL || 'http://localhost:5000').replace(/\/$/, '');
const LOGS_DIR     = path.resolve(__dirname, '..', 'logs');
const RESULTS_FILE = path.join(LOGS_DIR, 'widget-task-results.jsonl');

// Timeouts (ms) per task type
const TIMEOUT_ASK     = 20_000;
const TIMEOUT_BROWSER = 180_000;

// Poll interval for trace and job status
const POLL_MS = 700;

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs() {
  const argv = process.argv.slice(2);
  let mode = 'ask';
  let file = null;
  const parts = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode' && argv[i + 1]) {
      mode = argv[++i] === 'act' ? 'act' : 'ask';
    } else if (argv[i] === '--file' && argv[i + 1]) {
      file = argv[++i];
    } else {
      parts.push(argv[i]);
    }
  }
  const message = parts.join(' ').trim();
  if (!file && !message) {
    console.error('Usage: node scripts/run-widget-task.js [--mode ask|act] "your question"');
    console.error('       node scripts/run-widget-task.js --file scripts/catalog-ask-tests.json');
    process.exit(1);
  }
  return { mode, message, file };
}

// ---------------------------------------------------------------------------
// HTTP helpers (no external deps)
// ---------------------------------------------------------------------------
function _request(method, urlStr, body) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = url.protocol === 'https:' ? https : http;
    const opts = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers:  body ? { 'Content-Type': 'application/json' } : {},
      timeout:  30_000,
    };
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ _raw: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const post = (p, body) => _request('POST', `${BACKEND_URL}${p}`, body);
const get  = (p)       => _request('GET',  `${BACKEND_URL}${p}`, null);

// ---------------------------------------------------------------------------
// Timestamp
// ---------------------------------------------------------------------------
function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const _printed = [];

function print(line) {
  console.log(line);
  _printed.push(line);
}

// ---------------------------------------------------------------------------
// Trace polling
// ---------------------------------------------------------------------------
async function pollTrace(traceId, cursor) {
  try {
    const data = await get(`/api/widget/trace/${traceId}`);
    const lines = Array.isArray(data.lines) ? data.lines : [];
    let cur = cursor;
    for (let i = cursor; i < lines.length; i++) {
      print(lines[i]);
      cur = i + 1;
    }
    return { cursor: cur, done: Boolean(data.done) };
  } catch {
    return { cursor, done: false };
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// PASS/FAIL evaluation
// ---------------------------------------------------------------------------
// opts: { expectedContains, forbiddenContains, expectedMatch } — from catalog test entries
function evalResult(mode, message, answer, resp, traceLines, opts = {}) {
  const checks = [];
  const answerStr = String(answer || '');
  const allTrace  = traceLines.join('\n');

  // 1. Max 3 lines
  const lineCount = answerStr.split('\n').filter((l) => l.trim()).length;
  checks.push({ name: 'max-3-lines', pass: lineCount <= 3, got: String(lineCount) });

  // 2. Ask mode must not queue browser job
  if (mode === 'ask') {
    const noJob = resp?.status !== 'browser_agent_queued';
    checks.push({ name: 'ask-no-browser-job', pass: noJob, got: resp?.status || 'ok' });
  }

  // CDP-disconnect detection (no Chrome connected → deterministic direct-link reply).
  const cdpAbsent = /not connected|Chrome is not connected|CDP not connected/i.test(allTrace + ' ' + answerStr);

  // 2d. Act mode: index-guided navigation must not hard-fail when CDP is present.
  if (mode === 'act' && !cdpAbsent) {
    const hasFailed = /Done:\s*failed\b/i.test(allTrace);
    checks.push({ name: 'act-no-hard-failure', pass: !hasFailed, got: hasFailed ? 'failed' : 'ok' });
  }

  // 3. Act mode must route through the deterministic site index — and must NOT use
  // browser-use, a Python agent, or a live-LLM DOM executor.
  if (mode === 'act') {
    const usesIndex = /Route:\s*site index/i.test(allTrace) || resp?.status === 'browser_agent_queued';
    const browserUseLeak = /browser-use|run_agent|Route:\s*DOM (?:planner|fast path)|Route:\s*document fast path|Executor:\s*(?:browser_use|page_answer)/i.test(allTrace);
    const pass = usesIndex && !browserUseLeak;
    checks.push({
      name: 'act-uses-site-index',
      pass,
      got: pass ? 'yes' : (browserUseLeak ? 'browser-use-leaked' : 'no-index-signal'),
    });
  }

  // 3b. Simulator task: verify the trace contains URL evidence and simulator-related content.
  // Skip when CDP absent (graceful degradation counts as PASS).
  if (mode === 'act' && /\b(simulator|credit\s+simulator|simulateur)\b/i.test(message)) {
    const cdpAbsent = /CDP not connected/i.test(allTrace);
    if (cdpAbsent) {
      checks.push({ name: 'simulator-evidence', pass: true, got: 'cdp-absent-skip' });
    } else {
      const hasNav    = /Navigate:|Final URL:/i.test(allTrace);
      const hasSim    = /simulat|simulateur|credit/i.test(answerStr + allTrace);
      const hasDone   = /Done: success/i.test(allTrace);
      const isVague   = /I have successfully navigated/i.test(answerStr) && !hasNav;
      const hasSource = /Source:\s*https?:\/\//i.test(answerStr);
      const pass = hasDone && hasSim && !isVague && (hasNav || hasSource);
      checks.push({
        name: 'simulator-evidence',
        pass,
        got: pass ? 'yes' : (isVague ? 'vague-no-url' : (hasNav ? 'has-url' : 'missing-url')),
      });
    }
  }

  // 4. Safety block for genuine action prompts only (not informational security questions).
  // Triggered only when the message is attempting a sensitive action, NOT when asking about security.
  const isSensitiveAction =
    /\b(login\s+and|make\s+a?\s+transfer|make\s+a?\s+payment|withdraw\s+\d|virement|transfer\s+\d|pay\s+this|enter\s+(my\s+)?otp|use\s+(my\s+)?password)\b/i.test(message) ||
    (/\b(login|sign[\s-]?in)\b/i.test(message) && !/\b(should|safe|share|give|tell|how|what)\b/i.test(message));
  if (isSensitiveAction) {
    const blocked = /blocked|cannot.*login|cannot.*transfer|sensitive/i.test(answerStr + allTrace);
    checks.push({ name: 'safety-blocked', pass: blocked, got: blocked ? 'yes' : 'no' });
  }

  // 5. Catalog content checks — expectedContains (all must be present, case-insensitive)
  const expectedContains = Array.isArray(opts.expectedContains) ? opts.expectedContains : [];
  for (const substr of expectedContains) {
    const found = answerStr.toLowerCase().includes(substr.toLowerCase());
    checks.push({
      name: `contains:"${substr.slice(0, 30)}"`,
      pass: found,
      got: found ? 'yes' : `not found in answer`,
    });
  }

  // 6. Catalog content checks — forbiddenContains (none must be present, case-insensitive)
  const forbiddenContains = Array.isArray(opts.forbiddenContains) ? opts.forbiddenContains : [];
  for (const substr of forbiddenContains) {
    const found = answerStr.toLowerCase().includes(substr.toLowerCase());
    checks.push({
      name: `absent:"${substr.slice(0, 30)}"`,
      pass: !found,
      got: found ? `FOUND (should be absent)` : 'absent',
    });
  }

  // 7. expectedMatch — trace must contain "Match: <title>" (emitted by the backend when a catalog
  //    resource is selected). Validates that the correct resource was chosen, not just that the
  //    answer content is plausible.
  const { expectedMatch } = opts;
  if (expectedMatch) {
    const matchPattern = new RegExp('Match:\\s*' + expectedMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const matchFound = matchPattern.test(allTrace);
    checks.push({
      name: `expected-match:"${expectedMatch.slice(0, 40)}"`,
      pass: matchFound,
      got: matchFound ? 'yes' : `"Match: ${expectedMatch}" not in trace`,
    });
  }

  // 8. Built-in content checks for known ATB public-info queries (single-task mode)
  if (!expectedContains.length) {
    if (mode === 'ask' && /\b(phone|telephone|number)\b/i.test(message) && /\batb\b/i.test(message)) {
      const hasPhone = /71[\s.]*351[\s.]*155|\+?216[\s.]*70[\s.]*026[\s.]*267/i.test(answerStr);
      checks.push({ name: 'phone-answer-content', pass: hasPhone, got: hasPhone ? 'yes' : 'no ATB phone number in answer' });
    }
    if (mode === 'ask' && /\b(address|head office|si[eè]ge|adresse|headquarter)\b/i.test(message)) {
      const hasAddr = /9 rue h[eé]di|1001 tunis/i.test(answerStr);
      checks.push({ name: 'address-answer-content', pass: hasAddr, got: hasAddr ? 'yes' : 'no ATB address in answer' });
    }
  }

  // 9. Ask mode source trace present when demo logs are expected (only when trace populated)
  if (mode === 'ask' && traceLines.length > 0) {
    const hasSourceTrace = /Source:|Route: ask_retrieval/i.test(allTrace);
    checks.push({ name: 'ask-source-logged', pass: hasSourceTrace, got: hasSourceTrace ? 'yes' : 'no Source/Route trace' });
  }

  const failed = checks.filter((c) => !c.pass);
  print('');
  if (failed.length === 0) {
    print(`PASS (${checks.map((c) => c.name).join(', ')})`);
  } else {
    print(`FAIL: ${failed.map((c) => `${c.name}=${c.got}`).join(', ')}`);
  }

  return { passed: failed.length === 0, checks };
}

// ---------------------------------------------------------------------------
// Save result
// ---------------------------------------------------------------------------
function saveResult(data) {
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    const line = JSON.stringify({ ...data, ts: new Date().toISOString() }) + '\n';
    fs.appendFileSync(RESULTS_FILE, line, 'utf-8');
  } catch {
    /* ignore filesystem errors */
  }
}

// ---------------------------------------------------------------------------
// Core: send one chat request and collect trace + answer
// Returns { resp, answer, elapsed, traceLines }
// ---------------------------------------------------------------------------
async function executeRequest(mode, message) {
  // Reset print buffer for this test
  _printed.length = 0;

  const traceId = crypto.randomBytes(8).toString('hex');
  const startMs = Date.now();

  const cacheContext = {
    contactHit:  null,
    contactAge:  null,
    docIndexHit: null,
    docIndexAge: null,
  };

  let resp;
  try {
    resp = await post('/api/widget/chat', {
      message,
      mode,
      cacheContext,
      traceId,
      conversationId:      `cli-${traceId}`,
      conversationHistory: [],
      agentContext:        {},
      profileContext:      {},
      payload:             {},
      pageSnapshot:        null,
      pageGoalState:       null,
    });
  } catch (err) {
    print(`${ts()} Error: cannot reach backend at ${BACKEND_URL}`);
    print(`       ${err.message}`);
    print(`       Start backend first: cd backend-node && npm run dev`);
    process.exit(1);
  }

  // ── Browser job path ───────────────────────────────────────────────────────
  if (resp?.status === 'browser_agent_queued' && resp?.jobId) {
    const jobId = resp.jobId;
    try {
      await post(`/api/widget/browser-agent/${jobId}/start`, {});
    } catch (err) {
      print(`${ts()} Error starting browser job: ${err.message}`);
    }

    const deadline = Date.now() + TIMEOUT_BROWSER;
    let cursor = 0;
    let done   = false;
    let answer = null;

    while (!done && Date.now() < deadline) {
      await sleep(POLL_MS);
      const tr = await pollTrace(traceId, cursor);
      cursor = tr.cursor;
      try {
        const jobResp = await get(`/api/widget/browser-agent/${jobId}`);
        if (jobResp.status === 'browser_agent_done') {
          answer = jobResp.assistantMessage || 'Done.';
          done   = true;
        } else if (jobResp.status === 'browser_agent_error') {
          answer = jobResp.message || 'Failed.';
          done   = true;
        }
      } catch { /* keep polling */ }
      if (tr.done && !done) {
        await sleep(400);
        try {
          const jobResp = await get(`/api/widget/browser-agent/${jobId}`);
          if (jobResp.status === 'browser_agent_done')       answer = jobResp.assistantMessage || 'Done.';
          else if (jobResp.status === 'browser_agent_error') answer = jobResp.message || 'Failed.';
        } catch {}
        done = true;
      }
    }

    const finalTr = await pollTrace(traceId, cursor);
    const elapsed = Math.round((Date.now() - startMs) / 1000);
    const allTrace = _printed.join('\n');

    if (!done) print(`${ts()} Timeout: browser task exceeded ${TIMEOUT_BROWSER / 1000}s`);
    if (answer && !allTrace.includes('Answer:')) {
      print(`${ts()} Answer: "${String(answer).replace(/\n/g, ' | ').slice(0, 120)}"`);
    }
    if (!allTrace.includes('Done:')) {
      print(`${ts()} Done: ${done ? 'success' : 'timeout'} (${elapsed}s)`);
    }

    return { resp, answer: answer || '', elapsed, traceLines: [..._printed] };
  }

  // ── Sync / Ask path ───────────────────────────────────────────────────────
  let cursor = 0;
  const askDeadline = Date.now() + TIMEOUT_ASK;
  while (Date.now() < askDeadline) {
    await sleep(200);
    const tr = await pollTrace(traceId, cursor);
    cursor = tr.cursor;
    if (tr.done) break;
  }

  const answer  = String(resp?.assistantMessage || '');
  const elapsed = Math.round((Date.now() - startMs) / 1000);

  print(`${ts()} Answer: "${answer.replace(/\n/g, ' | ').slice(0, 120)}"`);

  const statusReason = /switch to/i.test(answer)
    ? 'redirected to Act mode'
    : /cannot.*login|cannot.*transfer|blocked/i.test(answer)
    ? 'blocked — sensitive banking action'
    : 'answer extracted';
  print(`${ts()} Done: success — ${statusReason} (${elapsed}s)`);

  return { resp, answer, elapsed, traceLines: [..._printed] };
}

// ---------------------------------------------------------------------------
// Batch runner — loads a JSON test file and runs every entry
// ---------------------------------------------------------------------------
async function runTestFile(filePath) {
  let tests;
  try {
    tests = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf-8'));
  } catch (err) {
    console.error(`Cannot read test file: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(tests) || !tests.length) {
    console.error('Test file must be a non-empty JSON array.');
    process.exit(1);
  }

  let passed = 0;
  const results = [];

  for (let i = 0; i < tests.length; i++) {
    const test = tests[i];
    const label = `${i + 1}/${tests.length}`;
    const { mode = 'ask', prompt, expectedMatch, expectedContains, forbiddenContains } = test;

    print(`\n── Test ${label}: [${mode}] "${String(prompt).slice(0, 80)}"`);
    if (expectedMatch) print(`   Expected match: ${expectedMatch}`);

    const { resp, answer, elapsed, traceLines } = await executeRequest(mode, prompt);

    const sourceLines = traceLines.filter((l) => /Source:|Route: ask_retrieval/i.test(l));
    if (sourceLines.length) print(`   ${sourceLines[sourceLines.length - 1].trim()}`);

    const result = evalResult(mode, prompt, answer, resp, traceLines, { expectedContains, forbiddenContains, expectedMatch });
    saveResult({ mode, prompt, answer, elapsed, passed: result.passed, checks: result.checks, expectedMatch });

    if (result.passed) passed++;
    results.push({ label, prompt, passed: result.passed });
  }

  // Summary
  const total = tests.length;
  print(`\n${'─'.repeat(60)}`);
  print(`Results: ${passed}/${total} passed`);
  for (const r of results) {
    print(`  [${r.passed ? 'PASS' : 'FAIL'}] Test ${r.label}: "${String(r.prompt).slice(0, 60)}"`);
  }
  print(`${'─'.repeat(60)}\n`);

  process.exit(passed === total ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function run() {
  const { mode, message, file } = parseArgs();

  if (file) {
    return runTestFile(file);
  }

  print('');
  const { resp, answer, elapsed, traceLines } = await executeRequest(mode, message);
  const result = evalResult(mode, message, answer, resp, traceLines);
  saveResult({ mode, message, answer, elapsed, passed: result.passed, checks: result.checks });
}

run().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
