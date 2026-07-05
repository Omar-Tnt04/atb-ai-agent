# ATB AI Agent — Hosted Demo Setup

Shows the widget live on **https://atb.tn** using HTTPS tunnels.  
No Chrome flags. No `localhost` exceptions. Supervisor-ready.

---

## Prerequisites

`https://atb.tn` is HTTPS. Chrome blocks HTTP iframes inside HTTPS pages (mixed content) and
also blocks `localhost` sub-resource requests from public pages (Private Network Access policy).
**HTTPS tunnel URLs are required every session — there is no workaround.**

---

## Session Setup (every time)

### Step 1 — Start services

```bash
# From project root
npm run dev
```

Starts **backend-node** (port 5000) and **widget-agent** (port 5174) only.  
For all services (full local MVP): `npm run dev:full`

### Step 2 — Open HTTPS tunnels

Open two separate terminals and run one command in each:

```bash
# Terminal A — backend tunnel (port 5000)
npx cloudflared tunnel --url http://localhost:5000
# Output: https://abc123.trycloudflare.com  ← copy this  (API_URL)
```

```bash
# Terminal B — widget tunnel (port 5174)
npx cloudflared tunnel --url http://localhost:5174
# Output: https://xyz789.trycloudflare.com  ← copy this  (WIDGET_URL)
```

Keep both terminals running for the full session.

### Step 3 — Paste tunnel URLs into extension config

Edit `widget-injector-extension/widget-config.js`:

```js
window.__ATB_WIDGET_CONFIG__ = {
  widgetUrl: 'https://xyz789.trycloudflare.com',   // ← widget tunnel URL
  apiUrl:    'https://abc123.trycloudflare.com',    // ← backend tunnel URL
};
```

### Step 4 — Launch demo

Ctrl+Click the link from the terminal ready banner:

```
http://localhost:5000/dev/open-hosted-demo
```

A new CDP Chrome window opens at `https://atb.tn` with the widget loaded.

> **Note:** Free Cloudflare tunnel URLs change every run.  
> Repeat Steps 2–4 each session.

---

## Development Workflow

| What changed | Action needed |
|---|---|
| Widget UI (`ChatWidget.jsx`, CSS, assets) | Refresh the ATB tab — `devTime` cache-bust ensures the iframe reloads fresh from Vite |
| Backend API (`backend-node`) | Restart `npm run dev` |
| Extension loader (`content.js`, `manifest.json`) | Reload extension at `chrome://extensions` |
| Tunnel URLs | `npm run dev` auto-patches `widget-config.js` — no extension reload needed |

**Vite HMR through tunnel:** HMR WebSocket may connect if Cloudflare proxies the upgrade.
When it does, React components hot-reload without any page refresh.
When it does not (tunnel drops the WebSocket), a manual ATB page refresh is sufficient —
the iframe always loads fresh because of the `devTime` parameter.

---

## Ready Banner

When `npm run dev` is ready:

```
==========================================
 ATB AI Agent — Hosted Browser Demo Ready
==========================================
  Backend API   : http://localhost:5000
  Widget        : http://localhost:5174
  Browser-use   : CDP waiting on http://127.0.0.1:9222
  Model         : gemma4:e4b
  Target        : https://atb.tn

  Open hosted demo:
  http://localhost:5000/dev/open-hosted-demo
==========================================
```

---

## Launcher endpoint

`GET /dev/open-hosted-demo` is a **dev-only** endpoint controlled by `ENABLE_DEV_BROWSER_LAUNCHER=true`.

- CDP Chrome **not running** → spawns Chrome with CDP, widget extension, and opens `TARGET_URL`
- CDP Chrome **already running** → redirects launcher tab to `TARGET_URL`, no new spawn
- **Disabled** → returns `403`

Config in `backend-node/.env`:

| Variable | Default |
|---|---|
| `ENABLE_DEV_BROWSER_LAUNCHER` | `false` |
| `TARGET_URL` | `https://atb.tn` |
| `CHROME_CDP_PORT` | `9222` |
| `CHROME_PATH` | `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| `CHROME_USER_DATA_DIR` | `C:\temp\atb-browser-agent-profile` |
| `WIDGET_EXTENSION_PATH` | `<projectRoot>/widget-injector-extension` |

---

## Verifying the widget loaded

Open DevTools (`F12`) on the ATB tab in the CDP Chrome window. The console should show:

```
[ATB_WIDGET_EXTENSION] content script running on https://atb.tn/
[ATB_WIDGET_EXTENSION] widgetUrl=https://xyz789.trycloudflare.com
[ATB_WIDGET_EXTENSION] apiUrl=https://abc123.trycloudflare.com
[ATB_WIDGET_EXTENSION] injecting widget iframe
[ATB_WIDGET_EXTENSION] iframe src=https://xyz789.trycloudflare.com/embed?embed=true&apiUrl=https%3A%2F%2Fabc123.trycloudflare.com
[ATB_WIDGET_EXTENSION] iframe load. src: https://xyz789.trycloudflare.com/embed?...
```

If `widgetUrl` still shows `http://localhost:5174`, tunnel URLs have not been written yet (wait for the ready banner) or `/dev/widget-config` is unreachable.

---

## Browser-Agent (CDP) Notes

The browser-agent (`browser-agent/run_agent.py`) runs on the developer's machine, not in the
user's browser. It connects to Chrome via CDP at `http://127.0.0.1:9222`. Tunnel URLs do not
affect browser-agent routing — the backend calls it as a local subprocess.

---

## Production Conversion

| Step | MVP (now) | Production |
|------|-----------|------------|
| Widget injection | Chrome extension injects the iframe | ATB website team adds one `<script>` tag to the layout |
| Widget URL | HTTPS tunnel (`trycloudflare.com`) | `https://widget-staging.atb.tn` |
| API URL | HTTPS tunnel (`trycloudflare.com`) | `https://ai-agent-api-staging.atb.tn` |
| Extension | Required | Removed |
| `/dev/open-hosted-demo` | Dev only | Remove / disable |

Production script tag (for ATB website team):

```html
<script
  src="https://widget-staging.atb.tn/atb-widget-loader.js"
  data-widget-url="https://widget-staging.atb.tn"
  data-api-url="https://ai-agent-api-staging.atb.tn"
  defer
></script>
```
