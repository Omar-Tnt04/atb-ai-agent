'use strict';
/**
 * pageNavigator.service.js — visible same-tab browser control via Chrome CDP.
 *
 * Drives the user's already-open Chrome tab (connected over CDP) to:
 *   - navigate to a page         (cdpNavigatePage)
 *   - scroll to + highlight + open a document link (cdpNavigateDocument)
 *
 * Decisions come from the deterministic site index (siteIndexAgent.service.js),
 * NOT from any LLM / browser-use / Ollama agent. There is NO Python fallback:
 * if CDP navigation fails, the job returns a deterministic message with the
 * direct URL so the user can click it.
 *
 * Two-phase async jobs keep the widget contract intact:
 *   createPageFastPathJob / createDocFastPathJob → queued jobId
 *   launchBrowserAgentJob(jobId)                  → runs CDP navigation
 *   getBrowserAgentJob(jobId)                     → poll status
 */

const crypto = require('crypto');
const http   = require('http');

const { isDemoMode, stepLog, runWithTrace } = require('../utils/demoLogger');
const { linkJobToTrace, getTraceIdForJob, markTraceDone } = require('./traceBuffer.service');

// ── Dangerous-action guard for menu/link interaction ─────────────────────────
const DANGEROUS_RE =
  /\b(delete|remove|logout|signout|sign.out|pay|transfer|submit|save|confirm|checkout|order|purchase|buy|cancel)\b/i;

function shortId(jobId) { return String(jobId || '').slice(0, 5); }

function _isSystemUrl(url) {
  return !url || /^(chrome:|devtools:|about:|chrome-extension:|data:|javascript:)/i.test(url);
}

// ---------------------------------------------------------------------------
// CDP preflight — quick HTTP check before driving the tab.
// ---------------------------------------------------------------------------
function _checkCdpReachable() {
  const cdpUrl = process.env.CDP_URL || 'http://127.0.0.1:9222';
  return new Promise((resolve) => {
    try {
      const u = new URL('/json/version', cdpUrl);
      const req = http.get(u.href, { timeout: 2000 }, (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    } catch {
      resolve(false);
    }
  });
}

// Returns the first Chrome tab whose URL contains docFilename or equals docUrl, or null.
function _findDocumentTab(cdpBase, docFilename, docUrl) {
  return new Promise((resolve) => {
    try {
      const u = new URL('/json/list', cdpBase);
      const req = http.get(u.href, { timeout: 2000 }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          try {
            const tabs = JSON.parse(buf);
            if (!Array.isArray(tabs)) return resolve(null);
            const docTab = tabs.find((t) =>
              t.type === 'page' && t.url && (
                (docFilename && t.url.toLowerCase().includes(docFilename)) ||
                t.url === docUrl
              )
            );
            resolve(docTab || null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

// Brings a Chrome tab to the front via GET /json/activate/{id}.
function _activateCdpTab(cdpBase, tabId) {
  return new Promise((resolve) => {
    try {
      const actReq = http.get(
        `${cdpBase}/json/activate/${encodeURIComponent(tabId)}`,
        { timeout: 2000 },
        (r) => { r.resume(); resolve(); }
      );
      actReq.on('error', () => resolve());
    } catch { resolve(); }
  });
}

// Checks a Chrome tab's visible content for WAF/rejection patterns via a brief CDP WS.
async function _tabIsWafPage(tabWsUrl) {
  if (!tabWsUrl) return false;
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(tabWsUrl);
      let settled = false;
      const fin = (v) => { if (!settled) { settled = true; try { ws.close(); } catch {} resolve(v); } };
      ws.onerror = () => fin(false);
      ws.onopen = () => {
        const msgId = 1;
        const timer = setTimeout(() => fin(false), 5000);
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(String(ev.data));
            if (msg.id === msgId) {
              clearTimeout(timer);
              const text = String(msg?.result?.result?.value || '').toLowerCase();
              fin(/request.?rejected|requested url was rejected|support.?id|access.?denied|not.?found|\b404\b/i.test(text));
            }
          } catch { fin(false); }
        };
        ws.send(JSON.stringify({
          id: msgId, method: 'Runtime.evaluate',
          params: {
            expression: `(document.title + ' ' + (document.body ? document.body.innerText.slice(0, 300) : '')).slice(0, 400)`,
            returnByValue: true, awaitPromise: false,
          },
        }));
      };
      setTimeout(() => fin(false), 6000);
    } catch { resolve(false); }
  });
}

// Opens a new Chrome tab at url via Target.createTarget on the browser-level CDP WS.
// Bypasses Chrome's popup blocker. Returns targetId on success, or null.
async function _cdpOpenNewTab(cdpBase, url) {
  const ver = await new Promise((resolve) => {
    try {
      const req = http.get(`${cdpBase}/json/version`, { timeout: 2000 }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
  const bWsUrl = ver?.webSocketDebuggerUrl;
  if (!bWsUrl) return null;

  return new Promise((resolve) => {
    try {
      const bws = new WebSocket(bWsUrl);
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; try { bws.close(); } catch {} resolve(v); } };
      let bid = 1;
      const bp = new Map();
      const bsend = (method, params = {}) => new Promise((res, rej) => {
        const id = bid++;
        const timer = setTimeout(() => { bp.delete(id); rej(new Error(`browser CDP timeout: ${method}`)); }, 8000);
        bp.set(id, { resolve: (v) => { clearTimeout(timer); res(v); }, reject: (e) => { clearTimeout(timer); rej(e); } });
        bws.send(JSON.stringify({ id, method, params }));
      });
      bws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          const cb = msg.id && bp.get(msg.id);
          if (cb) { bp.delete(msg.id); msg.error ? cb.reject(new Error(msg.error.message)) : cb.resolve(msg.result); }
        } catch {}
      };
      bws.onerror = () => done(null);
      bws.onopen = async () => {
        try {
          const r = await bsend('Target.createTarget', { url });
          done(r?.targetId || null);
        } catch { done(null); }
      };
      setTimeout(() => done(null), 8000);
    } catch { resolve(null); }
  });
}

// ---------------------------------------------------------------------------
// CDP navigation — document fast path.
// Navigates the active ATB tab to the source page, finds the document link by
// href/text match, scrolls to it, highlights it, then clicks it. Falls back to
// browser-level Target.createTarget if the click is popup-blocked.
// Returns { url } on success (actual visible tab URL), or false on any error.
// ---------------------------------------------------------------------------
async function cdpNavigateDocument(pageUrl, docUrl, { title = '', linkText = '', onConnected, onNavPage, onFindLink, onScroll, onClick, onVerify, onOpenForce, onNavDoc } = {}) {
  const cdpBase = process.env.CDP_URL || 'http://127.0.0.1:9222';
  let hostname = 'atb.tn';
  try { hostname = new URL(process.env.TARGET_URL || 'https://atb.tn').hostname; } catch {}

  let docFilename = '';
  try {
    docFilename = new URL(docUrl).pathname.split('/').pop().split('?')[0].toLowerCase();
  } catch {
    docFilename = (docUrl || '').split('/').pop().split('?')[0].toLowerCase();
  }

  const titleTokens = (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((s) => s.length > 2);

  const linkTokens = (linkText || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((s) => s.length > 2);

  const tabs = await new Promise((resolve) => {
    try {
      const u = new URL('/json/list', cdpBase);
      const req = http.get(u.href, { timeout: 3000 }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });

  if (!Array.isArray(tabs)) return false;

  const atbTab = tabs.find((t) => t.type === 'page' && t.url && t.url.includes(hostname));
  const wsUrl = atbTab?.webSocketDebuggerUrl;
  if (!wsUrl) return false;

  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (!settled) { settled = true; try { ws.close(); } catch {} resolve(ok); }
    };

    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();

    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP timeout: ${method}`)); }, 10000);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); res(v); },
        reject: (e) => { clearTimeout(timer); rej(e); },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        const cb = msg.id && pending.get(msg.id);
        if (cb) {
          pending.delete(msg.id);
          if (msg.error) cb.reject(new Error(msg.error.message));
          else cb.resolve(msg.result);
        }
      } catch {}
    };

    ws.onerror = () => done(false);

    ws.onopen = async () => {
      try {
        if (onConnected) onConnected();

        if (pageUrl) {
          if (onNavPage) onNavPage(pageUrl);
          await send('Page.navigate', { url: pageUrl });
          await new Promise((r) => setTimeout(r, 2500));
        }

        if (onFindLink) onFindLink();

        const findScript = `(function() {
  var _docUrl = ${JSON.stringify(docUrl)};
  var _docFilename = ${JSON.stringify(docFilename)};
  var _titleTokens = ${JSON.stringify(titleTokens)};
  var _linkTokens = ${JSON.stringify(linkTokens)};
  var links = Array.from(document.querySelectorAll('a[href]'));
  function score(el) {
    var href = (el.getAttribute('href') || '').toLowerCase();
    var hrefFile = href.split('/').pop().split('?')[0];
    var text = (el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    var titleAttr = (el.getAttribute('title') || '').toLowerCase();
    var s = 0;
    if (_docFilename && hrefFile === _docFilename) s += 100;
    else if (_docFilename && hrefFile.includes(_docFilename.replace(/\\.[^.]+$/, ''))) s += 60;
    if (_docFilename && href.includes(_docFilename)) s += 40;
    for (var i = 0; i < _titleTokens.length; i++) {
      if (text.includes(_titleTokens[i])) s += 10;
      if (titleAttr.includes(_titleTokens[i])) s += 8;
    }
    for (var j = 0; j < _linkTokens.length; j++) {
      if (text.includes(_linkTokens[j])) s += 20;
    }
    return s;
  }
  var candidates = links
    .map(function(el) { return { el: el, s: score(el) }; })
    .filter(function(x) { return x.s > 0; })
    .sort(function(a, b) { return b.s - a.s; });
  if (!candidates.length) return { found: false };
  var best = candidates[0].el;
  best.scrollIntoView({ block: 'center', behavior: 'instant' });
  var prevOutline = best.style.outline;
  var prevBg = best.style.background;
  best.style.outline = '3px solid #f5a623';
  best.style.background = 'rgba(245,166,35,0.25)';
  best.setAttribute('data-atb-fp', '1');
  setTimeout(function() {
    var el = document.querySelector('[data-atb-fp="1"]');
    if (el) {
      el.style.outline = prevOutline;
      el.style.background = prevBg;
      el.removeAttribute('data-atb-fp');
    }
  }, 3000);
  var r = best.getBoundingClientRect();
  return {
    found: true,
    href: best.getAttribute('href') || '',
    hrefResolved: best.href || '',
    text: (best.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
    rect: { x: r.left, y: r.top, width: r.width, height: r.height }
  };
})()`;

        const findResult = await send('Runtime.evaluate', {
          expression: findScript,
          returnByValue: true,
          awaitPromise: false,
        });

        const findVal = findResult?.result?.value;

        if (findVal?.found) {
          if (onScroll) onScroll();
          await new Promise((r) => setTimeout(r, 1200));

          if (onClick) onClick();

          const cx = Math.round((findVal.rect?.x || 0) + (findVal.rect?.width || 0) / 2);
          const cy = Math.round((findVal.rect?.y || 0) + (findVal.rect?.height || 0) / 2);
          try {
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none' });
            await new Promise((r) => setTimeout(r, 80));
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1, modifiers: 0 });
            await new Promise((r) => setTimeout(r, 50));
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1, modifiers: 0 });
          } catch (mouseErr) {
            if (!isDemoMode()) console.log(`[DOC_FAST_PATH] Mouse event error: ${mouseErr.message}`);
          }

          await new Promise((r) => setTimeout(r, 2500));
          if (onVerify) onVerify();

          let docTab = await _findDocumentTab(cdpBase, docFilename, docUrl);
          if (docTab) {
            const isError = await _tabIsWafPage(docTab.webSocketDebuggerUrl);
            if (!isError) {
              await _activateCdpTab(cdpBase, docTab.id);
              done({ url: docTab.url });
              return;
            }
            if (!isDemoMode()) console.log(`[DOC_FAST_PATH] Error page on clicked tab — falling back to direct open`);
          }

          const openUrl = findVal.hrefResolved || docUrl;
          if (onOpenForce) onOpenForce(openUrl);
          await _cdpOpenNewTab(cdpBase, openUrl);
          await new Promise((r) => setTimeout(r, 2000));
          docTab = await _findDocumentTab(cdpBase, docFilename, openUrl);
          if (docTab) {
            const isError2 = await _tabIsWafPage(docTab.webSocketDebuggerUrl);
            if (!isError2) {
              await _activateCdpTab(cdpBase, docTab.id);
              done({ url: docTab.url });
            } else {
              if (!isDemoMode()) console.log(`[DOC_FAST_PATH] Error page on forced-open tab — giving up`);
              done(false);
            }
          } else {
            done(false);
          }
          return;
        }

        // Link not found on source page — open directly via browser-level CDP.
        if (onNavDoc) onNavDoc(docUrl);
        await _cdpOpenNewTab(cdpBase, docUrl);
        await new Promise((r) => setTimeout(r, 1000));
        if (onVerify) onVerify();
        const fbTab = await _findDocumentTab(cdpBase, docFilename, docUrl);
        if (fbTab) {
          const wafFb = await _tabIsWafPage(fbTab.webSocketDebuggerUrl);
          if (!wafFb) {
            await _activateCdpTab(cdpBase, fbTab.id);
            done({ url: fbTab.url });
          } else {
            if (!isDemoMode()) console.log(`[DOC_FAST_PATH] Error page on fallback tab — giving up`);
            done(false);
          }
        } else {
          done(false);
        }
      } catch (e) {
        if (!isDemoMode()) console.error(`[CDP_FAST_PATH] error: ${e.message}`);
        done(false);
      }
    };

    setTimeout(() => done(false), 20000);
  });
}

// ---------------------------------------------------------------------------
// CDP navigation — page fast path.
// Navigates the active ATB tab to pageUrl, waits for load, reads location.href.
// Returns { url } on success, false on any error.
// ---------------------------------------------------------------------------
async function cdpNavigatePage(pageUrl, { title = '', onConnected, onNavigate, onVerify } = {}) {
  const cdpBase = process.env.CDP_URL || 'http://127.0.0.1:9222';
  let hostname = 'atb.tn';
  try { hostname = new URL(process.env.TARGET_URL || 'https://atb.tn').hostname; } catch {}

  const tabs = await new Promise((resolve) => {
    try {
      const u = new URL('/json/list', cdpBase);
      const req = http.get(u.href, { timeout: 3000 }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });

  if (!Array.isArray(tabs)) return false;

  const atbTab = tabs.find((t) => t.type === 'page' && t.url && t.url.includes(hostname));
  const wsUrl = atbTab?.webSocketDebuggerUrl;
  if (!wsUrl) return false;

  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (!settled) { settled = true; try { ws.close(); } catch {} resolve(ok); }
    };

    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();

    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP timeout: ${method}`)); }, 10000);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); res(v); },
        reject: (e) => { clearTimeout(timer); rej(e); },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        const cb = msg.id && pending.get(msg.id);
        if (cb) {
          pending.delete(msg.id);
          if (msg.error) cb.reject(new Error(msg.error.message));
          else cb.resolve(msg.result);
        }
      } catch {}
    };

    ws.onerror = () => done(false);

    ws.onopen = async () => {
      try {
        if (onConnected) onConnected();
        if (onNavigate) onNavigate(pageUrl);
        await send('Page.navigate', { url: pageUrl });
        await new Promise((r) => setTimeout(r, 2500));
        if (onVerify) onVerify();
        const evalResult = await send('Runtime.evaluate', {
          expression: 'window.location.href',
          returnByValue: true,
        });
        const actualUrl = evalResult?.result?.value || pageUrl;
        done(actualUrl && actualUrl.startsWith('http') ? { url: actualUrl } : { url: pageUrl });
      } catch (e) {
        if (!isDemoMode()) console.error(`[PAGE_FAST_PATH] error: ${e.message}`);
        done(false);
      }
    };

    setTimeout(() => done(false), 15000);
  });
}

// ---------------------------------------------------------------------------
// Two-phase async job store.
// ---------------------------------------------------------------------------
const jobs = new Map();
const JOB_TTL_MS = 10 * 60 * 1000;

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.updatedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

// Deterministic message shown when CDP can't drive the visible tab.
function _cdpUnavailableMessage(kind, title, url) {
  const label = title ? `**${title}**` : 'the requested resource';
  return [
    `I couldn't open ${label} in the browser — Chrome is not connected for visible control.`,
    `Direct ${kind === 'document' ? 'download' : 'link'}: ${url}`,
  ].join('\n');
}

function createDocFastPathJob({ title, pageUrl, docUrl, linkText, traceId } = {}) {
  pruneJobs();
  const jobId = crypto.randomBytes(8).toString('hex');
  jobs.set(jobId, {
    status: 'queued',
    jobType: 'doc_fast_path',
    title: String(title || 'document'),
    pageUrl: pageUrl || null,
    docUrl: String(docUrl || ''),
    linkText: String(linkText || ''),
    updatedAt: Date.now(),
  });
  if (traceId) linkJobToTrace(jobId, traceId);
  if (!isDemoMode()) {
    console.log(`[DOC_FAST_PATH_JOB] queued job=${shortId(jobId)} title="${String(title || '').slice(0, 60)}" docUrl=${String(docUrl || '').slice(0, 80)}`);
  }
  return jobId;
}

function createPageFastPathJob({ title, pageUrl, traceId } = {}) {
  pruneJobs();
  const jobId = crypto.randomBytes(8).toString('hex');
  jobs.set(jobId, {
    status: 'queued',
    jobType: 'page_fast_path',
    title: String(title || 'page'),
    pageUrl: String(pageUrl || ''),
    updatedAt: Date.now(),
  });
  if (traceId) linkJobToTrace(jobId, traceId);
  if (!isDemoMode()) {
    console.log(`[PAGE_FAST_PATH_JOB] queued job=${shortId(jobId)} title="${String(title || '').slice(0, 60)}" pageUrl=${String(pageUrl || '').slice(0, 80)}`);
  }
  return jobId;
}

// Immediate-answer job — for actions that need no browser navigation
// (suggestions, not_found, plain answers).
function createAnswerJob(finalAnswer, traceId) {
  pruneJobs();
  const jobId = crypto.randomBytes(8).toString('hex');
  jobs.set(jobId, {
    status: 'done',
    finalAnswer: String(finalAnswer || 'Done.'),
    updatedAt: Date.now(),
  });
  if (traceId) linkJobToTrace(jobId, traceId);
  return jobId;
}

function launchBrowserAgentJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  if (job.status !== 'queued') return true;

  const _jobTraceId = getTraceIdForJob(jobId);
  const _runInCtx = (fn) => (_jobTraceId ? runWithTrace(_jobTraceId, fn) : fn());
  const _finish = (finalAnswer, status = 'done', extra = {}) => {
    jobs.set(jobId, { status, finalAnswer, updatedAt: Date.now(), ...extra });
    if (_jobTraceId) markTraceDone(_jobTraceId);
  };

  // --- Doc fast-path: visible CDP navigation, deterministic message on failure ---
  if (job.jobType === 'doc_fast_path') {
    const { title, pageUrl, docUrl, linkText } = job;
    const startedAt = Date.now();
    jobs.set(jobId, { ...job, status: 'running', startedAt, updatedAt: startedAt });
    if (!isDemoMode()) console.log(`[DOC_FAST_PATH_JOB] started job=${shortId(jobId)}`);

    _runInCtx(() => {
      cdpNavigateDocument(pageUrl, docUrl, {
        title,
        linkText,
        onConnected: () => { if (isDemoMode()) stepLog('Browser', 'CDP connected to existing Chrome'); else console.log('[DOC_FAST_PATH] CDP connected'); },
        onNavPage:   (url) => { if (isDemoMode()) stepLog('FastPathNav', `opening source page ${url}`); else console.log(`[DOC_FAST_PATH] nav source_page=${url}`); },
        onFindLink:  () => { if (isDemoMode()) stepLog('FastPathFind', 'locating document link on page'); else console.log('[DOC_FAST_PATH] locating document link'); },
        onScroll:    () => { if (isDemoMode()) stepLog('FastPathScroll', 'scrolled to document link'); else console.log('[DOC_FAST_PATH] scrolled to document link'); },
        onClick:     () => { if (isDemoMode()) stepLog('FastPathClick', 'clicked document link'); else console.log('[DOC_FAST_PATH] clicked document link'); },
        onVerify:    () => { if (isDemoMode()) stepLog('FastPathVerify', 'checking visible document tab'); else console.log('[DOC_FAST_PATH] verifying document tab'); },
        onOpenForce: (url) => { if (isDemoMode()) stepLog('FastPathOpen', 'opening document URL visibly'); else console.log(`[DOC_FAST_PATH] force-open doc_url=${url}`); },
        onNavDoc:    (url) => { if (isDemoMode()) stepLog('FastPathNav', `opening document ${url}`); else console.log(`[DOC_FAST_PATH] direct-open doc_url=${url}`); },
      })
        .then((cdpResult) => {
          const duration = Math.round((Date.now() - startedAt) / 1000);
          if (cdpResult && cdpResult.url) {
            const actualUrl = cdpResult.url;
            const lines = [`Found: **${title}**`];
            if (pageUrl) lines.push(`Source page: ${pageUrl}`);
            lines.push(`Download: ${actualUrl}`);
            _finish(lines.join('\n'));
            if (isDemoMode()) {
              stepLog('Document', title);
              stepLog('Final URL', actualUrl);
              stepLog('Done', `success — document visible (${duration}s)`);
            } else {
              console.log(`[DOC_FAST_PATH_JOB] done job=${shortId(jobId)} tab_url=${actualUrl} duration=${duration}s`);
            }
          } else {
            _finish(_cdpUnavailableMessage('document', title, docUrl));
            if (isDemoMode()) stepLog('Done', `failed — browser not connected (${duration}s)`);
            else console.log(`[DOC_FAST_PATH_JOB] cdp_unavailable job=${shortId(jobId)} duration=${duration}s`);
          }
        })
        .catch((err) => {
          const duration = Math.round((Date.now() - startedAt) / 1000);
          _finish(_cdpUnavailableMessage('document', title, docUrl), 'done');
          if (isDemoMode()) stepLog('Done', `failed — ${String(err.message || 'CDP error').split('\n')[0].slice(0, 60)} (${duration}s)`);
          else console.log(`[DOC_FAST_PATH_JOB] error job=${shortId(jobId)} duration=${duration}s err="${String(err.message || '').slice(0, 60)}"`);
        });
    });

    return true;
  }

  // --- Page fast-path: visible CDP navigation, deterministic message on failure ---
  if (job.jobType === 'page_fast_path') {
    const { title, pageUrl } = job;
    const startedAt = Date.now();
    jobs.set(jobId, { ...job, status: 'running', startedAt, updatedAt: startedAt });
    if (!isDemoMode()) console.log(`[PAGE_FAST_PATH_JOB] started job=${shortId(jobId)}`);

    _runInCtx(() => {
      cdpNavigatePage(pageUrl, {
        title,
        onConnected: () => { if (isDemoMode()) stepLog('Browser', 'CDP connected to existing Chrome'); else console.log('[PAGE_FAST_PATH] CDP connected'); },
        onNavigate:  (url) => { if (isDemoMode()) stepLog('FastPathPage', `opening page ${url}`); else console.log(`[PAGE_FAST_PATH] navigating url=${url}`); },
        onVerify:    () => { if (isDemoMode()) stepLog('FastPathVerify', 'verifying page URL'); else console.log('[PAGE_FAST_PATH] verifying page URL'); },
      })
        .then((result) => {
          const duration = Math.round((Date.now() - startedAt) / 1000);
          if (result && result.url) {
            const actualUrl = result.url;
            _finish(`Opened: **${title}**\nSource: ${actualUrl}\nDone.`);
            if (isDemoMode()) {
              stepLog('FastPathPage', `verified ${actualUrl}`);
              stepLog('Done', `success — page visible (${duration}s)`);
            } else {
              console.log(`[PAGE_FAST_PATH_JOB] done job=${shortId(jobId)} url=${actualUrl} duration=${duration}s`);
            }
          } else {
            _finish(_cdpUnavailableMessage('page', title, pageUrl));
            if (isDemoMode()) stepLog('Done', `failed — browser not connected (${duration}s)`);
            else console.log(`[PAGE_FAST_PATH_JOB] cdp_unavailable job=${shortId(jobId)} duration=${duration}s`);
          }
        })
        .catch((err) => {
          const duration = Math.round((Date.now() - startedAt) / 1000);
          _finish(_cdpUnavailableMessage('page', title, pageUrl), 'done');
          if (isDemoMode()) stepLog('Done', `failed — ${String(err.message || 'CDP error').split('\n')[0].slice(0, 60)} (${duration}s)`);
          else console.log(`[PAGE_FAST_PATH_JOB] error job=${shortId(jobId)} duration=${duration}s err="${String(err.message || '').slice(0, 60)}"`);
        });
    });

    return true;
  }

  return true;
}

function getBrowserAgentJob(jobId) {
  return jobs.get(jobId) || null;
}

module.exports = {
  checkCdpReachable: _checkCdpReachable,
  cdpNavigateDocument,
  cdpNavigatePage,
  createDocFastPathJob,
  createPageFastPathJob,
  createAnswerJob,
  launchBrowserAgentJob,
  getBrowserAgentJob,
  DANGEROUS_RE,
};
