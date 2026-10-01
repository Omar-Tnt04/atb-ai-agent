const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { buildAskContext } = require('../build-ask-context');
const { indexFromContext } = require('../build-site-index');
const { validateCleanIndex } = require('../validate-clean-site-index');

async function main() {
  let fail = true;
  const visited = [];
  const server = http.createServer((req, res) => {
    visited.push(req.url);
    if (req.url === '/missing') { res.writeHead(404); return res.end('Not found'); }
    if (req.url === '/service' && fail) { res.writeHead(503); return res.end('Unavailable'); }
    res.setHeader('Content-Type', 'text/html');
    res.end('<html lang="en"><head><title>Example Bank</title></head><body><main><h1>Bank services</h1><p>Our current account service includes account statements and access to online banking. Contact our team for further details.</p><a href="/service">Service</a><a href="/missing">Missing</a><a href="/image-captcha-refresh/token">Captcha</a></main></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atb-context-test-'));
  const out = path.join(dir, 'context.json');
  const args = [path.resolve('scripts/build-site-context.js'), '--url', `http://127.0.0.1:${server.address().port}`,
    '--out', out, '--ollama', 'off', '--settle-ms', '0'];
  try {
    await run(process.execPath, args);
    const partial = JSON.parse(fs.readFileSync(out));
    assert.equal(partial.meta.status, 'partial');
    assert.throws(() => buildAskContext(partial), /failed crawl/);
    assert(!visited.some(url => url.startsWith('/image-captcha-refresh')));
    fail = false;
    await run(process.execPath, [...args, '--resume', out]);
    const complete = JSON.parse(fs.readFileSync(out));
    assert.equal(complete.meta.status, 'complete');
    assert.equal(complete.pages.length, 2);
    assert.equal(complete.failedUrls.length, 1);
    assert.equal(complete.failedUrls[0].error, 'HTTP 404');
    assert.equal(visited.filter(url => url === '/missing').length, 1);
    assert.equal(buildAskContext(complete).exact.exactBlocks.length, 2);
    complete.pages[0].documents = [{ url: `${complete.meta.targetUrl}/guide.pdf`, fileName: 'guide.pdf', text: 'Guide' }];
    complete.pages[0].forms = [{ action: `${complete.meta.targetUrl}/contact`, method: 'post', fields: [{ name: 'email', type: 'email' }] }];
    const index = indexFromContext(complete);
    assert.deepEqual(validateCleanIndex(index), []);
    assert.equal(index.uniqueDocuments[0].filename, 'guide.pdf');
    assert.equal(index.uniqueDocuments[0].sourcePages[0], complete.pages[0].url);
    assert.deepEqual(index.uniqueForms[0].fields, ['email']);
    assert(!index.pages.some(page => page.url.endsWith('/missing')));
    console.log('PASS: HTTP failures excluded, technical endpoints skipped, partial refresh rejected, retry preserves captured pages.');
  } finally { await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
