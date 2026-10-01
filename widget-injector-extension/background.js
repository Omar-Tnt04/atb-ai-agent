importScripts('widget-config.js');
const ALLOWED_PAGE_HOSTS = new Set(['atb.tn', 'www.atb.tn']);
const CONFIG_ENDPOINTS = ['http://127.0.0.1:5000/dev/widget-config', 'http://localhost:5000/dev/widget-config'];
let configPromise;
function allowedSender(sender) {
  try {
    const url = new URL(sender.url);
    return sender.id === chrome.runtime.id && sender.tab?.id >= 0 && sender.frameId === 0 &&
      ['https:', 'http:'].includes(url.protocol) && ALLOWED_PAGE_HOSTS.has(url.hostname);
  } catch { return false; }
}
function normalizeApi(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid API origin');
  if (!(url.protocol === 'https:' && url.hostname.endsWith('.trycloudflare.com')) &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '5000')) {
    throw new Error('API host is not permitted');
  }
  return url.origin;
}
async function getConfig() {
  if (!configPromise) configPromise = (async () => {
    // The isolated worker can reach localhost directly; no tunnel or page CORS is needed.
    for (const origin of ['http://127.0.0.1:5000', 'http://localhost:5000']) {
      try {
        const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1200), cache: 'no-store', credentials: 'omit', redirect: 'error' });
        const health = response.ok ? await response.json() : null;
        if (health?.success === true && health.service === 'ATB AI Banking Agent Backend') return { apiUrl: origin };
      } catch { /* Remote demos still use the launcher/tunnel configuration below. */ }
    }
    for (const endpoint of CONFIG_ENDPOINTS) {
      try {
        const response = await fetch(endpoint, { signal: AbortSignal.timeout(1200), cache: 'no-store', credentials: 'omit', redirect: 'error' });
        if (!response.ok) continue;
        return { apiUrl: normalizeApi((await response.json()).apiUrl) };
      } catch { /* Packaged fallback also works without the local launcher. */ }
    }
    return { apiUrl: normalizeApi(globalThis.__ATB_WIDGET_CONFIG__.apiUrl) };
  })();
  return configPromise;
}
function allowedPath(path, method) {
  if (method === 'POST') return /^\/api\/widget\/(chat|actions\/(prepare|execute|confirm|cancel|verify-and-execute)|browser-agent\/[\w-]+\/start)$/.test(path);
  return method === 'GET' && /^\/api\/widget\/(browser-agent\/[\w-]+|generated\/[\w.-]+\/download)$/.test(path);
}
async function handle(message, sender) {
  const key = `tab:${sender.tab.id}`;
  if (message.type === 'ATB_WIDGET_OPEN_DOCUMENT') {
    const target = new URL(message.url);
    if (target.protocol !== 'https:' || !ALLOWED_PAGE_HOSTS.has(target.hostname) || target.username || target.password ||
        !/\.(pdf|docx?|xlsx?)$/i.test(target.pathname) || /login|payment|virement|supprimer/i.test(target.href)) throw new Error('Document URL is not permitted');
    await chrome.tabs.create({ url: target.href, openerTabId: sender.tab.id });
    return { ok: true };
  }
  if (message.type === 'ATB_WIDGET_INIT') {
    const [config, saved] = await Promise.all([getConfig(), chrome.storage.session.get(key)]);
    return { ok: true, config, storage: saved[key] || {} };
  }
  if (message.type === 'ATB_WIDGET_STORAGE') {
    if (!message.values || typeof message.values !== 'object' || Array.isArray(message.values) ||
        JSON.stringify(message.values).length > 2000000 ||
        Object.entries(message.values).some(([k,v]) => !k.startsWith('atb_widget_') || typeof v !== 'string')) throw new Error('Invalid widget state');
    await chrome.storage.session.set({ [key]: message.values });
    return { ok: true };
  }
  if (message.type !== 'ATB_WIDGET_API') throw new Error('Unknown request');
  const { apiUrl } = await getConfig();
  const url = new URL(message.url);
  const method = message.method || 'GET';
  if (url.origin !== apiUrl || url.username || url.password || url.hash || url.search || !allowedPath(url.pathname, method)) throw new Error('API route is not permitted');
  if (message.body != null && (typeof message.body !== 'string' || message.body.length > 2000000)) throw new Error('Invalid API body');
  // Only JSON is returned to the widget. No remote scripts or page-controlled proxy URLs.
  const response = await fetch(url.href, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: message.body } : {}),
    credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(120000),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 16000000) throw new Error('API response too large');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { ok: true, status: response.status, headers: { 'Content-Type': response.headers.get('content-type') || 'application/octet-stream' }, body: btoa(binary) };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!allowedSender(sender)) { respond({ ok: false, error: 'Sender is not an allowed ATB content script' }); return false; }
  // Model-backed requests can exceed MV3's idle interval. Only keep this worker awake
  // while an authorized request is pending, with a bounded network timeout above.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  handle(message, sender).then(respond, error => respond({ ok: false, error: error.message }))
    .finally(() => clearInterval(keepAlive));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => { chrome.storage.session.remove(`tab:${tabId}`); });
