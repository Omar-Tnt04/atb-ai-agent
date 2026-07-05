# ASK Mode Diagnosis — "quelle est l'adresse du mediateur de l'ATB?"

Read-only diagnosis. No code modified. Repo at commit `11ec2c8`. All findings below are **confirmed in code** unless marked **inferred**.

---

## 1. Current ASK mode entry point

Route chain — `backend-node/src/routes/widgetDemo.routes.js:577`:
```js
router.post('/chat', logWidgetRequestEntered, withTrace, withConversationContext,
  withIntentPreclassify, withRequestContext, withAgentPlan,
  handleBrowserTaskOrDelegate, handleAskRetrieval, handleChatMessage);
```
`withIntentPreclassify`/`withRequestContext`/`withAgentPlan` are **observational only** (comment at line 133: "Does NOT affect routing"). Real ASK decision-making happens in `handleAskRetrieval` (lines 429-539); `handleBrowserTaskOrDelegate` (179-419) early-returns for `mode='ask'` at line 249 unless the message text itself looks like an explicit browser command. Final fallback: `handleChatMessage`, `chat.controller.js:11050`.

**Request JSON fields** (from `req.body`, assembled by `sendAgentMessage`, `widget-agent/src/services/agentApi.js:541-553`): `message, mode, siteContext, pageSnapshot, pageGoalState, cacheContext, conversationHistory, traceId, conversationId, agentContext, payload, profileContext`.

**Response JSON fields**: `{ success, assistantMessage }` for `handleAskRetrieval` fast paths (widgetDemo.routes.js:452,502,511,534); richer `{ assistantMessage, data.ai, quickActions, ... }` from `handleChatMessage`.

---

## 2. Current widget request

`widget-agent/src/components/ChatWidget.jsx:963-974`:
```js
let siteContext = null;
if (agentMode === 'ask') {
  const cached = getSiteContext();
  if (cached) { siteContext = cached.ctx; }
  else { siteContext = await requestSiteContext(); if (siteContext) saveSiteContext(siteContext); }
}
```
- `message` field: `message`.
- `mode` field: `mode` (also `agentMode` used client-side pre-send).
- Page context fields: `siteContext` object — contains `url, title, headings(h), links, dl (downloadable links), textLen, usable` (matches the `SiteCtx:` log line shape).
- **Cached, not refreshed per request**: `widgetCache.js:8` `SITE_CONTEXT_TTL_MS = 5 * 60 * 1000` — up to 5 minutes stale, cached per browser tab (not per-URL). Fresh fetch only happens via `requestSiteContext()` (`agentApi.js:596-625`), a `postMessage` round-trip to the host page, when there's no cache hit.

---

## 3. Current source selection — why "Source: general / Match: SME Current Account Product Sheet"

Selection order inside `handleAskRetrieval`:
1. **Site-index search first** (widgetDemo.routes.js:455-488) — `searchSiteIndex(message, siteIndex)`, threshold `0.35`. No match cleared this bar for this query (see §4/§10 for why).
2. `detectSourceType(message)` (`askRetrieval.service.js:29-82`) classifies into `contact_facts | document_index | website_page | branch_directory | catalog | general`. For this query it returns **`GENERAL, confidence 0.50`** because:
   - `_norm()` (line 29-35) strips accents instead of folding them, turning `"médiateur"` into `"m"` (dropped, len<2) + `"diateur"` (garbage fragment) — the word "mediateur" never survives intact.
   - `CONTACT_FACTS` pattern (line 43) matches literal English `address`, never French `adresse`.
   - No pattern in `SOURCE_TYPE_PATTERNS` contains `mediateur`/`médiateur` at all.
   - Falls through every pattern → `GENERAL, 0.50` (line 81) — exactly matches the observed log.
3. `GENERAL` routes to catalog search (`resourceCatalog.service.js`), which returns `"SME Current Account Product Sheet"` as top match. Catalog scoring uses the **same accent-stripping bug** (`normalizeText`, lines 192-198) plus **no French stopword list** (`STOP_WORDS`/`SEARCH_QUERY_FILLERS` are English-only, lines 48-85/215-234) — French fillers `de/du/la/le/est/quelle` survive as noise tokens. Checked `resourceAlias.service.js:77-80` — this title's aliases (`SME account, business current account, ...`) share zero tokens with the query, so the alias table doesn't explain the win either. Exact catalog scoring arithmetic **not fully reproducible** — `catalog.json` lives outside the repo (`C:/laragon/www/atb-general-resources/catalog.json`, not found by Glob) — **inferred**: with the query reduced to noise tokens, most resources score near the same low baseline and an incidental overlap wins by a small margin.

---

## 4. Current site-index usage

`getSiteIndex()` + `searchSiteIndex(message, siteIndex)` called at `widgetDemo.routes.js:455-456`, **before** `detectSourceType` — confirmed ASK mode **does** search site-index.json today (this contradicts an older project memory claiming "Ask mode = catalog only"; that memory is stale).

Arrays searched: `pages` (via `searchSiteIndex`, `siteIndex.service.js:404-519`); `uniqueDocuments`/`documentOccurrences`-derived data via `collectEvidence` for evidence collection elsewhere in the file. Threshold to accept a site-index hit: `score >= 0.35` (widgetDemo.routes.js:458) — a second, lower-priority re-check reuses the same `siteIndexMatches` array for `BRANCH_DIRECTORY|CATALOG_PRODUCT|GENERAL` types (lines 514-536).

Fields used for scoring (`siteIndex.service.js:404-519`): title (×0.40), headings (×0.30), download-link text (×0.25), url (×0.20), body/textPreview (×0.15), link text (×0.10), plus URL-slug and exact-phrase boosts. Tokenizer `_tokenize` (line 211-218) uses `[^a-z0-9À-ž]+`, which **preserves** accented characters (unlike the ASK-classification/catalog normalizers) — but does exact-string, not accent-folded, comparison, so a query without the accent (`mediateur`) still won't token-match an indexed accented word (`médiateur`) unless both happen to be spelled the same way. This is why the site-index search (step 1 above) also failed to surface `/professionnels/mediateur` above 0.35 for this exact query.

---

## 5. Current general resources usage

Loader: `resourceCatalog.service.js:708-749` `loadConfiguredGlobalCatalog()`, reading `env.resourceCatalogPath` (`backend-node/src/config/env.js:28,33`, default `C:/laragon/www/atb-general-resources/catalog.json`) — **file is outside the repo, could not be inspected directly this pass**.

Schema (`normalizeGlobalCatalogResources`, lines 657-701): required `id, title, description, files[]`; optional `category, type, exampleQueries, intents, keyFields, relatedActions, selectionPolicy`. Current catalog is **description-only** (comment lines 662-664, confirmed by `isDescriptionOnlyPolicy()` 1416-1421) — only the `description` field is scored; title/category/intents are metadata only (`scoreDescriptionOnlyEntry`, 1423-1425).

Why "SME Current Account Product Sheet" can win: see §3 — query is reduced to noise tokens by the accent bug + missing French stopwords, so ranking becomes near-arbitrary among low-scoring resources.

---

## 6. Current ranking formula

`resourceCatalog.service.js:192-198` `normalizeText()` — same accent-**stripping** (not folding) bug as `askRetrieval.service.js`:
```js
const normalizeText = (value = '') =>
  String(value || '').toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
```
- **Does "médiateur" match "mediateur"? No.** Confirmed: neither the ASK classifier nor the catalog scorer folds accents — they strip them, producing garbage fragments, not equivalence.
- **French stopwords**: not present in `resourceCatalog.service.js` (English-only `STOP_WORDS`); `siteIndex.service.js` does have a bilingual EN/FR stopword list (line 159-167), but no accent-folding.
- **URL/title/path exact-match boost**: exists in `siteIndex.service.js` (title/url/slug boosts), **does not exist** in `resourceCatalog.service.js`.
- **Document penalty for address/contact-shaped questions**: not found in either scorer — no code checks "is this an address/contact question, downrank documents."
- **Can site-index pages beat local catalog resources?** No — they are two entirely separate, non-cross-ranked scoring systems (`siteIndex.service.js` vs `resourceCatalog.service.js`), invoked from different branches. Site-index is tried first as a hard gate (score ≥ 0.35); if it fails, catalog runs independently with no visibility into site-index's near-misses.

**Fix pattern already exists elsewhere in the repo, unused on the ASK path**: `siteIndexAgent.service.js:65-71` (Act-mode only) has correct accent folding:
```js
function normalize(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ')...
```
Zero occurrences of `.normalize('NFD')` in `askRetrieval.service.js`, `resourceCatalog.service.js`, or `siteIndex.service.js`.

---

## 7. Current page context ("SiteCtx: url=atb.tn/") — not a staleness bug, an architectural gap

`SiteCtx:` log emitted at `widgetDemo.routes.js:212`, sourced directly from `req.body.siteContext` for **this specific HTTP request** — the backend does not cache or re-derive it. Client-side, it's a 5-minute-TTL localStorage cache (`widgetCache.js:8,110-123`) refreshed via `postMessage` to the host page (`requestSiteContext`, `agentApi.js:596-625`) when no cache hit.

Root fact: **Ask mode never drives or observes an Act-mode browser tab.** There is no code path syncing `siteContext` with wherever an Act-mode CDP session navigated. So `url=https://atb.tn/` simply reflects wherever the widget iframe is physically embedded on the host page — in this repro, the user's browser (or the widget's host page) was on the homepage, not `/mediateur`, at request time. This is expected given current architecture, not a stale-cache defect — though it does mean ASK mode cannot answer "what's on this page" style questions unless the widget is embedded on that exact page.

---

## 8. Current answer extraction

No LLM call in any ASK fast-path. Three deterministic builders:
- `buildSiteContextAnswer` (`siteContext.service.js:140-184`) — explicit comment line 139: "No AI call — purely from structured DOM data." Only handles "what page", "documents", "links", generic fallback. **No address/phone field extraction exists here.**
- `buildSiteIndexAnswer` (`siteIndex.service.js:525-655`) — contact branch (581-630) reads only `page.contactFacts.phones/.emails`. **Confirmed: `site-index.json` has zero `contactFacts` keys anywhere in the file** — this branch can never fire for this dataset. Generic fallback (632-655) does `_bodyTextOf(page).slice(0, 80)` (line 646) — grabs the **first 80 characters** of the raw crawled text blob, which is always generic nav boilerplate, never reaching real content further into the string (the mediator's address is at the *end* of its page's `textPreview`).
- `buildContactFactsAnswer` (`askRetrieval.service.js:87-105`) — static hardcoded head-office contact info only; irrelevant to the mediator.

`handleChatMessage`'s LLM-backed reformulation path exists (`chat.controller.js`, near line 9445) but wasn't exercised in this trace (catalog short-circuit fired first). No answer builder cites its source page/document in the user-facing text — `Source:`/`Match:` are trace-log-only.

---

## 9. Separation between ASK and ACT

Confirmed clean. Grep of `askRetrieval.service.js` for `browser_agent_queued|browser_agent_done|navigate|download|CDP|decideAction|launchBrowserAgentJob`: **zero matches**. `handleAskRetrieval`'s `DOCUMENT_INDEX`/`WEBSITE_PAGE` branches (widgetDemo.routes.js:505-512) return a static mode-switch message, never call the browser:
```js
return res.json({ success: true,
  assistantMessage: 'Switch to **Act on site** mode so I can navigate to that page or document on the ATB website.' });
```
Every real `browser_agent_queued`/`navigate_then_download`/`decideAction`/`checkCdpReachable`/`launchBrowserAgentJob` call lives in `handleBrowserTaskOrDelegate`'s ACT section (lines 252-419), structurally gated off for `mode='ask'` at line 241-250 (only a static redirect fires for explicit action verbs). **No leakage found.**

---

## 10. Reproduce the failure — candidate ranking trace

For `"quelle est l'adresse du mediateur de l'ATB?"`:

- **current_page candidate**: not applicable — `siteContext.url = atb.tn/` (homepage), no address content there; `buildSiteContextAnswer` wouldn't match any of its branches anyway (no "what page" phrasing).
- **site_index page candidate**: `/professionnels/mediateur` (site-context/atb.tn/site-index.json line 2106) **does contain the real address** in its `textPreview` tail: `"...Médiateur de l'ATB M. Meftah ziadi Adresse : 20 Rue Mohamed Triki, Ennasr 2, CP 2001 Email : ziadi.meftah@cbf.org.tn Tél : (+2..."`. But `searchSiteIndex` scores it using non-accent-folded exact tokens — query token `mediateur` (no accent) doesn't match indexed token `médiateur` (accented) → score falls below the `0.35` threshold → **rejected before it's even considered**.
- **general_resources candidate**: "SME Current Account Product Sheet" — wins by default because the query, reduced to noise tokens (`adresse`→garbage, `diateur`→garbage, `du/de/est/quelle`→unfiltered fillers), produces near-random low scores across the whole catalog, and this resource's `description` happens to have the highest incidental token overlap — **inferred**, exact catalog content unavailable.

**Why the wrong candidate wins**: the correct data exists in site-index.json, but (a) accent-folding is missing on the query-normalization path so the correct page never clears the site-index threshold, and (b) the fallback classifier (`detectSourceType`) also fails on the same accent bug plus an English-only "address" pattern, dumping the query into `GENERAL` → catalog, where a French-stopword-blind, accent-blind scorer picks an unrelated document.

---

## 11. Root cause summary

- **Missing data?** No — the address (`20 Rue Mohamed Triki, Ennasr 2, CP 2001`) exists in `site-index.json` on `/professionnels/mediateur`, but only as unstructured free text at the tail of `textPreview`; no structured `contactFacts` field exists for it.
- **Stale current-page context?** No — it's live per-request data, correctly reflecting the homepage because the user's widget was on the homepage. Not a caching bug; an architectural limitation (Ask never observes Act's browser state).
- **Source selection bug?** **Yes — primary root cause.** `detectSourceType` misclassifies to `GENERAL` because (a) accent-stripping fragments "médiateur", (b) `CONTACT_FACTS` pattern only recognizes English "address".
- **Scoring bug?** **Yes — contributing root cause.** Both `askRetrieval.service.js` and `resourceCatalog.service.js` strip accents instead of folding them; `resourceCatalog.service.js` also lacks French stopwords, letting filler tokens add noise. `siteIndex.service.js` preserves accents but doesn't fold them either, so it also fails to match unaccented query text against accented index content.
- **Answer extraction bug?** **Yes — would still fail even with correct routing.** `buildSiteIndexAnswer`'s contact branch depends on a `contactFacts` field that doesn't exist in this dataset; its generic fallback only reads the first 80 characters of page text, never reaching an address buried at the end.
- **ASK/ACT separation bug?** No — confirmed clean, no browser calls reachable from ASK mode.

**This is a three-layer failure, not one bug**: classification (wrong source type) → scoring (accent/stopword blindness, both in site-index and catalog) → extraction (no free-text field parser, naive 80-char truncation). Fixing only one layer will not fully resolve the query — e.g. fixing accent-folding alone gets `/professionnels/mediateur` selected, but `buildSiteIndexAnswer` would still fail to extract the address without an "Adresse:"/"Email:"/"Tél:" line-parser.

---

## 12. Proposed fix plan (not implemented)

**Phase 1 — logging only**
- File: `askRetrieval.service.js` (`detectSourceType`), `siteIndex.service.js` (`searchSiteIndex`). Add a debug log of top-3 scored candidates + normalized query tokens before the threshold check, gated behind existing demo-log flag. Risk: low. Why: today logs show only the winner (`Match: ...`), not near-misses — needed to verify Phase 2/3 fixes actually move the needle before shipping them.

**Phase 2 — fix source ranking (accent folding)**
- Files: `askRetrieval.service.js` (`_norm`), `resourceCatalog.service.js` (`normalizeText`), `siteIndex.service.js` (`_tokenize` / its normalize step). Replace accent-stripping with the existing `.normalize('NFD').replace(/[̀-ͯ]/g,'')` pattern already used in `siteIndexAgent.service.js:65-71` — apply it consistently to both query and indexed/catalog text before tokenizing. Risk: medium (changes token boundaries for every existing query — must re-run existing catalog/site-index test suites, e.g. `npm run task:catalog`). Why: this is the primary root cause blocking both site-index and catalog matching for any accented French query.

**Phase 3 — fix source-type patterns**
- File: `askRetrieval.service.js` (`SOURCE_TYPE_PATTERNS`, `CONTACT_FACTS` regex). Add `adresse` alongside `address`, add `mediateur`/`médiateur` (post-fold, this becomes one token) to the contact/branch pattern set. Risk: low (additive pattern change, same pipeline documented as extensible in project memory: "Extend SOURCE_TYPE_PATTERNS ... do NOT add if/else to widgetDemo.routes.js"). Why: needed regardless of Phase 2, since the current pattern is English-only by construction.

**Phase 4 — current page context**
- No code change proposed here — diagnosis found this is not a bug, it's expected behavior given Ask mode's architecture (never observes Act's browser tab). If the requirement is "answer using the page the user is actually looking at," that needs a product decision (e.g. always request a fresh live snapshot instead of a 5-minute cache) rather than a bug fix. Flagging for supervisor discussion, not code change.

**Phase 5 — focused answer extraction**
- File: `siteIndex.service.js` (`buildSiteIndexAnswer`, generic fallback branch ~line 632-655). Add a labeled-field extractor (regex for `Adresse\s*:\s*(.+?)(?:Email|Tél|$)`, similarly for `Email :`/`Tél :`) that runs before falling back to the first-80-chars truncation, so free-text contact data (like the mediator's) can be surfaced even without a structured `contactFacts` field. Risk: medium (regex must be tuned against real `textPreview` formatting across many pages — false positives possible). Why: confirmed necessary in §11 — even correct routing to `/professionnels/mediateur` fails today without this.

**Phase 6 — tests**
- Extend `scripts/catalog-ask-tests.json` (or a new `scripts/site-index-ask-tests.json`) with the four mediator queries from §13 below, using the existing `npm run task:catalog`-style runner (`scripts/run-widget-task.js --file ...`) and its `expectedContains`/`forbiddenContains`/`ask-no-browser-job` checks. Risk: low. Why: prevents regression on this exact bug class (accented French contact queries).

---

## 13. Test plan (manual)

1. From `/mediateur` context: `"quelle est l'adresse du mediateur de l'ATB?"` — expect address `20 Rue Mohamed Triki, Ennasr 2, CP 2001`, `Source: site_index`, no browser job.
2. From homepage: same query — expect identical answer (site-index search shouldn't depend on current page context for this fact).
3. `"quel est l'email du médiateur de l'ATB?"` — expect `ziadi.meftah@cbf.org.tn`.
4. `"quel est le téléphone du médiateur de l'ATB?"` — expect the `(+2...)` number from the same `textPreview` (verify full number in source data first, it's truncated in the excerpt seen).
5. A known local general-resource question (e.g. one of the 12 cases in `scripts/catalog-ask-tests.json`) — confirm Phase 2/3 changes don't regress existing catalog matches.
6. A document/form query (e.g. "formulaire d'ouverture de compte") — confirm `DOCUMENT_INDEX` classification and Act-mode redirect message still fire correctly, unaffected by accent-folding change.
7. Garbage/out-of-domain query (e.g. `"asdkjaslkdj"`) — confirm graceful `GENERAL`/not-found handling, no crash from the new field-extraction regex on empty/irrelevant text.

---

### Gaps encountered during diagnosis
- `atb-general-resources/catalog.json` lives outside the repo (`C:/laragon/www/...`) and was not accessible — exact catalog scoring arithmetic for "SME Current Account Product Sheet" is **inferred**, not directly verified.
- The pasted log's final 3 lines (`Intent:`, `Ctx:`, `Plan:`) come from middleware that runs *before* `handleAskRetrieval` in the chain, yet appear timestamped *after* the `Match:` line — this indicates the paste spans two separate `/chat` calls (a follow-up turn), not one atomic request. `Plan: route=site_index` on that second turn is documented as observational-only (does not affect actual routing) — its outcome was not confirmed since no further trace lines were provided for that turn.
