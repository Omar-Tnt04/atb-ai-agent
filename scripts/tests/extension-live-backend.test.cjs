// Optional integration test: real ATB site, unpacked extension, running local backend/models.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');

async function main() {
  const health = await fetch('http://127.0.0.1:5000/health').then(r => r.json());
  assert.equal(health.service, 'ATB AI Banking Agent Backend');
  const extension = path.resolve('widget-injector-extension');
  const output = path.resolve('verification/site-refresh');
  fs.mkdirSync(output, { recursive: true });
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'atb-live-')), {
    channel: 'chromium', headless: process.env.ATB_KEEP_OPEN !== '1',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 1280, height: 900 },
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(180000);
    const home = await page.goto('https://atb.tn', { waitUntil: 'commit', timeout: 60000 });
    console.log('Live ATB homepage HTTP status:', home.status());
    await page.locator('atb-assistant .chat-launcher').click();
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    assert.equal((await worker.evaluate(() => getConfig())).apiUrl, 'http://127.0.0.1:5000');
    const send = async text => {
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
    };
    await send('Explique le crédit Sayara proposé par ATB.');
    await page.waitForFunction(() => {
      const root = document.querySelector('atb-assistant')?.shadowRoot;
      const messages = root?.querySelectorAll('article.message-row-bot .message-content');
      return messages?.length > 1 && /sayara/i.test(messages[messages.length - 1].innerText)
        && /auto|voiture|véhicule/i.test(messages[messages.length - 1].innerText)
        && /7\s*ans/i.test(messages[messages.length - 1].innerText);
    });
    // Let the UI typewriter finish before taking the review screenshot.
    await page.waitForFunction(async () => {
      const content = document.querySelector('atb-assistant')?.shadowRoot?.querySelectorAll('article.message-row-bot .message-content');
      const node = content?.[content.length - 1];
      const before = node?.innerText;
      await new Promise(resolve => setTimeout(resolve, 1000));
      return before && before === node.innerText;
    });
    await page.screenshot({ path: path.join(output, 'live-ask.png') });
    const answer = await page.locator('article.message-row-bot .message-content').last().innerText();
    console.log('ASK answer:', answer);
    console.log('PASS: real backend ASK answered the Sayara question.');
    await page.getByRole('button', { name: 'Act on site', exact: true }).click();
    await send('Ouvre la page du crédit Sayara');
    await page.waitForURL('https://atb.tn/particuliers/nos-credits/credit-sayara', { waitUntil: 'commit' });
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    await page.locator('.status-row').waitFor({ state: 'hidden' });
    await page.screenshot({ path: path.join(output, 'live-act.png') });
    const destinationUnavailable = (await page.locator('body').innerText()).includes('The website encountered an unexpected error');
    fs.writeFileSync(path.join(output, 'live-agent-result.json'), JSON.stringify({
      testedAt: new Date().toISOString(), homepageStatus: home.status(), answer,
      destination: page.url(), destinationUnavailable,
    }, null, 2));
    console.log('PASS: real backend ACT navigated to the updated Sayara URL and restored the widget. Destination available:', !destinationUnavailable);
  } finally { if (process.env.ATB_KEEP_OPEN !== '1') await context.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
