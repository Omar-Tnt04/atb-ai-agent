import React from 'react';
import { createRoot } from 'react-dom/client';
import ChatWidget from './components/ChatWidget.jsx';
import css from './styles/chatWidget.css?inline';
import { configureWidgetRuntime } from './services/widgetRuntime.js';
import { createPageControl } from './services/pageControl.js';

async function mount() {
  if (/\.(pdf|docx?|xlsx?|pptx?)$/i.test(location.pathname) || document.querySelector('atb-assistant')) return;
  const initial = await chrome.runtime.sendMessage({ type: 'ATB_WIDGET_INIT' });
  if (!initial?.ok) throw new Error(initial?.error || 'Extension initialization failed');
  const values = initial.storage || {};
  let writes = Promise.resolve();
  const save = () => {
    const snapshot = { ...values };
    writes = writes.catch(() => {}).then(async () => {
      const result = await chrome.runtime.sendMessage({ type: 'ATB_WIDGET_STORAGE', values: snapshot });
      if (!result?.ok) throw new Error(result?.error || 'Unable to save widget state');
    });
    writes.catch(error => console.error('[ATB widget] State save failed', error));
  };
  const storage = {
    getItem: key => values[key] ?? null,
    setItem: (key, value) => { values[key] = String(value); save(); },
    removeItem: key => { delete values[key]; save(); },
    key: index => Object.keys(values)[index] ?? null,
    get length() { return Object.keys(values).length; },
  };
  const page = createPageControl();
  configureWidgetRuntime({
    apiUrl: initial.config.apiUrl,
    storage,
    page,
    flush: () => writes,
    openDocument: url => chrome.runtime.sendMessage({ type: 'ATB_WIDGET_OPEN_DOCUMENT', url }),
    request: async (url, options) => { await writes; return chrome.runtime.sendMessage({
      type: 'ATB_WIDGET_API', url, method: options.method || 'GET', body: options.body,
    }); },
  });
  const host = document.createElement('atb-assistant');
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;width:100%!important;height:100%!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;';
  const shadow = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  // Constructed stylesheets stay inside the shadow tree and require no remote stylesheet.
  sheet.replaceSync(css.replaceAll(':root', ':host').replace(/([\d.]+)rem\b/g, (_, n) => `${Number(n) * 16}px`) + `
    .atb-widget-root { font: 16px Inter, system-ui, sans-serif; color: #1f1f1f; direction:ltr; text-align:left; }
    .chat-widget-shell { pointer-events:auto; bottom:96px; z-index:1; }
    .chat-window { pointer-events:auto; width:min(340px, calc(100vw - 16px)); bottom:160px; max-height:calc(100dvh - 176px); min-height:0; }
    .chat-widget-shell[style] .chat-window { left:var(--panel-left); top:var(--panel-top); right:auto; bottom:auto; }
    .chat-launcher { touch-action:none; }
    @media(max-height:650px) { .chat-window, .chat-widget-shell[style] .chat-window { top:8px; bottom:auto; height:calc(100dvh - 80px); max-height:calc(100dvh - 80px); } }
  `);
  shadow.adoptedStyleSheets = [sheet];
  const root = document.createElement('div');
  root.className = 'atb-widget-root';
  shadow.append(root);
  document.documentElement.append(host);
  createRoot(root).render(<ChatWidget />);
  // Resume an indexed document action after its source page has loaded.
  page.resumeDocument().catch(error => console.error('[ATB widget] Document action failed', error));
  // Reattach the existing tree if the site replaces body content; never duplicate React/listeners.
  new MutationObserver(() => {
    if (!host.isConnected) document.documentElement.append(host);
  }).observe(document.documentElement, { childList: true });
}
mount().catch(error => console.error('[ATB widget] Unable to load extension widget:', error));
