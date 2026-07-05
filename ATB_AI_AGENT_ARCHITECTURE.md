# ATB AI Agent — Current Architecture

> Generated from code inspection — June 2026.  
> Based on the actual codebase, not prior assumptions. All file references are verified.

---

## 1. High-Level Product Concept

The ATB AI Banking Agent is a floating chat widget injected into the ATB website (`atb.tn`) via a browser extension. Users can ask questions about ATB products and services, or instruct the agent to perform actions on the live site.

The widget operates in two distinct modes selected by the user:

| Mode | What it does | Uses browser? |
|---|---|---|
| **Ask question** | Answers from static, pre-indexed knowledge | No |
| **Act on site** | Navigates the real hosted site autonomously | Yes (browser-use + CDP) |

The two modes are fully separated in routing. Ask mode never touches the browser. Act mode always launches a Python browser-use agent.

---

## 2. Ask Mode Architecture

### Overview

Ask mode answers questions from structured, pre-indexed knowledge — no live browser navigation. The answer is built deterministically from one of three knowledge sources, in priority order.

### Priority Order

```
P0  siteContext    — current live page DOM (sent by content.js at request time)
P1  siteIndex     — pre-crawled index of the hosted site (BFS, up to 20 pages)
P2  contact facts — static public ATB contact info (phone, address)
P3  catalog       — Laragon resource catalog (AI-assisted, via Python AI service)
```

Handled in `widgetDemo.routes.js` → `handleAskRetrieval` middleware.

---

### P0 — siteContext (current page)

**Trigger:** question explicitly refers to the current page (`isCurrentPageQuestion`), and the siteContext sent with the request has usable content.

**Guard:** site-wide questions ("on the site") skip this path and fall through to P1.

**Answer:** built deterministically from the DOM extraction by `buildSiteContextAnswer()` in `siteContext.service.js`. No AI call. Returns in < 10 ms.

**Example triggers:** "what is on this page?", "what links are visible?", "what documents can I see here?", "cette page".

---

### P1 — siteIndex (pre-crawled site)

**Trigger:** `searchSiteIndex(message, siteIndex)` returns a top result with score ≥ 0.45 (`SITE_INDEX_THRESHOLD`).

**Scoring fields** (per page):

| Field | Weight |
|---|---|
| Title tokens | 0.40 |
| Headings tokens | 0.30 |
| Download link text tokens | 0.25 |
| URL tokens | 0.20 |
| Body text tokens | 0.15 |
| Internal link text tokens | 0.10 |

**IDF guard:** tokens appearing in ≥ 75% of pages (e.g. "atb", "bank") are excluded from scoring as site-identity tokens.

**Personal query guard:** queries containing "my account", "mon solde", etc. are blocked from siteIndex and fall through to catalog.

**Document sub-path:** if the question mentions documents/forms/downloads, `searchDocumentLinks()` is called on the matched pages. It scores individual download links using `_stemMatch()` (prefix-based French morphological match). If the top link scores ≥ 0.6 (`SPECIFIC_DOC_THRESHOLD`), the answer returns a specific document with direct download URL. Below 0.6, it returns a generic list of all indexed downloads.

**Answer format (document, specific match):**
```
Best matching document: **<title>** (PDF)
Download: https://atb.tn/doc/...
Source: https://atb.tn/documents_utiles.php
```

**Contact sub-path:** siteIndex extracts phone/email from crawled `contactFacts` and returns them with a source URL.

**Answer:** built by `buildSiteIndexAnswer()` — max 3 lines, deterministic, no AI call.

---

### P2 — Contact facts (static)

**Trigger:** `detectSourceType()` classifies the query as `contact_facts`.

**Answer:** returned from a static set of hardcoded public ATB contact information (phone numbers, head office address) via `buildContactFactsAnswer()`. These are public facts — not private user data.

---

### P3 — Catalog (Laragon resources)

**Trigger:** all queries that did not resolve in P0–P2 fall through to `handleChatMessage`, which calls the Python AI service (port 8000). The AI service uses the Laragon resource catalog for product/service information, document metadata, and account-related questions.

**Scope:** catalog answers personal/profile questions (account types, loan products, card features, required documents for an account opening, etc.) that are unique to each user context and not found on the public site.

---

### Ask Mode — Action Redirect

If the query is classified as a browser action (uses `_ASK_MODE_ACTION_RE`: navigate, open, find, download, etc.) AND would normally be a browser task, Ask mode returns a redirect message instead of executing it:

> "Switch to **Act on site** mode so I can perform browser actions..."

---

## 3. Act Mode Architecture

### Overview

Act mode always launches a Python browser-use agent for every request. There is no DOM planner, no fast path, and no catalog lookup in Act mode. Every query goes directly to browser-use.

This is explicitly enforced in `run_agent.py` (`__main__` block, lines 678–687):
```python
print('[RUN_AGENT] routing=browser-use (act-mode)', flush=True)
result = asyncio.run(run_browser_use_agent(raw_task))
```

### Flow

```
Widget (React)
  → POST /api/widget/chat  { mode: "act", message, traceId, ... }
  → Node.js route: handleBrowserTaskOrDelegate
    → isBrowserAgentTask(message) = true
    → createBrowserAgentJob(message)  ← returns jobId immediately
  → Response: { status: "browser_agent_queued", jobId }

Widget saves state to localStorage, then:
  → POST /api/widget/browser-agent/:jobId/start
  → Node.js: launchBrowserAgentJob(jobId)
    → spawn("python", ["run_agent.py", task])

Widget polls:
  → GET /api/widget/browser-agent/:jobId  (every 700 ms)
  → GET /api/widget/trace/:traceId        (live step logs)

Python run_agent.py exits:
  → Node.js reads stdout, extracts "=== Result ===" section
  → Formats answer with formatBrowserAgentAnswer()
  → Job status → "done", finalAnswer stored in memory
  → Widget receives answer on next poll
```

### Browser-Use Routing (Python)

Task type classification (`classify_task()` in `run_agent.py`):

| Task type | Trigger pattern | Executor |
|---|---|---|
| `document_download` | form, PDF, télécharger, demande de, dossier | browser-use |
| `multi_step_action` | simulator, calculateur, simuler | browser-use |
| `page_then_answer` | "et trouve", "puis dis-moi", "then tell" | browser-use |
| `simple_page_open` | default | browser-use |

All four types use browser-use in Act mode. The semantic router code exists but the act-mode branch bypasses it (`routing=browser-use (act-mode)`).

### Document Retrieval in Act Mode

For document tasks (`_DOCUMENT_TASK_RE` match), browser-use receives extra guidance:

1. Look for "Documents utiles", "Formulaires", "Téléchargements" sections
2. When a matching link is found, call `report_document(title, url, page_name)` immediately
3. **Do NOT click PDF links** — read the `href` and call `report_document()` instead
4. If current URL already ends in `.pdf/.doc/.docx/.xls/.xlsx/.zip/.rar`, call `done()` immediately

**`report_document()` validation:**  
- Rejects non-file URLs (no `.pdf` extension → keep searching)
- Validates against `DOCUMENT_RULES` (keyword match/exclusion for personal account docs)
- On acceptance: opens file in a new tab, returns `FINAL_PAGE_URL` structured output

**Downloadable-URL rescue flow:**  
If the agent navigates to a downloadable URL but does not call `report_document()` (e.g. clicks the link and navigates to the PDF):
- `_on_step` callback detects the URL extension via `_DOWNLOADABLE_EXT_RE`
- Sets `_step_tracker["doc_url"]` immediately
- After `agent.run()` returns (or on timeout): if `doc_url` is set, Python returns a `FINAL_PAGE_URL` success block instead of failure

**Output format (document tasks):**
```
FINAL_PAGE_URL: https://atb.tn/documents_utiles.php
DOCUMENT_TITLE: Demande relative à la carte bancaire
DOCUMENT_URL: https://atb.tn/doc/Demande-relative-a-la-carte-bancaire.pdf
EVIDENCE: <key page text>
ANSWER: Found document: Demande relative à la carte bancaire
```

**Output format (non-document tasks):**
```
FINAL_URL: https://atb.tn/nous-contacter
EVIDENCE: <key fact from page>
ANSWER: <1–3 line answer>
```

### Timeout Stack

| Layer | Value | Notes |
|---|---|---|
| Python `asyncio.wait_for` | 170 s | Kills browser-use coroutine |
| Node.js `setTimeout` (job kill) | 180 s | Kills Python subprocess if still running |
| CLI test runner `TIMEOUT_BROWSER` | 180 s | CLI gives up polling after 180 s |

**Timeout → failure (default):** Python returns `"Task timed out after 170 seconds."` → Node formats as timeout → CLI check `browser-no-timeout` = FAIL.

**Timeout → success (rescue only):** if `_step_tracker["doc_url"]` is set (agent navigated to a downloadable URL during steps), Python converts the timeout to a `FINAL_PAGE_URL` success block. Node.js trace detects `[BROWSER_USE_AGENT] timeout_converted_to_document_found=` and shows "Rescue: timeout — document URL found, converting to success."

---

## 4. Widget Architecture

### Component: ChatWidget.jsx

- Float bubble injected into host page as a cross-origin `<iframe>` loaded from `http://localhost:5174`
- Mode toggle: **Ask question** / **Act on site**, persisted to localStorage via `widgetCache.getMode()`/`setMode()`
- Sends `{ message, mode: "ask"|"act", cacheContext, siteContext, traceId, conversationId, ... }` to backend
- In Act mode, after receiving `{ status: "browser_agent_queued", jobId }`: saves state to localStorage, calls `/browser-agent/:jobId/start`, then polls `/browser-agent/:jobId` and `/trace/:traceId` every 700 ms
- Chat state (messages, open/closed, pending job) persists across host-page navigation via localStorage (`atb_widget_chat_state`, 1-hour TTL)
- Bridge: pending job state also written to `atb.tn` parent-page localStorage via `ATB_WIDGET_SAVE_BRIDGE` postMessage so the extension can restore after page reload
- `__atbWidgetReset()` exposed on both iframe window and host page window for dev reset

### Service: agentApi.js

Key exports and responsibilities:
- `sendAgentMessage()` — POSTs to Node.js `/api/widget/chat`, returns normalized response
- `requestSiteContext()` — postMessages `ATB_SITE_CONTEXT_REQUEST` to content.js (1.2 s timeout), resolves with full DOM extraction
- `requestPageSnapshot()` — postMessages `ATB_PAGE_INSPECT_REQUEST` to content.js (0.8 s timeout), resolves with interactive element refs
- `fetchBrowserAgentJob()` / `triggerBrowserAgentJobStart()` — polling and job start
- `saveChatState()` / `readChatState()` / `clearChatState()` — localStorage persistence for conversation across navigation
- `clearAllWidgetState()` — removes all `atb_widget_*` localStorage keys

### Service: widgetCache.js

Client-side cache for lightweight data; avoids re-extracting or re-asking on every request.

| localStorage key | TTL | Content |
|---|---|---|
| `atb_widget_mode` | none (user pref) | `"ask"` or `"act"` |
| `atb_widget_contact_facts` | 24 h | Phone/address facts from previous response |
| `atb_widget_document_index` | 6 h | Document index metadata from previous response |
| `atb_widget_site_context` | 5 min | Last siteContext extraction |

`buildCacheContext()` returns `{ contactHit, contactAge, docIndexHit, docIndexAge }` included in every backend request. Backend logs these as `Cache: contact info hit/refreshed` and `Cache: document index hit/refreshed`.

**Static seed:** `DEFAULT_CONTACT_FACTS` contains hardcoded public ATB phone/address values as a starting point when no cached entry exists. `hit: false` signals the backend these are defaults, not freshly fetched.

---

## 5. Hosted Site Context Architecture

### Content Script: content.js (widget-injector-extension)

The extension content script runs in the host page (atb.tn). The chat widget iframe is cross-origin and cannot read the host DOM directly.

**Communication protocol:**

```
Widget iframe ──postMessage──► content.js (host page)
   ATB_SITE_CONTEXT_REQUEST
                  ◄──postMessage── content.js
                  ATB_SITE_CONTEXT_RESPONSE { context: buildSiteContext() }
```

### buildSiteContext() — Extracted Fields

| Field | Content | Cap |
|---|---|---|
| `url` | `location.href` | 500 chars |
| `origin` | `location.origin` | |
| `title` | `document.title` | 300 chars |
| `language` | `<html lang="">` | |
| `headings` | All `h1–h6` text (visibility: allows opacity:0 for sliders) | 30 items, 300 chars each |
| `textBlocks` | All `p`, `blockquote`, `figcaption` text (≥ 20 chars, deduped) | 40 items, 300 chars each |
| `links` | All visible `a[href]` (non-download), text + abs href | 80 items |
| `downloadLinks` | All `a[href]` with `.pdf/.docx/.xlsx/.zip` etc. | 40 items |
| `buttons` | All visible `button/[role=button]/input[submit]` text | 40 items |
| `forms` | Action URL, method, field names | 10 forms |
| `contactFacts.emails` | Regex-extracted from `document.body.textContent` | 10 |
| `contactFacts.phones` | Regex-extracted from `document.body.textContent` | 10 |
| `stats` | Counts of each field type + total textLength | |
| `timestamp` | `Date.now()` | |

**No ATB-specific selectors.** All extraction uses generic HTML semantics: tag names, ARIA roles, class-name patterns only.

---

## 6. Site Index Architecture

### Crawler: scripts/build-site-index.js

BFS crawler using Node.js built-ins only (no npm dependencies).

| Config | Default | Env var |
|---|---|---|
| Target URL | `https://atb.tn` | `TARGET_URL` |
| Max pages | 20 | `SITE_MAX_PAGES` |
| Max depth | 2 | `SITE_MAX_DEPTH` |
| Delay between requests | 400 ms | `SITE_DELAY_MS` |

**Output:** `backend-node/.cache/site-index.json`

**Per-page indexed fields:** `url`, `title`, `language`, `headings[]`, `textBlocks[]`, `links[]`, `downloadLinks[]`, `contactFacts.{emails, phones}`, `crawledAt`

Download links are collected separately from any page, including from `documents_utiles.php` (ATB's forms page). External URLs are recorded as link metadata but not crawled.

**Not crawled:** `.jpg/.png/.css/.js/.json/.xml` etc. are skipped. `.pdf/.docx/.xlsx/.zip` are collected as download links, not followed.

### Service: siteIndex.service.js

- **`getSiteIndex()`** — reads from `site-index.json` with 5-minute in-memory cache
- **`searchSiteIndex(query, index)`** — token-overlap scoring (see §2 P1), returns `[{page, score}]` sorted desc, filtered ≥ 0.30
- **`searchDocumentLinks(question, matches)`** — scores individual `downloadLinks` using `_stemMatch()`, returns top 5 scored ≥ 0.30
- **`buildSiteIndexAnswer(question, matches)`** — deterministic answer builder, max 3 lines
- **`summarizeSiteIndex(index)`** — returns `{ pageCount, totalLinks, totalDownloads, generatedAt, topPages }` (used by `/site-index/summary` dev endpoint)
- **`_stemMatch(a, b)`** — prefix-based stem match for French: min 5 chars, matches `"demander"↔"demande"`, `"bancaires"↔"bancaire"`

---

## 7. Catalog / Laragon Architecture

### Role in Ask Mode

The Laragon resource catalog is the **last resort** in Ask mode (P3). It handles:
- Product/service feature questions (loan rates, card types, account types)
- Document requirements for specific products ("what documents to open an SME account?")
- Personal banking questions that reference specific products
- Any question not resolved by siteContext, siteIndex, or contact facts

### searchCatalogDocuments()

`resourceCatalog.service.js` exports `searchCatalogDocuments(query, catalog)`:
- Only activates for queries containing document/form keywords (`document`, `formulaire`, `pdf`, `attestation`, `relevé`, etc.)
- Scores catalog entries by token overlap in title (2.0), description (0.5), intents (0.3), file extension bonus (0.5)
- Excludes generic resource query tokens (`GENERIC_RESOURCE_QUERY_TERMS`)
- Returns top 5 scored entries

### Separation from siteIndex

The catalog is intentionally separate from the public site index:
- Catalog = structured data about ATB products, documents, requirements (may require Laragon/DB access)
- siteIndex = public website content, forms available for download, contact info

The siteIndex guard (`_isPersonalQuery`) and `isGenericDocQuery`/`isGenericContactQuery` guards ensure that product-specific queries ("what documents are required for an SME account?") are NOT intercepted by siteIndex and fall through to catalog.

---

## 8. Browser-Use Architecture

### run_agent.py

Entry point for all Act-mode browser automation. Spawned by Node.js as a subprocess:
```
spawn(PYTHON_BIN, ['run_agent.py', task], { cwd: BROWSER_AGENT_DIR })
```

**CDP mode (default, `USE_CDP=true`):**  
Connects to an existing Chrome instance via Chrome DevTools Protocol at `http://127.0.0.1:9222`. Uses `BrowserSession(cdp_url=CDP_URL)`. Finds the ATB tab by querying `/json/list` and switches focus to it before running.

**Headless mode (`USE_CDP=false`):**  
Launches its own Chrome instance via `BrowserProfile`. Used for testing only.

### LLM

`ChatOllama` with model configured via `OLLAMA_MODEL` env var (default: `gemma4:e4b`).  
Parameters: `num_ctx=16384` (required — browser-use system prompt + DOM exceeds 8192), `num_predict=2048`, `temperature=0`.

### Step Budget

`_BROWSER_USE_MAX_STEPS = 8` — hard cap. Agent parameters:
- `use_vision=False` — text-only DOM inspection
- `enable_planning=False` — no multi-step planning phase
- `max_history_items=6` — limits context growth
- `max_clickable_elements_length=6000` — limits DOM sent to LLM per step

### Tools Available to Agent

- `report_document(title, url, page_name)` — signals document found, validates file URL extension and optional DOCUMENT_RULES keyword match, returns `is_done=True` on success
- Standard browser-use actions (navigate, click, scroll, read DOM, etc.)

### _step_tracker (module-level dict)

Reset at start of each `run_browser_use_agent()` call. Updated by `_on_step` callback:
```python
_step_tracker = {"last_url": "", "last_step": 0, "doc_url": "", "doc_title": ""}
```
`doc_url` is set when the agent's current URL matches `_DOWNLOADABLE_EXT_RE` (`.pdf|.doc|.docx|.xls|.xlsx|.zip|.rar`). Used by the rescue path.

### Output Parsing (Node.js)

`runBrowserAgent()` extracts the answer from stdout after `"=== Result ==="`. The answer is then processed by `formatBrowserAgentAnswer()`:

1. **`FINAL_PAGE_URL:` block** → extract DOCUMENT_TITLE + DOCUMENT_URL → format as `"Found: **title**\nDownload: url"`
2. **`FINAL_URL:` block** → extract ANSWER field only
3. **Compact prefixed output** (`"Opened:"`, `"Contact channels found:"`) → pass through directly
4. **Timeout text** → return clean timeout message
5. **Verbose/old LLM output** → strip preamble, extract URL + first key line

---

## 9. Trace and Test Architecture

### demoLogger.js

Dual-mode logger controlled by `DEMO_CONSOLE=true/false` env var:

- **Demo mode** (`DEMO_CONSOLE=true`): prints `[DEMO] [HH:MM:SS] Label: message` lines only. All verbose debug suppressed.
- **Debug mode** (`DEMO_CONSOLE=false`): forwards raw `[DOM_AGENT]`, `[BROWSER_USE_AGENT]`, etc. lines from Python subprocess in real-time.

`stepLog(label, message)` uses `AsyncLocalStorage` to automatically route log lines to the correct trace buffer for the current async request context.

### traceBuffer.service.js

In-memory per-request trace:
- `createTrace(traceId)` → stores `{ lines: [], done: false, ts }`
- `appendTrace(traceId, line)` → called by `stepLog()`
- `getTrace(traceId)` → returns `{ lines, done }` — consumed by `/trace/:traceId` polling endpoint
- `markTraceDone(traceId)` → signals the CLI runner to stop polling
- TTL: 10 minutes — never stores LLM outputs, screenshots, or DOM snapshots

### Terminal Trace Lines (demo mode)

A complete Act-mode trace looks like:
```
[HH:MM:SS] User: "Je veux trouver le formulaire pour demander une carte"
[HH:MM:SS] Mode: Act on site
[HH:MM:SS] SiteCtx: url=https://atb.tn/ ... usable=yes
[HH:MM:SS] SiteIndex: exists=yes pageCount=20 downloads=15
[HH:MM:SS] Route: browser-use agent
[HH:MM:SS] Agent: browser-use agent started
[HH:MM:SS] Step: step 1/8 — navigate to documents page
[HH:MM:SS] Step: step 2/8 — https://atb.tn/documents_utiles.php
[HH:MM:SS] Document: found at "Demande-relative-a-la-carte-bancaire.pdf"
[HH:MM:SS] Evidence: "Demande relative à la carte bancaire"
[HH:MM:SS] Answer: "Found: **Demande relative à la carte bancaire**"
[HH:MM:SS] Final URL: https://atb.tn/documents_utiles.php
[HH:MM:SS] Done: success — document opened (18s)
```

### CLI Runner: run-widget-task.js

```
npm run task:ask -- "your question"
npm run task:act -- "find the ATB messenger form"
npm run task:all
```

Sends the same request body as the widget, polls `/trace/:traceId` every 700 ms, and prints the demo trace in real time.

**PASS/FAIL checks:**

| Check name | Rule |
|---|---|
| `max-3-lines` | Answer must have ≤ 3 non-empty lines |
| `ask-no-browser-job` | Ask mode must not return `browser_agent_queued` |
| `browser-no-timeout` | Act mode trace must not contain timeout signal |
| `browser-use-failed` | Act mode trace must not contain `Done: failed` |
| `act-uses-browser-use` | Trace must show `Route: browser-use agent` (not DOM planner or fast path) |
| `simulator-evidence` | Simulator tasks: trace must have URL + simulator keyword + `Done: success` |
| `safety-blocked` | Sensitive action queries must be blocked |
| `contains:"..."` | Expected substring present in answer (catalog tests) |
| `absent:"..."` | Forbidden substring absent from answer (catalog tests) |
| `expected-match:"..."` | `Match: <title>` line present in trace (catalog tests) |
| `phone-answer-content` | ATB phone questions must contain a known number |
| `address-answer-content` | ATB address questions must contain known address |

**Timeout truthfulness:** timeout is FAIL. It only converts to success if `_step_tracker["doc_url"]` is set (rescue logic) — not from timing alone.

---

## 10. Current Known Limitations

| Area | Status |
|---|---|
| **Act mode speed** | browser-use is fully autonomous with max 8 LLM-driven steps. Each step takes ~8–15 s. Total time can reach 60–120 s for multi-page tasks. |
| **Complex tasks** | Tasks requiring 3+ page navigations may still exhaust the 8-step budget without a result. |
| **siteIndex freshness** | The crawl must be run manually (`npm run build:index`). Stale index = missed content. Default index covers 20 pages, depth 2 — may not include deeply nested ATB pages. |
| **siteContext page scope** | Only the page currently open in the browser is included. Other tabs or navigated-away pages are invisible. |
| **Safety** | `_SAFETY_BLOCK_RE` is implemented and tested for sensitive banking actions (login, OTP, transfer, payment). Not yet finalized for production. |
| **Authentication/security hardening** | `widgetDemoGuard` uses a hardcoded demo user. No real JWT/session authentication exists yet. |
| **No DOM executor in Act mode** | DOM fast path, DOM planner, and document fast path from `dom_agent.py` are NOT used in Act mode. They exist as dead code for older flow. |
| **Catalog requires Laragon** | Catalog-based P3 Ask answers require the Laragon resource server running. Without it, catalog queries return generic errors or empty answers. |
| **Chat history context** | `conversationHistory` is sent to the AI service but browser-use receives only the single task string — no prior turns. |
| **No rate limiting** | No request rate limiting or job queue limit on the Node.js side. |

---

## 11. File Map

| File | Role |
|---|---|
| `widget-agent/src/components/ChatWidget.jsx` | Main React chat UI, mode toggle, bubble, conversation, polling loop |
| `widget-agent/src/services/agentApi.js` | API client: POST chat, poll job/trace, postMessage bridge, localStorage persistence |
| `widget-agent/src/services/widgetCache.js` | Browser-side cache: mode pref, contact facts (24h), document index (6h), site context (5min) |
| `widget-injector-extension/content.js` | Extension content script: injects iframe, builds `siteContext` and `pageSnapshot`, routes postMessages, handles actions |
| `backend-node/src/routes/widgetDemo.routes.js` | Request router: mode detection, Ask P0–P1 retrieval, Act browser-job queue/poll endpoints, trace endpoint |
| `backend-node/src/services/siteContext.service.js` | Normalizes and answers from siteContext; `isCurrentPageQuestion`, `buildSiteContextAnswer` |
| `backend-node/src/services/siteIndex.service.js` | Loads, searches, and answers from site index; `searchDocumentLinks`, `_stemMatch`, `buildSiteIndexAnswer` |
| `backend-node/src/services/resourceCatalog.service.js` | Loads Laragon catalog; `searchCatalogDocuments`; tokenization and scoring for catalog queries |
| `backend-node/src/services/resourceAnswer.service.js` | Builds catalog-based answer text |
| `backend-node/src/services/resourceResolver.service.js` | Resolves catalog resource by type/id |
| `backend-node/src/services/browserAgent.service.js` | Job store, Python subprocess spawn, task builder, answer formatter, demo trace translator, `_emitDemoStep` |
| `backend-node/src/services/traceBuffer.service.js` | In-memory per-request trace buffer (10 min TTL); `createTrace`, `appendTrace`, `getTrace`, `markTraceDone` |
| `backend-node/src/utils/demoLogger.js` | Dual-mode logger; `stepLog` writes `[DEMO]` lines + appends to trace buffer via `AsyncLocalStorage` |
| `browser-agent/run_agent.py` | Python entry point: safety block → classify_task → always browser-use in act mode; `_step_tracker`, rescue logic, `report_document` tool |
| `scripts/build-site-index.js` | BFS crawler (no npm deps): crawls site, extracts page context, saves `site-index.json` |
| `scripts/run-widget-task.js` | CLI test runner: sends requests, polls trace, evaluates PASS/FAIL for single or batch tests |
| `scripts/run-all-tests.js` | Master test suite: 12 catalog tests + 3 Act tests + 2 safety tests |

---

## 12. Request Flow Diagrams

### Ask Mode — Document Query

```
User: "Je cherche le formulaire d'abonnement ATBNET"
  │
  ├─ Widget: requestSiteContext() → content.js builds DOM snapshot
  │
  ├─ POST /api/widget/chat { mode: "ask", message, siteContext, traceId }
  │
  ├─ handleBrowserTaskOrDelegate: isAskMode=true → skip browser → next()
  │
  ├─ handleAskRetrieval:
  │   P0: isCurrentPageQuestion? No → skip
  │   P1: searchSiteIndex(message) → score=0.82 (documents page hit)
  │       searchDocumentLinks(message, matches) → "Formulaire Abonnement ATBMOBILE" score=0.72
  │       score ≥ 0.6 → specific document answer
  │       return: "Best matching document: **Formulaire Abonnement...**\nDownload: ...\nSource: ..."
  │
  └─ Widget displays answer (no AI call, < 50 ms)
```

### Act Mode — Document Search

```
User: "Find the ATB Messenger subscription form"
  │
  ├─ POST /api/widget/chat { mode: "act", ... }
  │
  ├─ handleBrowserTaskOrDelegate:
  │   isBrowserAgentTask = true
  │   createBrowserAgentJob → jobId
  │   return { status: "browser_agent_queued", jobId }
  │
  ├─ Widget saves state → POST /browser-agent/:jobId/start
  │
  ├─ launchBrowserAgentJob:
  │   spawn("python run_agent.py", task)
  │
  ├─ run_agent.py:
  │   safety check → pass
  │   classify_task → document_download
  │   routing=browser-use (act-mode)
  │   asyncio.wait_for(run(task), timeout=170)
  │
  ├─ Agent steps (max 8):
  │   step 1: navigate atb.tn
  │   step 2: find documents_utiles.php link
  │   step 3: navigate documents_utiles.php
  │   step 4: find "Formulaire Abonnement ATB Messenger" link
  │   step 4: call report_document("Formulaire Abonnement...", "https://atb.tn/doc/...")
  │     → validate: URL ends .pdf → accept
  │     → open in new tab, return FINAL_PAGE_URL block
  │
  ├─ Python prints "=== Result ===" + FINAL_PAGE_URL block
  │
  ├─ Node.js formatBrowserAgentAnswer:
  │   "Found: **Formulaire Abonnement ATB Messenger**\nDownload: https://..."
  │
  ├─ job.status = "done", finalAnswer stored
  │
  └─ Widget poll receives answer, displays + download button
```

---

*Architecture document reflects code state as of 2026-06-25. Generated from direct source reading — no AI hallucination of APIs or flows.*
