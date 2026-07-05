#!/usr/bin/env node
'use strict';

/**
 * run-agent-task.js — CLI test runner for the index-guided agent.
 *
 * Exercises the full Act-mode decision path without the widget UI:
 *   user task
 *     → Gemma: intent JSON  (resourceType, target, terms, confidence)
 *     → site-index.json: top-8 candidates scored deterministically
 *     → optional Gemma candidate-ID chooser  (opaque IDs only, never URLs)
 *     → validated action  (navigate | download | navigate_then_download)
 *     → optional CDP execution via pageNavigator.service.js  (--execute)
 *
 * Usage:
 *   node scripts/run-agent-task.js "task text"
 *   node scripts/run-agent-task.js --execute "task text"
 *   node scripts/run-agent-task.js --file tests/agent/complex-fr-tasks.txt
 *   node scripts/run-agent-task.js --file tests/agent/complex-fr-tasks.txt --execute
 */

const path = require('path');
const fs   = require('fs');

// ── Load .env before requiring services that read process.env ─────────────────
const envFile = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  try { require('dotenv').config({ path: envFile, quiet: true }); } catch {}
}

// ── Service imports (same modules used by widgetDemo.routes.js) ────────────────
const A   = require('../src/services/siteIndexAgent.service');
const nav = require('../src/services/pageNavigator.service');

// ── Semantic expectations ──────────────────────────────────────────────────────
const EXPECTED_FILE = path.resolve(__dirname, '..', 'tests', 'agent', 'complex-fr-tasks.expected.json');
let _expectedMap = null;

function getExpectedMap() {
  if (_expectedMap) return _expectedMap;
  _expectedMap = new Map();
  if (!fs.existsSync(EXPECTED_FILE)) return _expectedMap;
  try {
    const arr = JSON.parse(fs.readFileSync(EXPECTED_FILE, 'utf-8'));
    for (const e of arr) if (e.task) _expectedMap.set(e.task.trim(), e);
  } catch { /* ignore */ }
  return _expectedMap;
}

function runSemanticCheck(result, expected) {
  if (!expected) return null;
  const checks = [];
  const title  = result.decision.action?.title || '';
  const url    = result.decision.action?.documentUrl || result.decision.action?.url || '';
  const rt     = result.decision.resourceType || '';

  if (expected.expectedResourceType) {
    const ok = rt === expected.expectedResourceType;
    checks.push({ label: `resourceType = ${expected.expectedResourceType}`, ok });
  }
  for (const s of (expected.titleIncludesAny || [])) {
    if (title.toLowerCase().includes(s.toLowerCase())) {
      checks.push({ label: `title includes "${s}"`, ok: true });
      break;
    }
  }
  if (expected.titleIncludesAny?.length && !checks.some((c) => c.label.startsWith('title includes'))) {
    checks.push({ label: `title includes any of [${expected.titleIncludesAny.join(', ')}]`, ok: false });
  }
  for (const s of (expected.urlIncludesAny || [])) {
    if (url.toLowerCase().includes(s.toLowerCase())) {
      checks.push({ label: `url includes "${s}"`, ok: true });
      break;
    }
  }
  if (expected.urlIncludesAny?.length && !checks.some((c) => c.label.startsWith('url includes'))) {
    checks.push({ label: `url includes any of [${expected.urlIncludesAny.join(', ')}]`, ok: false });
  }
  for (const s of (expected.rejectTitleIncludesAny || [])) {
    if (title.toLowerCase().includes(s.toLowerCase())) {
      checks.push({ label: `title must not include "${s}"`, ok: false });
    }
  }
  return checks;
}

// ── Arg parsing ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = argv.slice(2);
  let filePath = null;
  let execute  = false;
  const rest   = [];
  let i = 0;
  while (i < args.length) {
    if ((args[i] === '--file' || args[i] === '-f') && args[i + 1]) {
      filePath = args[i + 1]; i += 2;
    } else if (args[i] === '--execute' || args[i] === '-x') {
      execute = true; i++;
    } else {
      rest.push(args[i]); i++;
    }
  }
  return { filePath, execute, taskText: rest.join(' ').trim() || null };
}

// ── Domain helpers ────────────────────────────────────────────────────────────
function getDomain() {
  try { return new URL(process.env.TARGET_URL || 'https://atb.tn').hostname.replace(/^www\./, ''); }
  catch { return 'atb.tn'; }
}

let _knownUrls = null;
function getKnownUrls() {
  if (_knownUrls) return _knownUrls;
  const loaded = A.loadSiteIndex();
  _knownUrls = new Set();
  if (!loaded) return _knownUrls;
  for (const e of (loaded.raw.agentIndex || [])) {
    if (e.url) _knownUrls.add(e.url);
    for (const dl of (e.downloads || [])) if (dl.href) _knownUrls.add(dl.href);
    for (const lk of (e.links     || [])) if (lk.href) _knownUrls.add(lk.href);
  }
  for (const u of (loaded.raw.discoveredUrls || [])) _knownUrls.add(u);
  return _knownUrls;
}

// ── Core pipeline ─────────────────────────────────────────────────────────────
async function runTask(message, { execute = false } = {}) {
  const domain   = getDomain();
  const startMs  = Date.now();

  // Full production path — real Gemma calls, debug metadata attached.
  const decision = await A.decideAction(message, { allowedDomain: domain, debug: true });
  const elapsed  = Date.now() - startMs;

  const dbg           = decision._debug || {};
  const intent        = dbg.intent || { resourceType: decision.resourceType, terms: [], confidence: 0, target: '' };
  const candidates    = dbg.candidates || [];
  const selectedId    = dbg.selectedId  ?? null;
  const selectionMode = dbg.selectionMode || 'unknown';
  const pool          = dbg.pool || [];
  const cleanedTerms  = dbg.cleanedTerms || [];
  const expandedTerms = dbg.expandedTerms || [];
  const bridgePages   = dbg.bridgePages || [];
  const bridgeTerms   = dbg.bridgeTerms || [];

  const action    = decision.action || { type: 'not_found' };
  const actionUrl = action.documentUrl || action.url || '';
  const known     = getKnownUrls();

  const isNavAction = ['navigate', 'download', 'navigate_then_download'].includes(action.type);
  // browserSkipped: action would trigger pageNavigator but --execute was not passed.
  const browserSkipped = !execute && decision.found && isNavAction;

  const taskResult = {
    message,
    execute,        // was --execute passed?
    browserSkipped, // dry-run: navigator call was intentionally omitted
    cleanedTerms,
    expandedTerms,
    bridgePages,
    bridgeTerms,
    intent,
    pool:       pool.map((p) => ({ type: p.type, title: p.title, url: p.url, score: +Number(p.score).toFixed(3) })),
    candidates: candidates.map((c) => ({
      id: c.id, title: c.title, fileType: c.fileType,
      type:  c._record?.type,
      url:   c._record?.url,
      score: c._record?.score != null ? +Number(c._record.score).toFixed(3) : null,
    })),
    selectedId,
    selectionMode,
    decision: {
      found:        decision.found,
      resourceType: decision.resourceType,
      confidence:   decision.confidence,
      action,
      topMatches:   decision.topMatches,
      answer:       decision.answer,
      reason:       decision.reason,
    },
    validation: {
      actionUrl,
      urlInIndex:  actionUrl ? known.has(actionUrl) : null,
      urlInDomain: actionUrl ? String(actionUrl).includes(domain) : null,
    },
    elapsed,
    executeResult: null,
  };

  if (execute && decision.found && isNavAction) {
    taskResult.executeResult = await runExecute(action);
  }

  // Semantic check against expected.json (if entry exists for this task)
  const expected = getExpectedMap().get(message.trim());
  taskResult.semanticChecks = runSemanticCheck(taskResult, expected);
  taskResult.semanticExpected = expected || null;

  return taskResult;
}

// ── CDP execution (--execute mode) ────────────────────────────────────────────
async function runExecute(action) {
  const type = action.type;
  let jobId;

  if (type === 'navigate') {
    jobId = nav.createPageFastPathJob({
      title:         action.title || action.highlightText || '',
      pageUrl:       action.url,
      highlightText: action.highlightText || '',
    });
  } else {
    // download | navigate_then_download
    jobId = nav.createDocFastPathJob({
      title:   action.title || '',
      pageUrl: action.sourceUrl || null,
      docUrl:  action.documentUrl || action.url,
    });
  }

  nav.launchBrowserAgentJob(jobId);

  const TIMEOUT_MS = 30_000;
  const POLL_MS    = 250;
  const deadline   = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    const job = nav.getBrowserAgentJob(jobId);
    if (!job) break;
    if (job.status === 'done' || job.status === 'failed') {
      return { jobId, status: job.status, finalAnswer: job.finalAnswer || null };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  return { jobId, status: 'timeout', finalAnswer: null };
}

// ── Pretty-print (single task) ────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[90m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  blue:   '\x1b[34m',
};

function statusLabel(result) {
  const t = result.decision.action.type;
  if (t === 'not_found')   return 'NOT_FOUND';
  if (t === 'suggestions') return 'SUGGESTIONS';
  if (!result.decision.found) return 'FAIL';
  // Semantic check: if checks present and any failed → WRONG_MATCH
  if (result.semanticChecks && result.semanticChecks.some((c) => !c.ok)) return 'WRONG_MATCH';
  return 'PASS';
}

function printTask(result) {
  const HR = `${C.bold}${'─'.repeat(64)}${C.reset}`;

  const modeLabel = result.execute
    ? `${C.green}Act on site${C.reset} (--execute: pageNavigator enabled)`
    : `${C.cyan}Act on site${C.reset} (dry-run: decision only, no browser)`;

  console.log(`\n${HR}`);
  console.log(`${C.bold}MODE${C.reset}  ${modeLabel}`);
  console.log(`${C.bold}TASK${C.reset}  ${result.message}`);
  console.log(HR);

  // ── Intent
  const intent = result.intent;
  const rtColor = intent.resourceType === 'document' ? C.yellow
    : intent.resourceType === 'page' ? C.cyan : C.dim;
  console.log(`\n${C.bold}INTENT${C.reset}  (Gemma)`);
  console.log(`  resourceType  ${rtColor}${intent.resourceType}${C.reset}`);
  console.log(`  target        ${intent.target || C.dim + '(none)' + C.reset}`);
  console.log(`  terms         ${JSON.stringify(intent.terms)}`);
  console.log(`  confidence    ${Number(intent.confidence).toFixed(2)}`);

  // ── Cleaned / expanded terms
  const dbg = result._dbg || {};  // passed through from runTask
  if (result.cleanedTerms?.length) {
    console.log(`\n${C.bold}CLEANED TERMS${C.reset}  (after STOP filter, before synonym expansion)`);
    console.log(`  ${JSON.stringify(result.cleanedTerms)}`);
  }
  if (result.expandedTerms?.length) {
    console.log(`\n${C.bold}EXPANDED TERMS${C.reset}  (after synonym expansion)`);
    console.log(`  ${JSON.stringify(result.expandedTerms.slice(0, 20))}`);
  }

  // ── Bridge pages
  const bridges = result.bridgePages || [];
  if (bridges.length > 0) {
    console.log(`\n${C.bold}BRIDGE PAGES${C.reset}  (index-matched pages for document context)`);
    bridges.forEach((b, i) => {
      console.log(`  [p${i}] ${C.dim}score=${b.score}${C.reset}  ${b.label || b.path}`);
    });
    if (result.bridgeTerms?.length) {
      console.log(`  bridge tokens: ${C.dim}${JSON.stringify(result.bridgeTerms.slice(0, 12))}${C.reset}`);
    }
  }

  // ── Candidates
  const cands = result.candidates;
  if (cands.length > 0) {
    console.log(`\n${C.bold}CANDIDATES${C.reset}  (top ${cands.length} from site-index.json)`);
    for (const c of cands) {
      const isSel  = c.id === result.selectedId;
      const selMark = isSel ? `  ${C.green}← selected${C.reset}` : '';
      const tColor = c.type === 'document' ? C.yellow : C.cyan;
      const urlSeg = (c.url || '').replace(/^https?:\/\/[^/]+/, '').slice(0, 55);
      console.log(`  [${C.bold}${c.id}${C.reset}]  ${tColor}${(c.type || '?').padEnd(8)}${C.reset}  score=${String(c.score ?? '?').padStart(5)}  ${c.title}${selMark}`);
      console.log(`         ${C.dim}${urlSeg}${C.reset}`);
    }
    const modeColor = result.selectionMode === 'gemma' ? C.green
      : result.selectionMode === 'deterministic' ? C.cyan : C.dim;
    console.log(`  ${C.dim}selection: ${modeColor}${result.selectionMode}${C.reset}`);
  } else if (result.decision.topMatches?.length) {
    console.log(`\n${C.bold}TOP MATCHES${C.reset}`);
    for (const m of result.decision.topMatches) {
      const url = (m.url || '').replace(/^https?:\/\/[^/]+/, '');
      console.log(`  ${m.type}  score=${m.score}  ${m.title}`);
      console.log(`  ${C.dim}${url}${C.reset}`);
    }
  }

  // ── Action
  const action  = result.decision.action;
  const atColor = result.decision.found ? C.green
    : action.type === 'suggestions' ? C.yellow : C.red;
  console.log(`\n${C.bold}ACTION${C.reset}`);
  console.log(`  type          ${atColor}${action.type}${C.reset}`);
  if (action.url)         console.log(`  url           ${action.url}`);
  if (action.documentUrl) console.log(`  documentUrl   ${action.documentUrl}`);
  if (action.sourceUrl)   console.log(`  sourceUrl     ${action.sourceUrl}`);
  if (action.title)       console.log(`  title         ${action.title}`);
  console.log(`  confidence    ${result.decision.confidence}`);
  console.log(`  reason        ${C.dim}${result.decision.reason}${C.reset}`);

  // ── Validation
  const v = result.validation;
  if (v.actionUrl) {
    const inIdx = v.urlInIndex  ? `${C.green}✓ in index${C.reset}`    : `${C.red}✗ NOT in index${C.reset}`;
    const inDom = v.urlInDomain ? `${C.green}✓ in domain${C.reset}` : `${C.red}✗ outside domain${C.reset}`;
    console.log(`\n${C.bold}VALIDATION${C.reset}`);
    console.log(`  ${v.actionUrl}`);
    console.log(`  ${inIdx}  |  ${inDom}`);
  }

  // ── Browser execution section
  const isNavAction = ['navigate', 'download', 'navigate_then_download'].includes(action.type);
  if (result.decision.found && isNavAction) {
    if (result.browserSkipped) {
      const navFn = action.type === 'navigate' ? 'createPageFastPathJob' : 'createDocFastPathJob';
      console.log(`\n${C.bold}BROWSER${C.reset}  ${C.yellow}DRY-RUN — pageNavigator.service.js not called${C.reset}`);
      console.log(`  Would call  ${C.dim}${navFn}${C.reset}  then  ${C.dim}launchBrowserAgentJob${C.reset}`);
      console.log(`  Pass ${C.bold}--execute${C.reset} to trigger visible browser navigation`);
    } else if (result.executeResult) {
      const er = result.executeResult;
      const navFn = action.type === 'navigate' ? 'createPageFastPathJob' : 'createDocFastPathJob';
      console.log(`\n${C.bold}BROWSER${C.reset}  ${C.green}--execute → pageNavigator.service.js called${C.reset}`);
      console.log(`  function  ${navFn}`);
      console.log(`  jobId     ${er.jobId}`);
      console.log(`  status    ${er.status === 'done' ? C.green : C.red}${er.status}${C.reset}`);
      if (er.finalAnswer) console.log(`  answer    ${er.finalAnswer.slice(0, 300)}`);
    }
  }

  // ── Semantic check
  if (result.semanticChecks) {
    console.log(`\n${C.bold}SEMANTIC CHECK${C.reset}`);
    for (const ch of result.semanticChecks) {
      const icon = ch.ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
      console.log(`  ${icon} ${ch.label}`);
    }
  } else if (result.semanticExpected === null && result.semanticExpected !== undefined) {
    console.log(`\n${C.bold}SEMANTIC CHECK${C.reset}  ${C.dim}(no expected entry for this task)${C.reset}`);
  }

  // ── Status line
  const label      = statusLabel(result);
  const labelColor = label === 'PASS' ? C.green
    : label === 'WRONG_MATCH' ? C.red
    : label === 'SUGGESTIONS' ? C.yellow : C.red;
  console.log(`\n${C.bold}STATUS${C.reset}  ${labelColor}${label}${C.reset}  (${result.elapsed}ms)\n`);
}

// ── Batch mode ────────────────────────────────────────────────────────────────
const REPORTS_DIR = path.resolve(__dirname, '..', 'reports', 'agent-task-runs');

async function runBatch(filePath, { execute = false } = {}) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    console.error(`File not found: ${abs}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(abs, 'utf-8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  if (lines.length === 0) { console.error('No tasks in file.'); process.exit(1); }

  const timestamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const jsonlPath = path.join(REPORTS_DIR, `${timestamp}.jsonl`);
  const mdPath    = path.join(REPORTS_DIR, `${timestamp}.md`);
  const jsonl     = fs.createWriteStream(jsonlPath, { flags: 'w' });

  const mdRows = [
    '# Agent task batch run',
    '',
    `- **Source**: \`${path.basename(abs)}\``,
    `- **Date**: ${new Date().toISOString()}`,
    `- **Tasks**: ${lines.length}`,
    execute ? '- **Execute**: true (CDP)' : '- **Execute**: false (dry-run)',
    '',
    '| # | Status | resourceType | actionType | conf | Task |',
    '|---|--------|-------------|------------|------|------|',
  ];

  console.log(`\nBatch: ${lines.length} tasks  source=${path.basename(abs)}\n`);

  let pass = 0, sugg = 0, notFound = 0, wrongMatch = 0, fail = 0;

  for (let i = 0; i < lines.length; i++) {
    const msg = lines[i];
    const num = String(i + 1).padStart(2);
    process.stdout.write(`[${num}/${lines.length}] `);

    try {
      const result = await runTask(msg, { execute });
      const label  = statusLabel(result);
      const at     = result.decision.action.type;
      const rt     = result.decision.resourceType;
      const conf   = Number(result.decision.confidence).toFixed(2);

      const lc = label === 'PASS' ? C.green : label === 'SUGGESTIONS' ? C.yellow : label === 'WRONG_MATCH' ? C.red : C.red;
      process.stdout.write(`${lc}${label}${C.reset}  ${rt}  ${at}  conf=${conf}  ${C.dim}${msg.slice(0, 60)}${C.reset}\n`);

      jsonl.write(JSON.stringify({
        n: i + 1, label, message: msg, resourceType: rt, actionType: at, confidence: conf,
        actionUrl: result.validation.actionUrl,
        urlInIndex: result.validation.urlInIndex,
        selectedId: result.selectedId,
        selectionMode: result.selectionMode,
        elapsed: result.elapsed,
        topMatches: result.decision.topMatches,
      }) + '\n');

      const shortMsg = msg.length > 65 ? msg.slice(0, 62) + '…' : msg;
      mdRows.push(`| ${i + 1} | **${label}** | ${rt} | ${at} | ${conf} | ${shortMsg} |`);

      if (label === 'PASS')             pass++;
      else if (label === 'SUGGESTIONS') sugg++;
      else if (label === 'NOT_FOUND')   notFound++;
      else if (label === 'WRONG_MATCH') wrongMatch++;
      else fail++;

    } catch (err) {
      process.stdout.write(`${C.red}ERROR${C.reset}  ${err.message}\n`);
      jsonl.write(JSON.stringify({ n: i + 1, label: 'ERROR', message: msg, error: err.message }) + '\n');
      mdRows.push(`| ${i + 1} | **ERROR** | – | – | – | ${msg.slice(0, 65)} |`);
      fail++;
    }
  }

  jsonl.end();

  mdRows.push(
    '', '---', '',
    '## Summary', '',
    '| Outcome | Count |', '|---------|-------|',
    `| PASS | ${pass} |`,
    `| WRONG_MATCH | ${wrongMatch} |`,
    `| SUGGESTIONS | ${sugg} |`,
    `| NOT_FOUND | ${notFound} |`,
    `| FAIL / ERROR | ${fail} |`,
    '', `**Total**: ${lines.length}`,
  );

  fs.writeFileSync(mdPath, mdRows.join('\n'), 'utf-8');

  console.log('\n' + '─'.repeat(48));
  console.log(`  PASS          ${pass}`);
  console.log(`  WRONG_MATCH   ${wrongMatch}`);
  console.log(`  SUGGESTIONS   ${sugg}`);
  console.log(`  NOT_FOUND     ${notFound}`);
  console.log(`  FAIL/ERROR    ${fail}`);
  console.log('─'.repeat(48));
  console.log(`  JSONL  ${jsonlPath}`);
  console.log(`  MD     ${mdPath}\n`);
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  const { filePath, execute, taskText } = parseArgs(process.argv);

  if (!filePath && !taskText) {
    console.error([
      'Usage:',
      '  node scripts/run-agent-task.js "task text"',
      '  node scripts/run-agent-task.js --execute "task text"',
      '  node scripts/run-agent-task.js --file tests/agent/complex-fr-tasks.txt',
      '  node scripts/run-agent-task.js --file tests/agent/complex-fr-tasks.txt --execute',
    ].join('\n'));
    process.exit(1);
  }

  if (filePath) {
    await runBatch(filePath, { execute });
  } else {
    const result = await runTask(taskText, { execute });
    printTask(result);
  }
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message || err}`);
  process.exit(1);
});
