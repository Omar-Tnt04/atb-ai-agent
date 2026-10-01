const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { extensionPagePlan } = require('../../backend-node/src/services/extensionPagePlan.service');

async function main() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    // Deliberately no CORS headers: requests must originate in the extension worker.
    if (req.url === '/health') return res.end(JSON.stringify({ success: true, service: 'ATB AI Banking Agent Backend' }));
    if (req.url === '/dev/widget-config') return res.end(JSON.stringify({ apiUrl: 'https://stale-tunnel.trycloudflare.com' }));
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = body ? JSON.parse(body) : {};
    requests.push({ url: req.url, payload, origin: req.headers.origin });
    if (payload.message === 'error test') { res.statusCode = 503; return res.end('{"message":"Test backend unavailable"}'); }
    if (payload.message === 'navigate test' && !payload.pageSnapshot?.url.endsWith('extension-test-next')) return res.end(JSON.stringify(extensionPagePlan({ type: 'navigate', url: 'https://atb.tn/extension-test-next' })));
    if (payload.message === 'document test') return res.end(JSON.stringify(extensionPagePlan({ type: 'download', url: 'https://atb.tn/extension-test.pdf' })));
    if (payload.message === 'source document test') return res.end(JSON.stringify(extensionPagePlan({ type: 'navigate_then_download', sourceUrl: 'https://atb.tn/extension-test-source', documentUrl: 'https://atb.tn/extension-test.pdf' })));
    if (payload.mode === 'act') {
      const target = payload.pageSnapshot?.headings.find(h => h.text === 'Contact ATB');
      return res.end(JSON.stringify({ success: true, assistantMessage: 'The contact heading is highlighted.', pagePlan: { status: 'done', actions: [{ type: 'highlight', ref: target?.ref }] } }));
    }
    res.end(JSON.stringify({ success: true, assistantMessage: 'ASK transport works through the extension service worker.' }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(5000, '127.0.0.1', resolve); });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'atb-extension-test-'));
  const extension = path.resolve('widget-injector-extension');
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], viewport: { width: 1280, height: 900 } });
    const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-src 'self' https://www.google.com";
    await context.route('https://atb.tn/extension-test*', route => route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': csp }, body: '<!doctype html><html><head><title>ATB CSP fixture</title></head><body><h1>Contact ATB</h1><p>Contact our customer service for account information.</p><a href="/extension-test-next">Next page</a></body></html>' }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); console.error(message.text().slice(0, 800)); } });
    console.log('Workers:', context.serviceWorkers().map(w => w.url()));
    const response = await page.goto('https://atb.tn/extension-test');
    assert.equal(response.headers()['content-security-policy'], csp);
    await page.locator('atb-assistant .chat-launcher').waitFor({ timeout: 10000 }).catch(async error => {
      console.log('DOM:', await page.evaluate(() => ({ html: document.documentElement.outerHTML.slice(-4000), shadow: document.querySelector('atb-assistant')?.shadowRoot?.innerHTML.slice(0, 2000) })));
      throw error;
    });
    assert.equal(await page.locator('iframe').count(), 0);
    await page.locator('.chat-launcher').click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('hello test');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('ASK transport works through the extension service worker.', { exact: true }).waitFor();
    assert.equal(requests[0].payload.clientCapabilities.contentScript, true);
    assert.equal(requests[0].payload.siteContext.title, 'ATB CSP fixture');
    assert(!requests[0].payload.siteContext.buttons.includes('Ask question'));
    await page.getByRole('button', { name: 'Act on site', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('highlight contact');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('body > h1').style.outline.includes('3px'));
    await page.getByText('The contact heading is highlighted.', { exact: true }).waitFor();
    await page.evaluate(() => window.postMessage({ type: 'ATB_WIDGET_FORCE_FRESH' }, '*'));
    assert.equal(await page.getByText('The contact heading is highlighted.', { exact: true }).count(), 1);
    await page.reload();
    await page.getByText('The contact heading is highlighted.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('atb_widget_')).length), 0);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const rules = await worker.evaluate(() => chrome.runtime.getManifest());
    assert(!rules.declarative_net_request);
    assert(!rules.permissions.some(p => /declarativeNetRequest|webRequest/.test(p)));
    assert.equal(await worker.evaluate(() => allowedSender({ id: chrome.runtime.id, url: 'https://evil.example/', frameId: 0, tab: { id: 1 } })), false);
    const bad = await worker.evaluate(async () => {
      try { await handle({ type: 'ATB_WIDGET_API', url: 'https://evil.example/' }, { tab: { id: 1 } }); return false; }
      catch { return true; }
    });
    assert.equal(bad, true);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('error test');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Sorry, an error occurred. Please try again.', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('navigate test');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForURL('https://atb.tn/extension-test-next');
    await page.getByText('The contact heading is highlighted.', { exact: true }).last().waitFor();
    await page.waitForFunction(() => document.querySelector('body > h1').style.outline.includes('3px'));
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('document test');
    const documentPagePromise = context.waitForEvent('page');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const documentPage = await documentPagePromise;
    await documentPage.waitForURL('https://atb.tn/extension-test.pdf');
    await documentPage.close();
    await page.getByText('Opening the document.', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('source document test');
    const sourcedDocumentPromise = context.waitForEvent('page');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForURL('https://atb.tn/extension-test-source');
    const sourcedDocument = await sourcedDocumentPromise;
    await sourcedDocument.waitForURL('https://atb.tn/extension-test.pdf');
    await sourcedDocument.close();
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    const font = await page.locator('.chat-input-form').evaluate(el => getComputedStyle(el).fontFamily);
    assert(font.includes('sans-serif'), font);
    const launcher = await page.locator('.chat-launcher').boundingBox();
    await page.mouse.move(launcher.x + 26, launcher.y + 26);
    await page.mouse.down();
    await page.mouse.move(850, 700, { steps: 5 });
    await page.mouse.up();
    await page.setViewportSize({ width: 390, height: 600 });
    const rect = await page.locator('.chat-window').boundingBox();
    assert(rect.x >= 0 && rect.x + rect.width <= 390 && rect.y >= 0 && rect.y + rect.height <= 600, JSON.stringify(rect));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: 'verification/extension-csp-fixture.png' });
    assert.deepEqual(errors, []);
    console.log('PASS: strict CSP unchanged; ASK; ACT highlight/navigation/resume; direct and source-page documents; drag/resize; private state restore; API errors; sender validation.');
    if (process.env.ATB_LIVE_TEST === '1') {
      const live = await context.newPage();
      const liveErrors = [];
      live.on('console', msg => { if (msg.type() === 'error' && /ATB widget|Content Security Policy|Refused to/i.test(msg.text())) liveErrors.push(msg.text()); });
      const liveResponse = await live.goto('https://atb.tn', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await live.locator('atb-assistant .chat-launcher').waitFor({ timeout: 20000 });
      await live.locator('atb-assistant .chat-launcher').click();
      await live.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
      await live.locator('.chat-window').evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)); });
      await live.screenshot({ path: 'verification/extension-live-atb.png' });
      console.log('LIVE CSP:', liveResponse.headers()['content-security-policy']);
      console.log('LIVE widget-related errors:', JSON.stringify(liveErrors));
      assert.deepEqual(liveErrors, []);
      console.log('PASS: packaged extension mounted on live https://atb.tn.');
    }
  } finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
