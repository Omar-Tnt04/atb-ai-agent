# ATB AI Banking Agent — Project Context

## 1. Project Overview

### What this MVP does

This project is a proof-of-concept AI banking assistant for **ATB (Arab Tunisian Bank)**. It places a chat widget on the live ATB website (`atb.tn`) and lets users ask questions in plain language. The agent can:

- Navigate the ATB website on the user's behalf using a real Chrome browser
- Find and open downloadable forms (PDFs, documents)
- Locate contact information, addresses, and service details from page content
- Run financial simulators on the ATB website
- Analyze documents or images uploaded by the user (OCR + vision)
- Answer general banking questions from a local resource catalog
- Simulate banking actions (payments, appointments, card requests) through internal demo services

### Main goal of the agent

The agent acts as a safe, read-only assistant. It never submits forms, never logs in, and never makes real transactions. For complex website tasks (finding forms, running simulators) it controls a visible Chrome window through Playwright + CDP. For simple questions it uses a local AI model (Ollama/Gemma) to answer from page content or a resource catalog.

### Current demo flow

1. Open Chrome with the ATB Agent shortcut (with `--remote-debugging-port=9222`)
2. Navigate to `https://atb.tn` in that Chrome window
3. Load the Chrome extension (widget injector), which injects the chat widget into the ATB page
4. The user types a request in the widget
5. The backend classifies the request and routes it:
   - Simple navigation → DOM fast-path (no AI needed)
   - Page + extract info → DOM planner + Gemma
   - Download form / run simulator → browser-use Agent + Gemma
   - Uploaded file / image → OCR + vision model
   - Banking question → resource catalog lookup

---

## 2. Architecture

### Widget / Frontend

**`widget-agent/`** — A React + Vite app served on port `5174`. This is the chat UI embedded inside an iframe in the ATB website. It:
- Shows the conversation history
- Sends messages to the backend Node.js API
- Receives streaming or JSON responses
- Handles file uploads (PDF, image, etc.)
- Manages a pending browser-use job: polls the backend for job status after triggering a browser task
- Persists chat state across page navigations using `sessionStorage` and a localStorage bridge in the host page

**`web-client/`** — A standalone React app on port `5173` used for development and demonstration. It includes the full chat UI, quick actions, file upload, and an admin/audit view. Not used in the injected-widget demo flow.

### Backend Node API

**`backend-node/`** — A Node.js / Express server on port `5000`. It is the central orchestrator:

- Receives messages from the widget or web client
- Classifies requests and routes them using `agentCaseRouter.service.js`
- Calls the Python AI service for intent analysis, OCR, and resource reranking
- Manages browser-use jobs (creates a job ID, launches a Python subprocess)
- Connects to internal demo services (payment, appointment, document, account)
- Reads a Laragon-hosted resource catalog (`catalog.json`) for banking Q&A
- Returns formatted answers to the frontend

### Python AI Service (ai-service-python)

**`ai-service-python/`** — A FastAPI service on port `8000`. It handles AI-heavy tasks that the Node.js backend delegates:

- Intent classification (`/analyze`, `/decide`)
- Intent planning (`/plan-intent`) — breaks complex requests into steps
- Vision document analysis (`/vision-document`) — reads uploaded PDFs and images
- Resource reranking (`/rerank-resources`) — scores catalog matches by relevance
- Uses Ollama locally with configurable models (default: `qwen2.5:7b` for text, vision model for images)
- Tesseract OCR is also used for image-to-text extraction when vision is not available

### Chrome Extension / Injected Widget

**`widget-injector-extension/`** — A Manifest V3 Chrome extension that:
- Runs `content.js` on every `atb.tn` page
- Injects the widget as a floating `<iframe>` in the bottom-right corner
- Builds a live **page snapshot** (headings, sections, links, buttons) and sends it to the widget via `postMessage`
- Executes safe page actions requested by the widget: scroll, highlight, open document in new tab, same-domain navigation
- Maintains a bridge in `atb.tn` localStorage so the widget can restore pending job state after the page navigates (the iframe would otherwise lose its state)

### CDP Chrome Control

**`browser-agent/`** — Python scripts that control the visible Chrome window via Playwright's CDP (Chrome DevTools Protocol):

- `run_agent.py` — entry point. Classifies the task and routes it to the DOM fast-path, DOM planner, or browser-use Agent
- `dom_agent.py` — implements both the DOM fast-path and the DOM planner loop
- `config.py` — reads environment variables: `TARGET_URL`, `CDP_URL`, `OLLAMA_MODEL`, etc.

Chrome is launched separately with `--remote-debugging-port=9222`. Playwright connects to it via `connect_over_cdp()` — it never launches or closes Chrome itself, preserving the existing tab and the injected widget.

### Ollama / Gemma Usage

Ollama runs locally and serves the `gemma4:e4b` model (configurable via `OLLAMA_MODEL`). Gemma is used by:

- The **DOM planner** in `dom_agent.py` — decides which link or button to click at each step, using live DOM candidates from the page
- The **intent extractor** in `dom_agent.py` — understands the user's goal once before the search loop starts
- The **answer synthesizer** in `dom_agent.py` — reads extracted page content and writes a plain-text answer for `page_then_answer` tasks
- The **browser-use Agent** in `run_agent.py` — used as the LLM when browser-use drives multi-step navigation

The Python AI service uses a separate Ollama model (`qwen2.5:7b` by default) for intent classification and resource analysis.

### Browser-use Usage

**`browser-use-poc/`** is a vendored copy of the `browser-use` library. The main code imports it from that local copy. Browser-use provides:

- The `Agent` class that runs a multi-step agentic loop
- `ChatOllama` wrapper to connect Gemma to the agent
- `BrowserSession` to attach to the existing CDP Chrome tab
- A `Tools` / `controller` mechanism to define custom actions (e.g., `report_document`)

Browser-use is only used for heavy tasks (`document_download`, `multi_step_action`). Simple navigation uses Playwright directly without browser-use.

### DOM Fast-Path Usage

For simple page-open tasks (`simple_page_open`), the DOM fast-path runs entirely in `dom_agent.py` without calling Gemma:

1. Extract all visible links from the current page via a JavaScript snippet injected through Playwright
2. Score each link against the target words extracted from the user request (word matching, no LLM)
3. Navigate to the best-matching link if it clearly outscores all others
4. Confirm success by checking the new URL/title against the target words

This path handles tasks like "Open the contact page" or "Go to ATB Connect" in 1–3 seconds instead of 30–90 seconds.

---

## 3. Task Routing Logic

### Task types

`run_agent.py` classifies every incoming request into one of four types using regex patterns. No LLM is called for classification.

| Task type | Trigger pattern | Example |
|---|---|---|
| `simple_page_open` | Default (no other pattern matches) | "Open the contact page" |
| `page_then_answer` | Navigation verb + info extraction keyword in same sentence | "Go to the contact page and find the email address" |
| `document_download` | Download, form, PDF, or account-opening keywords | "Download the credit request form" / "Ouvrir un compte" |
| `multi_step_action` | Simulator or calculator keywords | "Simulate a Sayara credit" |

### Which route each task uses

| Task type | Route | Speed |
|---|---|---|
| `simple_page_open` | **DOM fast-path** → no Gemma, pure link scoring | 1–5 s |
| `simple_page_open` (fallback) | **DOM planner** → Gemma picks next action each step | 15–60 s |
| `page_then_answer` | **DOM fast-path** nav + Gemma **answer synthesizer** | 5–25 s |
| `document_download` | **browser-use Agent** + Gemma multi-step navigation | 30–120 s |
| `multi_step_action` | **browser-use Agent** + Gemma multi-step navigation | 30–120 s |
| Uploaded file / image | **OCR** (Tesseract) + optional **vision model** (Python AI service) | 5–60 s |
| Banking Q&A | **Resource catalog** lookup + Ollama text model | 3–10 s |

---

## 4. Important Files

| File | Role |
|---|---|
| `browser-agent/run_agent.py` | Entry point for all browser tasks. Classifies the task, routes to fast-path, DOM planner, or browser-use. Spawned as a subprocess by `browserAgent.service.js`. |
| `browser-agent/dom_agent.py` | DOM fast-path and DOM planner loop. Connects to Chrome via Playwright CDP, extracts live DOM candidates, runs Gemma to decide actions, executes navigation, scrolling, and file opening. Also contains the page-content extractor and Ollama answer synthesizer. |
| `browser-agent/config.py` | Reads all environment variables for the browser agent: `TARGET_URL`, `CDP_URL`, `OLLAMA_MODEL`, `HEADLESS`, `USE_CDP`. |
| `backend-node/src/services/browserAgent.service.js` | Manages browser-use jobs. Classifies messages (routing predicates), creates async job records, spawns `run_agent.py` as a subprocess, parses its stdout, and formats the final answer. Exports `createBrowserAgentJob`, `launchBrowserAgentJob`, `getBrowserAgentJob`. |
| `backend-node/src/services/agentCaseRouter.service.js` | Decides which agent case to use for every chat message: resource catalog, PDF vision, banking action, browser task, etc. |
| `backend-node/src/controllers/chat.controller.js` | Handles `POST /chat/message` and `POST /chat/message-with-files`. Orchestrates the full request: routing, AI service calls, action preparation, response formatting. |
| `backend-node/src/routes/chat.routes.js` | Express router. Defines chat endpoints, file upload validation (multer), and auth middleware. |
| `backend-node/src/routes/resource.routes.js` | Endpoints for resource catalog queries and file downloads. |
| `scripts/dev/start.js` | Development orchestrator. Spawns all services (backend, AI service, web client, widget, internal demo services) and prints a ready banner with service URLs and CDP status. |
| `widget-agent/src/App.jsx` | Root React component for the widget. Renders `ChatWidget` in embedded mode (inside the iframe). |
| `widget-injector-extension/content.js` | Chrome extension content script. Injects the widget iframe, builds page snapshots, executes safe DOM actions, manages the localStorage bridge for job state persistence across page navigations. |
| `widget-injector-extension/manifest.json` | Extension manifest. Declares content script matches (`atb.tn/*`) and host permissions. |
| `widget-injector-extension/widget-config.js` | Static URL config for the extension. Sets `widgetUrl` (port 5174) and `apiUrl` (port 5000), overridden at runtime by `/dev/widget-config` from the backend. |
| `ai-service-python/app/main.py` | FastAPI app. Exposes `/analyze`, `/decide`, `/plan-intent`, `/vision-document`, `/rerank-resources` endpoints used by the Node backend. |
| `internal-services-demo/` | Five separate Express services simulating ATB internal APIs: payment (7101), document (7102), ATB (7106), appointment (7104), account (7105). |

---

## 5. Runtime Flow

Step-by-step for a browser task (most common complex flow):

1. **User** types a message in the widget chat panel (inside the iframe on `atb.tn`)
2. **Widget** (`widget-agent`) sends `POST /chat/message` to `backend-node` (port 5000)
3. **Backend** (`agentCaseRouter`) classifies the message — browser task detected (navigation verb, form/document keyword, or simulator keyword)
4. **Backend** (`browserAgent.service.js`) creates a browser-use job with a unique `jobId` and returns it immediately to the widget
5. **Widget** saves the `jobId` to `sessionStorage` and posts `ATB_WIDGET_SAVE_BRIDGE` to the content script so `atb.tn` localStorage also holds the job state — protection against page navigation
6. **Widget** calls `POST /browser-agent/:jobId/start` to tell the backend to launch the job
7. **Backend** spawns `python run_agent.py <task>` as a subprocess in `browser-agent/`
8. **`run_agent.py`** classifies the task (regex, no LLM) → selects a route
9. **Python agent** connects to Chrome via Playwright CDP (`http://127.0.0.1:9222`) and finds the ATB tab
10. **Agent** executes the route:
    - Fast-path: match best link → navigate → confirm
    - DOM planner: loop (extract candidates → ask Gemma → execute action) until done or timeout
    - browser-use: run the `Agent` multi-step loop with Gemma driving decisions
11. **Python agent** prints `=== Result ===` followed by the answer to stdout
12. **Backend** reads stdout, formats the answer, stores it in the job record
13. **Widget** polls `GET /browser-agent/:jobId/status` every 2 seconds until status is `done`
14. **Widget** displays the formatted answer in the chat

For a simple resource/catalog question (no browser needed):

1. Widget sends message to backend
2. Backend routes to resource catalog lookup
3. Node.js searches `catalog.json` for matching resources
4. If needed, calls Python AI service for reranking or answer synthesis
5. Returns answer directly to widget — no subprocess spawned

---

## 6. Browser Automation Flow

### Connecting to Chrome via CDP

Chrome must be running with `--remote-debugging-port=9222` before any browser task is triggered. The shortcut is created by `scripts/create-chrome-shortcut.ps1` and also loads the widget injector extension from the project directory.

`dom_agent.py` uses:
```python
browser = await playwright_handle.chromium.connect_over_cdp(cdp_url, timeout=5000)
```
This attaches to the existing Chrome without launching or closing it. All tabs remain open. The agent finds the ATB tab by scanning all pages and matching the `atb.tn` hostname.

`run_agent.py` (for browser-use tasks) uses `browser_use.browser.session.BrowserSession` with `cdp_url=CDP_URL`, then dispatches a `SwitchTabEvent` to bring the ATB tab to front.

### When DOM fast-path is used

- Task type is `simple_page_open`
- At least one visible link on the current page clearly matches the target words
- The link is same-domain (no external navigation)
- Time: under 5 seconds, no Gemma call

The fast-path does pure keyword scoring on link text and href. It requires a clear winner (score ≥ 4, at least 2 points ahead of the next candidate).

### When browser-use is used

- Task type is `document_download` or `multi_step_action`
- Gemma drives a multi-step agentic loop: navigate menus, find document sections, validate document titles against rules, open the correct file
- Browser-use handles the full action space: click, navigate, scroll, extract
- The custom `report_document` tool in `run_agent.py` catches when the correct document is found and stops the loop immediately

### Why simple tasks avoid heavy AI

Calling Gemma adds 10–45 seconds of latency per step (cold-start on local hardware). For a task like "Open the contact page", the correct link is almost always visible on the current page and can be found by matching a few words. Invoking Gemma would only waste time and risk hallucination.

### Why complex tasks use browser-use/Gemma

Document download requires multi-level navigation: Homepage → Products/Services menu → Documents section → correct category → correct file. The structure changes, PDF titles are in French, and a wrong document would be a bad user experience. Gemma reads the actual live DOM candidates and makes context-aware decisions at each step.

---

## 7. Environment Variables

### backend-node/.env

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5000` | Backend API port |
| `AI_SERVICE_URL` | `http://localhost:8000` | Python AI service URL |
| `TARGET_URL` | `https://atb.tn` | Target website for browser agent |
| `CDP_URL` | `http://127.0.0.1:9222` | Chrome DevTools Protocol endpoint |
| `USE_CDP` | `true` | Enable CDP mode (false = launch new headless browser) |
| `OLLAMA_MODEL` | `gemma4:e4b` | Gemma model for browser-use and DOM planner |
| `DOM_INTENT_MODEL` | `gemma4:e4b` | Gemma model specifically for DOM intent extraction |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama API base URL |
| `DOM_MAX_DURATION_MS` | `180000` | Max time budget for DOM planner loop (3 minutes) |
| `DOM_OPEN_FILE_MODE` | `new_tab` | How agent opens PDFs: `new_tab` or `same_tab` |
| `DOM_EXTERNAL_NAV_MODE` | `new_tab` | External domain handling: `new_tab`, `block`, or `same_tab` |
| `HEADLESS` | `false` | Run browser headlessly (false = use visible CDP browser) |
| `PYTHON_BIN` | (must set) | Absolute path to Python interpreter with playwright installed |
| `RESOURCE_ROOT_DIR` | (must set) | Path to Laragon resource catalog root (e.g., `C:/laragon/www/atb-general-resources`) |
| `RESOURCE_CATALOG_PATH` | (must set) | Path to `catalog.json` |
| `RESOURCE_BASE_URL` | `http://localhost/atb-general-resources` | Base URL for resource file downloads |
| `WIDGET_DEMO_MODE` | `true` | Enable standalone widget demo route |
| `OCR_ENABLED` | `true` | Enable Tesseract OCR for uploaded images |
| `OCR_LANGUAGES` | `eng+fra` | OCR language packs |
| `ENABLE_DEV_BROWSER_LAUNCHER` | `true` | Expose `/dev/open-hosted-demo` dev route |
| `DEBUG_AGENT_ROUTING` | `false` | Print detailed routing decisions |

### ai-service-python/.env

| Variable | Default | Purpose |
|---|---|---|
| `AI_SERVICE_PORT` | `8000` | Python service port |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama base URL |
| `MODEL_ROUTING_MODE` | `hybrid` | Model selection strategy |
| `OLLAMA_TEXT_MODEL` | `qwen2.5:7b` | Text model for intent and Q&A |
| `TESSERACT_CMD` | (must set on Windows) | Full path to `tesseract.exe` |

### browser-agent/.env (inherited from backend-node/.env at runtime)

| Variable | Default | Purpose |
|---|---|---|
| `TARGET_URL` | `https://atb.tn` | Website to navigate |
| `OLLAMA_MODEL` | `gemma4:e4b` | Model for browser-use agent |
| `CDP_URL` | `http://127.0.0.1:9222` | Chrome CDP endpoint |
| `USE_CDP` | `true` | Use existing Chrome (false = launch new) |
| `HEADLESS` | `false` | Headless mode flag |

---

## 8. How to Run

### Prerequisites

- Node.js (v18+)
- Python 3.12 with a virtual environment containing `playwright`, `browser-use`, `ollama`
- Ollama running locally with `gemma4:e4b` and `qwen2.5:7b` pulled
- Tesseract OCR installed (Windows: default path `C:\Program Files\Tesseract-OCR\tesseract.exe`)
- Laragon (or equivalent) serving the resource catalog at `http://localhost/atb-general-resources`
- Chrome with the ATB Agent shortcut (created by `scripts/create-chrome-shortcut.ps1`)

### Install dependencies

```powershell
# Root (dev orchestrator)
npm install

# Backend Node
cd backend-node && npm install

# Widget
cd widget-agent && npm install

# Web client (optional, for standalone web app)
cd web-client && npm install

# Python AI service
cd ai-service-python
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt

# Install Playwright browsers (only needed once)
playwright install chromium
```

### Start all services

```powershell
# Full local MVP (all services + web client + internal demo services)
npm run dev:full

# Hosted-browser demo only (backend + widget, no web client or demo services)
npm run dev
```

### Start Chrome with CDP enabled

```powershell
# Run once to create the Chrome shortcut
powershell -ExecutionPolicy Bypass -File scripts\create-chrome-shortcut.ps1

# Then open the "ATB Agent Chrome" shortcut from the Desktop
# Navigate to https://atb.tn in that Chrome window
```

### Load the extension

1. Open `chrome://extensions` in the CDP Chrome window
2. Enable Developer mode
3. Click "Load unpacked" → select `widget-injector-extension/`
4. The widget bubble appears on `atb.tn`

### Service URLs (after `npm run dev:full`)

| Service | URL |
|---|---|
| Backend API | `http://localhost:5000/health` |
| Python AI service | `http://localhost:8000/health` |
| Web client | `http://localhost:5173` |
| Widget | `http://localhost:5174` |
| Demo page | `http://localhost:5173/bank-widget-demo.html` |

---

## 9. Testing Scenarios

These are example requests to type into the widget after loading the ATB website:

| Scenario | Request |
|---|---|
| Open contact page | `Ouvre la page contact` / `Go to the contact page` |
| Find contact email | `Go to the contact page and find the email address` |
| Download credit request form | `Télécharger le formulaire de demande de crédit` |
| Request bank card form | `Je veux le formulaire de demande de carte bancaire` |
| Open personal account form | `Ouvrir un compte — formulaire personne physique` |
| Simulate Sayara credit | `Simuler un crédit Sayara` |
| Open ATB Connect | `Ouvre ATB Connect` |
| Ask about ATB services | `What services does ATB offer?` |
| Upload a bank statement | Upload a PDF and ask: `What is my balance?` |

---

## 10. Current Limitations

- **External login pages** — the agent detects login URLs and warns the user instead of trying to interact. It cannot log in on the user's behalf.
- **CAPTCHA** — not handled. Any page with a CAPTCHA will block the agent.
- **Credentials** — the agent never enters passwords, OTPs, or PINs. This is by design and enforced in `SAFETY_RULES` in `config.py`.
- **Pages with weak DOM structure** — pages with images-only navigation, canvas-based UIs, or complex JavaScript rendering may not expose the right links to the DOM extractor, causing the planner to fail or time out.
- **Model speed** — Gemma running locally on CPU is slow (10–45 seconds per planning step). Complex tasks can take 1–3 minutes on typical developer hardware.
- **Dependency on visible Chrome** — CDP mode requires Chrome to be running with the correct flags. If Chrome is closed or the ATB tab is closed, browser tasks will fail with a connection error.
- **Ollama must be running** — if Ollama is not started or the model is not pulled, all Gemma-dependent tasks (DOM planner, browser-use) will fail with a health-check error.
- **Resource catalog is external** — the catalog (`catalog.json`) is served by Laragon and not included in the repository. Without it, resource-based Q&A returns no results.
- **No real banking actions** — all confirmed actions (payments, transfers, appointments) are simulated by the internal demo services. No real ATB API is connected.

---

## 11. Development Notes

### Do not use browser-use for simple one-click tasks

Browser-use is slow and expensive on local hardware. Simple navigation tasks ("Open page X") must use the DOM fast-path. Only add a task to the browser-use path if it genuinely requires multi-step navigation (menus, form pages, document sections).

### Keep DOM fast-path for simple navigation

The fast-path classification regex in `run_agent.py` and the routing predicates in `browserAgent.service.js` define which requests go where. When adding a new task type, check whether it can be handled by the DOM fast-path before adding it to the browser-use route.

### Use browser-use for complex multi-step tasks

Tasks that require navigating through 2+ levels of menus, finding a specific file among many, or clicking a non-obvious button should use browser-use with Gemma. The `report_document` custom tool in `run_agent.py` is the preferred way to stop the browser-use loop early as soon as the correct document is found.

### Keep answers grounded in page/file content

All answers must be extracted from actual page content or uploaded file content. The DOM planner reads the live page through `_PAGE_CONTENT_JS` and passes it to Gemma for synthesis. The Python AI service reads OCR output or vision model output. Neither component should invent information not found in the source.

### Two-phase browser job design

The job is created (queued) before the widget saves its state to `sessionStorage`. Then the widget sends a separate `start` request. This sequence prevents a race condition where browser-use navigates the page and destroys the iframe before the widget has saved its resume breadcrumb. Never collapse these two phases into one.

### Extension bridge pattern

Because the widget runs inside a cross-origin iframe, its `localStorage` is partitioned and isolated from `atb.tn`'s storage. The content script (`content.js`) bridges this gap by storing pending job state in `atb.tn`'s own `localStorage` when it receives `ATB_WIDGET_SAVE_BRIDGE`. After page navigation, the content script reads this bridge and forwards the state back to the widget via `postMessage`.
