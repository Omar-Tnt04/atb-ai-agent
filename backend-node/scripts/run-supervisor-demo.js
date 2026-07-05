#!/usr/bin/env node
'use strict';

/**
 * ATB Browser-Control Agent — Supervisor Demo Runner
 *
 * Runs Act-mode scenarios against the live backend and prints clean traces
 * proving the agent controls the real ATB website through Chrome/CDP.
 *
 * Prerequisites:
 *   - Backend on port 5000 with DEMO_CONSOLE=true
 *   - Chrome open with --remote-debugging-port=9222
 *   - CDP_URL=http://127.0.0.1:9222 reachable
 */

const http = require('http');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL    = process.env.BACKEND_URL    || 'http://localhost:5000';
const WIDGET_BASE = `${BASE_URL}/widget-demo`;

const POLL_INTERVAL_MS  = 1500;
const JOB_TIMEOUT_MS    = 3 * 60 * 1000; // 3 min per scenario
const SCENARIO_DELAY_MS = 3000;

const SCENARIOS = [
  { title: 'Find the ATB Messenger form',   message: 'Find the ATB Messenger form'   },
  { title: 'Open the ATB contact page',     message: 'Open the contact page'          },
  { title: 'Find the card request form',    message: 'Find the card request form'     },
];

// Trace label groups
const SUMMARY_LABELS   = new Set(['Intent', 'Plan', 'Candidates', 'CandidateNav', 'Browser', 'Cache', 'Agent', 'Document', 'Final URL', 'Answer', 'Done', 'Evidence']);
const SUPPRESS_LABELS  = new Set(['Ctx', 'Cache (doc)', 'Confidence', 'LLM_RAW']);

// ---------------------------------------------------------------------------
// HTTP helpers (no external deps)
// ---------------------------------------------------------------------------

function _request(method, url, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname : u.hostname,
      port     : Number(u.port) || 80,
      path     : u.pathname + u.search,
      method,
      headers  : { 'Content-Type': 'application/json' },
      timeout  : 8000,
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ _raw: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const post = (path, body) => _request('POST', `${WIDGET_BASE}${path}`, body);
const get  = (path)       => _request('GET',  `${WIDGET_BASE}${path}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const W = 64;
const hr = (c = '─') => c.repeat(W);
const pad = (label, width = 12) => String(label).padEnd(width);

function parseLine(raw) {
  // Stored format: "[HH:MM:SS] Label: message"
  const m = raw.match(/^\[[\d:]+\] ([^:]+): (.*)/s);
  if (!m) return { label: '', message: raw };
  return { label: m[1].trim(), message: m[2].trim() };
}

function printLine(label, message) {
  console.log(`  ${pad(label)} ${message}`);
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

async function runScenario(scenario, idx) {
  const traceId = `supervisor-${idx + 1}-${Date.now()}`;

  console.log('');
  console.log(hr('═'));
  console.log(`SCENARIO ${idx + 1} / ${SCENARIOS.length}  —  ${scenario.title}`);
  console.log(hr('═'));
  console.log('');
  printLine('Request', `"${scenario.message}"`);
  printLine('TraceId', traceId);
  console.log('');

  // ── 1. Queue browser job ────────────────────────────────────────────────
  let chatResp;
  try {
    chatResp = await post('/chat', {
      message : scenario.message,
      mode    : 'act',
      traceId,
    });
  } catch (err) {
    const detail = err?.message || err?.code || String(err) || 'ECONNREFUSED';
    printLine('ERROR', `Backend unreachable — ${detail}`);
    printLine('TIP', `Start backend: cd backend-node && npm run dev  (port 5000, DEMO_CONSOLE=true)`);
    return { success: false, error: 'backend_unreachable' };
  }

  if (!chatResp?.jobId) {
    if (chatResp?.assistantMessage) {
      printLine('Response', chatResp.assistantMessage.slice(0, 120));
    } else {
      printLine('ERROR', `No jobId in response: ${JSON.stringify(chatResp).slice(0, 160)}`);
    }
    return { success: false, error: 'no_browser_job' };
  }

  const { jobId } = chatResp;
  printLine('Job', jobId);
  console.log('');
  console.log(hr('─'));
  console.log('  Trace:');
  console.log(hr('─'));

  // ── 2. Start the job ────────────────────────────────────────────────────
  await sleep(150);
  try {
    await post(`/browser-agent/${jobId}/start`, {});
  } catch (err) {
    printLine('ERROR', `Could not start job — ${err.message}`);
    return { success: false, error: 'job_start_failed' };
  }

  // ── 3. Stream trace until done ──────────────────────────────────────────
  const startedAt = Date.now();
  let printed  = 0;
  let lastData = null;

  while (true) {
    await sleep(POLL_INTERVAL_MS);

    let trace;
    try { trace = await get(`/trace/${traceId}`); }
    catch { continue; }
    if (!trace || !Array.isArray(trace.lines)) continue;

    // Print new lines; suppress noise; dim non-summary lines
    const newLines = trace.lines.slice(printed);
    for (const raw of newLines) {
      const { label, message } = parseLine(raw);
      if (SUPPRESS_LABELS.has(label)) continue;
      if (SUMMARY_LABELS.has(label)) {
        printLine(label, message);
      } else {
        // Secondary lines (SiteCtx, SiteIndex, Cache for doc, etc.) — print dimmed
        printLine(label, message);
      }
    }
    printed  = trace.lines.length;
    lastData = trace;

    if (trace.done) break;

    if (Date.now() - startedAt > JOB_TIMEOUT_MS) {
      printLine('TIMEOUT', 'scenario exceeded 3 minutes');
      break;
    }
  }

  // ── 4. Result summary ───────────────────────────────────────────────────
  const lines   = (lastData?.lines || []).map(parseLine);
  const field   = (lbl) => lines.find((l) => l.label === lbl)?.message || null;
  const allOf   = (lbl) => lines.filter((l) => l.label === lbl).map((l) => l.message);

  const doneMsg   = field('Done') || '';
  const success   = /^success/i.test(doneMsg);
  const docField  = allOf('Document').pop() || null;
  const finalUrl  = field('Final URL');
  const candidateNav = field('CandidateNav');
  const startUrl  = candidateNav ? candidateNav.replace(/^start=/, '') : null;
  const answer    = field('Answer');
  const duration  = Math.round((Date.now() - startedAt) / 1000);

  console.log('');
  console.log(hr('─'));
  console.log('  Summary:');
  console.log(hr('─'));
  printLine('Intent',     field('Intent')     || '—');
  printLine('Plan',       field('Plan')        || '—');
  printLine('Candidates', field('Candidates')  || 'none');
  printLine('Browser',    field('Browser')     || '—');
  printLine('Cache',      field('Cache')       || '—');
  if (startUrl)  printLine('Start URL',  startUrl);
  if (docField)  printLine('Document',   docField);
  if (finalUrl)  printLine('Final URL',  finalUrl);
  if (answer)    printLine('Answer',     answer.replace(/^"(.*)"$/, '$1').slice(0, 100));
  printLine('Duration',   `${duration}s`);
  printLine('Result',     doneMsg || (success ? 'success' : 'unknown'));
  console.log(hr('─'));

  return { success, doneMsg, docFound: !!docField, finalUrl };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('');
  console.log(hr('═'));
  console.log('  ATB BROWSER-CONTROL AGENT  —  SUPERVISOR DEMO');
  console.log(hr('═'));
  console.log('');
  console.log(`  Backend  : ${BASE_URL}`);
  console.log(`  Scenarios: ${SCENARIOS.length}`);
  console.log('');
  console.log('  Prerequisites:');
  console.log('    • Backend on port 5000   (cd backend-node && npm run dev)');
  console.log('    • DEMO_CONSOLE=true in backend-node/.env');
  console.log('    • Chrome open with --remote-debugging-port=9222');
  console.log('    • CDP reachable at http://127.0.0.1:9222');
  console.log('');

  // ── Preflight: confirm backend is reachable before running scenarios ───────
  try {
    await _request('GET', `${BASE_URL}/widget-demo/site-index/summary`);
  } catch (err) {
    const detail = err?.message || err?.code || 'ECONNREFUSED';
    console.log(`  ✗  Backend not reachable (${detail})`);
    console.log('');
    console.log('  Start the backend first:');
    console.log(`    cd backend-node && npm run dev`);
    console.log('');
    console.log('  Then re-run:');
    console.log('    npm run demo:supervisor');
    console.log('');
    process.exit(1);
  }
  console.log(`  ✓  Backend reachable`);
  console.log('');

  const results = [];

  for (let i = 0; i < SCENARIOS.length; i++) {
    const result = await runScenario(SCENARIOS[i], i);
    results.push({ ...result, scenario: SCENARIOS[i] });

    if (i < SCENARIOS.length - 1) {
      console.log('');
      console.log(`  Waiting ${SCENARIO_DELAY_MS / 1000}s before next scenario…`);
      await sleep(SCENARIO_DELAY_MS);
    }
  }

  // ── Final summary ──────────────────────────────────────────────────────
  console.log('');
  console.log(hr('═'));
  console.log('  FINAL SUMMARY');
  console.log(hr('═'));
  console.log('');

  let passed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const icon   = r.success ? '✓' : '✗';
    const detail = r.doneMsg || (r.error ? `error: ${r.error}` : 'unknown');
    const doc    = r.docFound ? '  [document found]' : '';
    console.log(`  ${icon}  Scenario ${i + 1}: ${r.scenario.title}`);
    console.log(`        ${detail}${doc}`);
    if (r.finalUrl) console.log(`        Final URL: ${r.finalUrl}`);
    console.log('');
    if (r.success) passed++;
  }

  const total = SCENARIOS.length;
  console.log(`  ${passed}/${total} scenarios completed successfully`);
  console.log('');
  console.log(hr('═'));
  console.log('');

  process.exit(passed < total ? 1 : 0);
}

main().catch((err) => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
