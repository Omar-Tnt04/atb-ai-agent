const express = require('express');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const router = express.Router();

const CDP_PORT = Number(process.env.CHROME_CDP_PORT || 9222);
const TARGET_URL = process.env.TARGET_URL || 'https://atb.tn';
const CHROME_PATH =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CHROME_USER_DATA_DIR =
  process.env.CHROME_USER_DATA_DIR || 'C:\\temp\\atb-browser-agent-profile';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

function isEnabled() {
  return String(process.env.ENABLE_DEV_BROWSER_LAUNCHER || '').toLowerCase() === 'true';
}

function checkCdp() {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: '127.0.0.1', port: CDP_PORT, path: '/json/version', timeout: 1000 },
      (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 300); },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// Poll /json/list for up to maxMs to confirm the target tab appeared.
function pollCdpForTab(targetUrl, maxMs = 3000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + maxMs;
    function attempt() {
      const req = http.get(
        { hostname: '127.0.0.1', port: CDP_PORT, path: '/json/list', timeout: 500 },
        (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            try {
              const tabs = JSON.parse(body);
              if (tabs.some((t) => String(t.url || '').startsWith(targetUrl))) {
                resolve(true);
                return;
              }
            } catch { /* ignore parse errors */ }
            if (Date.now() < deadline) setTimeout(attempt, 500);
            else resolve(false);
          });
        },
      );
      req.on('error', () => {
        if (Date.now() < deadline) setTimeout(attempt, 500);
        else resolve(false);
      });
      req.on('timeout', () => {
        req.destroy();
        if (Date.now() < deadline) setTimeout(attempt, 500);
        else resolve(false);
      });
    }
    attempt();
  });
}

function errorPage(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;padding:2rem;max-width:600px;margin:0 auto}
code{background:#f4f4f4;padding:2px 5px;border-radius:3px}p{color:#555}a{color:#0066cc}</style>
</head><body><h2>${title}</h2>${body}</body></html>`;
}

function redirectPage(targetUrl) {
  const escaped = JSON.stringify(targetUrl);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Hosted demo opening</title>
<style>body{font-family:system-ui,sans-serif;padding:2rem;max-width:600px;margin:0 auto}
p{color:#555}a{color:#0066cc;font-weight:bold}</style>
<script>setTimeout(function(){ window.location.href = ${escaped}; }, 1000);</script>
</head><body>
<h2>Hosted demo opening…</h2>
<p>CDP Chrome already running. Redirecting this tab to ATB in 1 second…</p>
<p><a href="${targetUrl}">Open ATB manually</a></p>
</body></html>`;
}

function launchPage(targetUrl) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>CDP Chrome launching</title>
<style>body{font-family:system-ui,sans-serif;padding:2rem;max-width:600px;margin:0 auto}
p{color:#555}a{color:#0066cc;font-weight:bold}
.tip{background:#f0f4ff;border-left:4px solid #0066cc;padding:0.75rem 1rem;border-radius:3px;margin-top:1rem}</style>
</head><body>
<h2>CDP Chrome launching…</h2>
<p>A new Chrome window with the ATB widget extension is opening. Use that window for the demo.</p>
<div class="tip">
  <strong>This tab is not the demo.</strong><br>
  Switch to the new Chrome window and navigate to <a href="${targetUrl}" target="_blank">${targetUrl}</a> if it didn't open automatically.
</div>
</body></html>`;
}

router.get('/open-hosted-demo', async (req, res) => {
  if (!isEnabled()) {
    return res.status(403).send(
      errorPage(
        'Dev launcher disabled',
        '<p>Set <code>ENABLE_DEV_BROWSER_LAUNCHER=true</code> in <code>.env</code> to enable.</p>',
      ),
    );
  }

  console.log(`[DEV_LAUNCHER] opening target=${TARGET_URL} cdp=${CDP_PORT}`);

  try {
    const cdpAlive = await checkCdp();
    console.log(`[DEV_LAUNCHER] cdpAlive=${cdpAlive}`);

    if (cdpAlive) {
      // CDP Chrome already running — redirect this tab only, no spawn needed.
      console.log(`[DEV_LAUNCHER] branch=REDIRECT_ONLY (no spawn, old Chrome reused — flags NOT applied)`);
      console.log(`[DEV_LAUNCHER] CDP connected — redirecting launcher tab to ${TARGET_URL}`);
      res.send(redirectPage(TARGET_URL));
      pollCdpForTab(TARGET_URL, 3000).then((found) => {
        console.log(found
          ? `[DEV_LAUNCHER] verified target tab`
          : `[DEV_LAUNCHER] warning: target tab not detected within 3s`);
      });
      return;
    }

    // CDP not responding — spawn CDP Chrome with widget extension.
    // Do NOT redirect the launcher tab to ATB; ATB opens inside the new CDP Chrome window only.
    if (!fs.existsSync(CHROME_PATH)) {
      console.error(`[DEV_LAUNCHER] chrome not found at ${CHROME_PATH}`);
      return res.status(500).send(
        errorPage(
          'Chrome not found',
          `<p>Chrome not found at <code>${CHROME_PATH}</code>.</p>
           <p>Set <code>CHROME_PATH</code> in <code>backend-node/.env</code>.</p>`,
        ),
      );
    }

    const extensionPath =
      process.env.WIDGET_EXTENSION_PATH ||
      path.join(PROJECT_ROOT, 'widget-injector-extension');

    const allowLocalHttp =
      String(process.env.ALLOW_LOCAL_WIDGET_HTTP || '').toLowerCase() === 'true';
    console.log(`[DEV_LAUNCHER] allowLocalWidgetHttp=${allowLocalHttp}`);

    const args = [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${CHROME_USER_DATA_DIR}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Allow localhost HTTP iframe inside https://atb.tn (mixed content + private network).
      // Only active when ALLOW_LOCAL_WIDGET_HTTP=true. Never set this in production.
      ...(allowLocalHttp ? [
        '--allow-running-insecure-content',
        '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults',
      ] : []),
      '--new-window',
      TARGET_URL,
    ];

    const child = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
    child.unref();
    child.on('error', (err) => {
      console.error(`[DEV_LAUNCHER] chrome spawn error: ${err.message}`);
    });

    console.log(`[DEV_LAUNCHER] branch=SPAWN chrome_args=${JSON.stringify(args)}`);
    console.log(`[DEV_LAUNCHER] spawned CDP Chrome → ${TARGET_URL}`);
    res.send(launchPage(TARGET_URL));

    pollCdpForTab(TARGET_URL, 5000).then((found) => {
      console.log(found
        ? `[DEV_LAUNCHER] verified target tab in CDP Chrome`
        : `[DEV_LAUNCHER] warning: target tab not detected within 5s`);
    });
  } catch (err) {
    return res.status(500).send(
      errorPage('Launcher error', `<p>${err.message}</p>`),
    );
  }
});

const TUNNEL_URLS_PATH = path.join(PROJECT_ROOT, '.tunnel-urls.json');

// Returns the current tunnel URLs so the Chrome extension can fetch them on every page load
// instead of relying on the static widget-config.js. Written by scripts/dev/start.js after
// cloudflared URLs are detected.
router.get('/widget-config', (req, res) => {
  if (!isEnabled()) {
    return res.status(403).json({ error: 'Dev launcher disabled' });
  }
  res.set('Access-Control-Allow-Origin', '*');
  if (!fs.existsSync(TUNNEL_URLS_PATH)) {
    return res.status(503).json({ error: 'Tunnel URLs not yet available' });
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(TUNNEL_URLS_PATH, 'utf8'));
    res.json(cfg);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read tunnel config' });
  }
});

module.exports = router;
