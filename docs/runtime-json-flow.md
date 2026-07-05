# ATB AI Agent Runtime JSON Flow

High-level flow:

```
User → Widget (widget-agent/src/services/agentApi.js)
     → Backend (backend-node/src/routes/chat.routes.js, widgetDemo.routes.js)
     → site-index.json (siteIndex.service.js + siteIndexAdapter.service.js)
     → Model/Router (agentCaseRouter.service.js + ai-service-python decision_service.py)
     → Validation (allowedUrls / isUnsafeRequest / availableActions filter)
     → Browser Action (widgetDemo.routes.js async job+poll) OR Answer (chat.controller.js)
     → Widget (res.json)
```

Every JSON block below is tagged **actual from code**, **inferred from code**, or **recommended but not implemented**.

---

## 1. Generated site-index.json schema

**actual from code** — new/"clean" schema, detected by `isCleanFormat(raw) = Array.isArray(raw.uniqueDocuments)`:

```json
{
  "pages": [ /* array, required — load fails without it */ ],
  "uniqueDocuments": [],
  "uniqueDocumentActions": [],
  "uniqueForms": [],
  "uniqueBusinessForms": []
}
```

File/function: `backend-node/src/services/siteIndex.service.js:57-76` (`getSiteIndex`, requires `Array.isArray(parsed.pages)`), `backend-node/src/services/siteIndexAdapter.service.js:23-25` (`isCleanFormat`), `:50-168` (`adaptSiteIndex`, reads `pages`, `uniqueDocuments`, `uniqueDocumentActions`, `uniqueBusinessForms`).

**Old fields still referenced (benign, not a live bug):** `siteIndex.service.js:784` reads `index.documentOccurrences` — an old-schema field name — but it's safe because `adaptSiteIndex()` always synthesizes `resources[]`/`documentOccurrences[]` from the new schema before that code runs (adapter:60-168, a deliberate compatibility shim per its own header comment). No other code path in `backend-node/src` reads raw `resources`/`documentOccurrences` off an unadapted index. Fragile if that call path is ever bypassed.

Load path: primary `site-context/<domain>/site-index.json` (domain from `TARGET_URL`, default `atb.tn`), fallback `backend-node/.cache/site-index.json`.

---

## 2. Widget request JSON

**actual from code** — `widget-agent/src/services/agentApi.js:528-556` (`sendAgentMessage`), POST to `http://localhost:5000/api/widget/chat` (default):

```json
{
  "message": "string",
  "payload": {},
  "conversationId": "string",
  "conversationHistory": [],
  "profileContext": {},
  "agentContext": {},
  "pageSnapshot": {},
  "pageGoalState": {},
  "mode": "ask",
  "cacheContext": {},
  "siteContext": {}
}
```

`mode` defaults to `"ask"` (agentApi.js:537). Action-flow calls (**actual from code**, agentApi.js:828-879): `POST /api/widget/actions/execute|confirm|cancel|verify-and-execute`. Browser job control: `POST /api/widget/browser-agent/{jobId}/start`, `GET /api/widget/browser-agent/{jobId}` (agentApi.js:709-747).

---

## 3. Backend routing JSON

**actual from code** — `backend-node/src/routes/chat.routes.js:119-121`:
- `POST /analyze` → `analyzeChatMessage`
- `POST /message` → `handleChatMessage`
- `POST /message-with-files` → `handleChatMessageWithFiles` (multer; allowed `.pdf .png .jpg .jpeg .webp .txt .csv .json`; blocked `.exe .bat .js .ps1` etc., lines 28-55)

`analyzeChatMessage` request body (chat.controller.js:10803):
```json
{
  "message": "string",
  "conversationHistory": [],
  "agentContext": {}
}
```
400 if `message` missing (chat.controller.js:10806):
```json
{ "success": false, "message": "message is required" }
```

**ASK vs ACT is not a request field — it's computed server-side** by a regex/heuristic case router, not the model. `backend-node/src/services/agentCaseRouter.service.js:800` `routeAgentCase({ message, memoryContext })` → `buildDecision()` (770-798):

```json
{
  "case": "NORMAL_CHAT | BANKING_ACTION | RESOURCE_DOWNLOAD | UNSAFE_REQUEST | ...",
  "modelMode": "string",
  "needsResourceSearch": true,
  "needsPdfVision": false,
  "needsActionFlow": false,
  "needsMemory": false,
  "resourceHint": null,
  "detailHint": null,
  "explicitPage": null,
  "safetyDecision": null,
  "resourceMemoryMatch": null,
  "reason": "string"
}
```
File/function: `agentCaseRouter.service.js:4-17` (`CASES` enum), `:770-798`.

A second, separate decision layer runs on the Python side via `decideMessage(...)` (chat.controller.js:10865) for the `/analyze` endpoint's `answer_directly | search_resource | prepare_action | ask_clarification` split — see section 7.

---

## 4. ASK mode flow

**actual from code.** Case router marks `needsResourceSearch: true`, `needsActionFlow: false`. Flow: `agentCaseRouter` → `searchSiteIndex`/`collectEvidence` (section 6) → answer built from evidence → `res.json({ success: true, ... })`.

Not a separate documented endpoint — same `/analyze` and `/message` routes handle both modes; the branch is internal (`case` field above).

---

## 5. ACT mode flow

**actual from code.** Case router marks `needsActionFlow: true` (e.g. `BANKING_ACTION`). Two independent execution systems exist, selected by action type — not a single unified "ACT" path:

1. **Mocked banking actions** — `actionExecution.service.js` mutates in-memory mock data (`mockAccounts/mockBeneficiaries/mockBills/mockComplaints/mockDocuments/mockTransactions`) for `pay_bill`, `make_transfer`, `book_appointment`, `create_complaint`, `check_balance`. Gated by `getExecutionMode()` in `actionPreparation.service.js:16`. No browser/CDP involvement.
2. **Browser-driven navigation/document opening** — async job+poll via `widgetDemo.routes.js` (see section 9).

---

## 6. Candidate/search result JSON

**actual from code** — `siteIndex.service.js:404-519` `searchSiteIndex(query, index, {maxResults=5, minScore=0.30})` produces:
```json
{ "page": { "...pageObject": "..." }, "score": 0.0 }
```
Scoring: title match ×0.40, headings ×0.30, download-link text ×0.25, url ×0.20, body ×0.15, link text ×0.10, URL-slug stem boost +0.40/token, exact-phrase boost +0.50, category boosts +0.20–0.50, ubiquitous-token exclusion for tokens in ≥75% of pages (413-424). No separate "click penalty" constant found in this file (not confirmed absent — may live elsewhere, not read this pass).

`collectEvidence(query, index)` (745-813) builds candidates surfaced to the answer layer, sorted desc, top 10:
```json
{
  "sourceType": "site-index",
  "kind": "page",
  "title": "string",
  "url": "string",
  "text": "string",
  "score": 0.0
}
```
Document hits: score = page score × 0.85. `documentOccurrences`-sourced hits: `score = min(hits * 0.35, 0.90)`.

`searchDocumentLinks(question, matches)` (285-340) — downloadable-file candidates, filtered `score >= 0.3`:
```json
{ "dl": { "...": "..." }, "page": { "...": "..." }, "score": 0.0 }
```

---

## 7. Model decision JSON

**actual from code** — `ai-service-python/app/schemas/agent.py`. Request (`AgentAnalyzeRequest`, 103-117):
```json
{
  "requestId": "string",
  "threadId": "string",
  "message": "string",
  "userRole": "string",
  "availableActions": [],
  "conversationHistory": [],
  "fileContext": {},
  "resolvedResourceContext": {},
  "profileContext": {},
  "agentContext": {},
  "modelRouting": {},
  "threadContext": {},
  "requestContext": {},
  "agentPlan": {}
}
```
Response (`AgentDecisionData`, 165-174):
```json
{
  "decision": "answer_directly | search_resource | prepare_action | ask_clarification",
  "intent": "string",
  "resourceQuery": "string",
  "action": "string",
  "fields": {},
  "missingFields": [],
  "clarificationQuestion": "string",
  "quickActions": []
}
```

Actual model call — `ollama_service.py:529-560` `decide_with_ollama()`:
```json
{
  "prompt": "<built by build_ai_decision_prompt(request)>",
  "stream": false,
  "format": "json",
  "options": { "temperature": 0, "num_predict": 450 }
}
```
`format: "json"` only guarantees well-formed JSON from Ollama, not schema conformance — response text is still parsed via `_extract_json_object`.

**Fallback/validation behavior — actual from code**, `decision_service.py:760-771`:
```python
fallback = _rule_based_decision(request)
if not settings.USE_OLLAMA:
    return fallback
try:
    raw_result = decide_with_ollama(request)
    return _validate_model_decision(raw_result, request, fallback)
except (OllamaServiceError, ValueError, TypeError, KeyError):
    return fallback
```
A rule-based fallback is always computed first. `_validate_model_decision()` (661-757) rejects the model result if `decision` isn't in `VALID_DECISIONS`, strips any `action` not present in `request.availableActions`, and re-derives `missingFields` deterministically rather than trusting the model. **Model output is validated, not blindly trusted**, for this path. `plan_intent_with_ollama()` (563-608+) follows the same `format:"json"` + `_extract_json_object` pattern (inferred to have similar fallback handling in `intent_planner_service.py`, not fully read/confirmed).

---

## 8. Backend validation JSON

**actual from code** — URL allowlist, `siteIndexAgent.service.js:1149-1158`:
```js
if (idx && idx.allowedUrls instanceof Set && idx.allowedUrls.size > 0) {
  return idx.allowedUrls.has(url);
}
if (Array.isArray(raw.resources) && raw.resources.length > 0) {
  return raw.resources.some((r) => r.url === url);
}
```
Gated on same-hostname check first (1150-1152). `allowedUrls` (a `Set`) built per index-shape branch at lines 388, 575-576, 634-636.

Message-level safety (separate from URL allowlist) — `agentCaseRouter.service.js:135-146` `isUnsafeRequest()`, regex-based, blocks prompt-injection phrases, other-user data requests, secret/OTP requests, live-transfer attempts → routes to `CASES.UNSAFE_REQUEST` with `safetyDecision: "refuse"` (808-821).

Action-name validation: `find_available_action(action_name, request.availableActions)` (decision_service.py:693-694) — action dropped to `null` if not in caller-supplied `availableActions`. No separate blocked-action list found beyond this allowlist-by-inclusion.

---

## 9. Browser action JSON

**actual from code — async job + poll, not direct same-tab nav or CDP call from the widget.** `backend-node/src/routes/widgetDemo.routes.js`:

Job creation (lines 295, 375, 397, 410):
```json
{ "success": true, "status": "browser_agent_queued", "jobId": "string" }
```
Comment at line 191: job is created but Python isn't spawned yet.

```
POST /browser-agent/:jobId/start  → handleBrowserAgentJobStart → launchBrowserAgentJob(jobId)  (line 552)
GET  /browser-agent/:jobId        → handleBrowserAgentJobStatus                                (line 558)
```
Widget polls `GET /browser-agent/:jobId` (agentApi.js `fetchBrowserAgentJob`) until status is `browser_agent_done`/`browser_agent_error`/`not_found`. **inferred** — the body of `launchBrowserAgentJob` (the actual process spawn / CDP session) was not read in this pass; naming implies it drives a browser-use/Python process but that is not confirmed.

Separate client-side-only bridge (**actual from code**, agentApi.js:558-664): `requestPageSnapshot`, `requestSiteContext`, `dispatchPageActions` — `postMessage` between widget iframe and host-page loader script. This controls the *current embedding page* DOM, distinct from the browser-agent job.

---

## 10. Final widget response JSON

**actual from code**, `chat.controller.js` `res.json(...)` call sites:

Clarification / missing fields (4404-4416):
```json
{
  "success": true,
  "status": "missing_fields | clarification_required",
  "agentMode": "string",
  "assistantMessage": "string",
  "data": {
    "ai": {},
    "aiDecision": {},
    "finalPayload": {},
    "missingFields": [],
    "pendingAction": {}
  }
}
```

`/analyze` success (10831-10838):
```json
{
  "success": true,
  "message": "Message analyzed successfully",
  "data": { "resourceMatches": [] }
}
```

Widget-side consumption is defensive, not schema-locked — `agentApi.js:449-482` `normalizeAgentResponse()` probes `response.assistantMessage`, `data.assistantMessage`, `data.ai.assistantMessage`, `response.reply`, `response.content`, `data.message`, etc., and returns:
```json
{
  "text": "string",
  "quickActions": [],
  "downloadUrl": "string",
  "actionContext": {
    "status": "string",
    "agentMode": "string",
    "preparation": {},
    "pendingAction": {},
    "pendingConfirmation": {},
    "finalPayload": {},
    "generatedFile": {},
    "ai": {}
  },
  "raw": {}
}
```
This many-fallback probing is evidence the backend response shape is inconsistent across code paths (**inferred**, not itself a confirmed bug today).

---

## 11. Error / not found / blocked examples

**actual from code:**

Bad request, missing message (chat.controller.js:10806):
```json
{ "success": false, "message": "message is required" }
```

File upload rejection (chat.routes.js:109-113), HTTP 400 (multer error) or 415 (other):
```json
{ "success": false, "message": "File upload failed" }
```

**inferred, not directly confirmed this pass:**

Widget-demo-disabled (client-side contract confirmed at agentApi.js:919-929; server-side literal call site not located):
```json
{ "status": "widget_demo_disabled" }
```

Resource not found — `buildResourceNotFoundResponse(...)` used at chat.controller.js:10699 (`return res.json(buildResourceNotFoundResponse(aiDecision.resourceQuery || message))`); function body not read, exact shape not confirmed.

**recommended but not implemented:**

No distinct "blocked action" response JSON was found separate from silently dropping the `action` field to `null` (decision_service.py:693-694) and falling into `ask_clarification`/`missing_fields`. A dedicated `{ "success": false, "status": "action_blocked", "reason": "..." }` shape does not exist in code inspected.

---

## 12. Notes on what is actually implemented vs planned

- ASK/ACT split is a deterministic regex case router (`agentCaseRouter.service.js`), not a model decision — the model (`decide_with_ollama`) is a secondary, validated layer used mainly by `/analyze`.
- Site-index new schema (`pages`, `uniqueDocuments`, `uniqueDocumentActions`, `uniqueForms`, `uniqueBusinessForms`) is the one actually loaded and required; old `resources`/`documentOccurrences` fields are synthesized by an adapter shim for legacy scorer code — not dead, but a compatibility layer, not the source of truth.
- Model output for the `/analyze` decision path is validated against `availableActions` and `VALID_DECISIONS`, with a rule-based fallback always computed first — this is a solid pattern, confirmed implemented.
- Browser action execution is async job+poll, not a direct CDP call in the routes/controller layer read — the actual driver (`launchBrowserAgentJob` body) is unconfirmed and should be read directly before demo.
- Mocked banking actions and browser-driven document/page opening are two entirely separate systems with no shared code path — don't assume one covers the other.

---

## Architecture gaps to fix before demo

- `launchBrowserAgentJob` internals unread/unconfirmed — verify it actually spawns/drives a browser session before relying on it live.
- Widget response normalization (`normalizeAgentResponse`) probes 10+ alternate field paths — indicates backend response shape drift; pick one canonical shape and align controller `res.json()` calls to it.
- No dedicated "action blocked" response — blocked actions silently degrade to `missing_fields`/`ask_clarification`, which is ambiguous with genuinely incomplete requests.
- `buildResourceNotFoundResponse()` and the `widget_demo_disabled` 403 response were not located/confirmed in backend code — verify they exist and match what the widget expects.
- `siteIndex.service.js:784` still names the old field `documentOccurrences` — works only because the adapter always runs first; add a guard/assert if that index object could ever reach this code unadapted.
- No confirmed separate rate-limit/blocked-URL list beyond same-hostname + `allowedUrls` — verify this is sufficient for the demo's navigation scope.
- Missing test command: no single documented command found to (a) rebuild site-index, (b) start backend-node + ai-service-python + widget together, (c) hit `/api/widget/chat` end-to-end. Confirm/create one before supervisor demo.
