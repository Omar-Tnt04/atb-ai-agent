// ATB AI Widget Injector — URL Configuration
// ─────────────────────────────────────────────────────────────────────────────
// Edit ONLY this file to switch between local dev and HTTPS tunnel demo.
// After editing, go to chrome://extensions and reload the extension.
//
// WHY HTTPS TUNNEL?
//   The ATB website (https://atb.tn) is served over HTTPS. Chrome blocks HTTP
//   iframes loaded inside HTTPS pages (mixed content). With HTTPS tunnel URLs
//   the widget loads cleanly — no Chrome flags, no localhost exceptions needed.
//
// QUICK SETUP (free, no account required — Cloudflare quick tunnels):
//   Terminal 1:  npx cloudflared tunnel --url http://localhost:5000
//                → copy the https://xxxxxx.trycloudflare.com URL → paste as apiUrl
//   Terminal 2:  npx cloudflared tunnel --url http://localhost:5174
//                → copy the https://yyyyyy.trycloudflare.com URL → paste as widgetUrl
//
// ALTERNATIVE TUNNEL (ngrok, requires free account):
//   ngrok http 5000    →  apiUrl
//   ngrok http 5174    →  widgetUrl
// ─────────────────────────────────────────────────────────────────────────────

window.__ATB_WIDGET_CONFIG__ = {
  // Widget SPA (React app served by Vite, port 5174).
  //   HTTPS tunnel: npx cloudflared tunnel --url http://localhost:5174
  //   Production:   'https://widget-staging.atb.tn'
  widgetUrl: 'https://deaths-relevance-finds-parcel.trycloudflare.com',

  // Backend API (Node.js service, port 5000).
  //   HTTPS tunnel: npx cloudflared tunnel --url http://localhost:5000
  //   Production:   'https://ai-agent-api-staging.atb.tn'
  apiUrl: 'https://bloggers-collectibles-stated-later.trycloudflare.com',
};
