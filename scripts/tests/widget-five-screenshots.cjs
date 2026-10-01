const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');

async function main() {
  const output = path.resolve('verification/widget-five-tests');
  fs.mkdirSync(output, { recursive: true });
  for (const [source, target] of [['live-ask.png', '01-ask-sayara.png'], ['live-act.png', '02-act-sayara.png']]) {
    fs.copyFileSync(path.resolve('verification/site-refresh', source), path.join(output, target));
  }
  const previous = JSON.parse(fs.readFileSync('verification/site-refresh/live-agent-result.json', 'utf8'));
  const results = [
    { file: '01-ask-sayara.png', mode: 'ask', reused: true, testedAt: previous.testedAt, answer: previous.answer },
    { file: '02-act-sayara.png', mode: 'act', reused: true, testedAt: previous.testedAt, destination: previous.destination },
  ];
  const save = () => fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  const extension = path.resolve('widget-injector-extension');
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'atb-five-')), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 1280, height: 900 },
  });
  async function start(url, mode) {
    const page = await context.newPage();
    page.setDefaultTimeout(180000);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    assert.equal(response.status(), 200);
    await page.locator('atb-assistant .chat-launcher').click();
    await page.getByRole('button', { name: mode === 'act' ? 'Act on site' : 'Ask question', exact: true }).click();
    return page;
  }
  async function send(page, prompt) {
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill(prompt);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
  }
  async function capture(page, file, details) {
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    await page.locator('.status-row').waitFor({ state: 'hidden' });
    await page.waitForFunction(async () => {
      const nodes = document.querySelector('atb-assistant')?.shadowRoot?.querySelectorAll('article.message-row-bot .message-content');
      const last = nodes?.[nodes.length - 1];
      const text = last?.innerText;
      await new Promise(r => setTimeout(r, 1500));
      return text && text === last.innerText;
    });
    assert(!(await page.locator('body').innerText()).includes('The website encountered an unexpected error'));
    await page.screenshot({ path: path.join(output, file) });
    const answer = await page.locator('article.message-row-bot .message-content').last().innerText();
    results.push({ file, ...details, testedAt: new Date().toISOString(), url: page.url(), answer });
    save();
    console.log('PASS', file, JSON.stringify(results.at(-1)));
  }
  try {
    let page = await start('https://atb.tn/particuliers/banque-a-distance/atb-pay', 'ask');
    let prompt = 'À quoi sert ATB PAY ? Réponds en deux phrases.';
    await send(page, prompt);
    await page.waitForFunction(() => {
      const nodes = document.querySelector('atb-assistant')?.shadowRoot?.querySelectorAll('article.message-row-bot .message-content');
      return nodes?.length > 1 && /wallet|paiement|portefeuille|smartphone/i.test(nodes[nodes.length - 1].innerText);
    });
    await capture(page, '03-ask-atb-pay.png', { mode: 'ask', prompt });
    await page.close();

    page = await start('https://atb.tn/', 'act');
    prompt = 'Ouvre la page pour contacter un conseiller ATB';
    await send(page, prompt);
    await page.waitForURL('https://atb.tn/a-propos-de-l-atb/contacter-un-conseiller', { waitUntil: 'domcontentloaded' });
    await capture(page, '04-act-contact.png', { mode: 'act', prompt });
    await page.close();

    page = await start('https://atb.tn/particuliers/banque-a-distance/atb-messenger', 'act');
    prompt = "Ouvre le formulaire d'abonnement ATB Messenger en PDF";
    const popupPromise = context.waitForEvent('page', { timeout: 180000 });
    await send(page, prompt);
    const popup = await popupPromise;
    await popup.waitForURL(/Formulaire_Abonnement-ATBMESSENGER.*\.pdf/i, { waitUntil: 'commit', timeout: 60000 });
    const documentUrl = popup.url();
    await capture(page, '05-act-messenger-pdf.png', { mode: 'act', prompt, documentUrl });
    await popup.close();
    assert.equal(results.length, 5);
  } finally {
    save();
    await context.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
