# Rich site context for ASK mode

`scripts/build-site-context.js` is an independent, generic crawler for producing clean page-level evidence. It does not replace or modify `site-index.json`, and the current ASK/ACT runtime does not load it yet.

Run it from the repository root:

```powershell
node scripts/build-site-context.js --url https://atb.tn --out site-context/atb.tn/context.json
```

Useful limits:

```powershell
node scripts/build-site-context.js --url https://example.com --out site-context/example.com/context.json --max-pages 200 --max-depth 5 --concurrency 3 --timeout 30000 --ollama auto
```

The crawler stays on the target domain, never clicks controls, and skips authentication, administration, payment, transfer, deletion, logout, and asset paths. It removes structural chrome, selects a content-dense main block, splits it into sections, removes lines repeated across pages, and stores full clean content rather than the first 1,500 body characters.

If local Ollama is available, cleaned content can be converted into strict `pagePurpose`, `keyFacts`, `keywords`, and `pageType` JSON. When it is unavailable, deterministic extraction uses headings, sections, contact details, hours, forms, documents, and factual sentences.

Validate the result with:

```powershell
node scripts/validate-site-context.js site-context/atb.tn/context.json
```

The output differs from `site-index.json`: the existing index is optimized for navigation and document actions, while `context.json` is a rich evidence artifact intended for future ASK retrieval. The future integration boundary is deliberately read-only:

```js
const { loadSiteContext, searchSiteContext } = require('./scripts/lib/site-context');
const context = loadSiteContext('atb.tn');
const matches = searchSiteContext('opening hours', context);
```

TODO: integrate these helpers into ASK mode only after the generated artifact and retrieval thresholds are approved. Do not use this context for ACT navigation or URL execution.
