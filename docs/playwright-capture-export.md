# Playwright Capture Exporter

Secure, generic Playwright capture exporter for **any** public website or web
application, including banking sites. It renders every safe, same-origin public
page **read-only**, extracts the rendered evidence + a full-page screenshot, and
packages everything into a zip you can upload to ChatGPT so ChatGPT can manually
author the final `ask-context.json`.

> This script **does not** generate `ask-context.json`, **does not** call Ollama
> or OpenRouter, and **does not** touch act mode or the existing crawler.

## Commands

40-page test (from an existing index):

```bash
CAPTURE_MAX_PAGES=40 node scripts/export-playwright-capture.js site-context/atb.tn/site-index.json
```

Full site, no limit (from index):

```bash
CAPTURE_MAX_PAGES=0 node scripts/export-playwright-capture.js site-context/atb.tn/site-index.json
```

Direct website (crawl + discover links, no limit):

```bash
CAPTURE_MAX_PAGES=0 node scripts/export-playwright-capture.js https://example.com
```

npm alias:

```bash
npm run capture:export -- https://example.com
npm run capture:export -- site-context/atb.tn/site-index.json
```

## Input modes

| Mode | Input | URL source |
| --- | --- | --- |
| **Index inventory** | path to `site-index.json` | `pages[].url` (frozen snapshot, no re-crawl of the whole tree) |
| **Direct URL** | `https://…` | live link discovery from rendered pages, same-origin BFS |

In index mode the exporter does not discover new links — it captures exactly the
URLs already in the frozen snapshot (filtered for safety). In URL mode it
discovers same-origin links as it renders.

## Output

```
site-context/<domain>/playwright-capture/
  playwright-capture.json     # manifest (always written, unzipped)
  screenshots/                # one full-page PNG per captured URL
  capture-package.zip         # manifest + screenshots
  capture-package-part-001.zip   # only if the package is large (split)
  capture-package-part-002.zip
  ...
```

**Zip path:** `site-context/<domain>/playwright-capture/capture-package.zip`

If total screenshots exceed `CAPTURE_ZIP_SPLIT_MB` (default 90 MB), the exporter
also writes size-bounded `capture-package-part-NNN.zip` files (part-001 carries
the manifest). The unzipped `playwright-capture.json` manifest is always present.

## Environment

| Var | Default | Meaning |
| --- | --- | --- |
| `CAPTURE_MAX_PAGES` | `0` | `0` = all discovered safe pages, no artificial limit |
| `CAPTURE_HEADLESS` | `true` | headless Chromium |
| `CAPTURE_TIMEOUT_MS` | `35000` | per-page nav/screenshot timeout |
| `CAPTURE_WORKERS` | `3` | parallel page workers (soft cap — a few extra pages may finish in-flight) |
| `CAPTURE_VIEWPORT_WIDTH` | `1440` | viewport width |
| `CAPTURE_VIEWPORT_HEIGHT` | `1000` | viewport height |
| `CAPTURE_SAME_ORIGIN_ONLY` | `true` | stay on the target origin |
| `CAPTURE_FORCE` | `false` | re-capture URLs already in the manifest (disable resume) |
| `CAPTURE_ZIP_SPLIT_MB` | `90` | split the package above this size |

## Resume

Re-running against the same output picks up where it left off: URLs already in
`playwright-capture.json` are skipped. Set `CAPTURE_FORCE=true` to re-capture
everything from scratch.

## Security rules (banking / public applications)

Read-only by construction — the script never interacts with the page:

- Never submits forms, types into inputs, clicks buttons, or authenticates.
- Never uses a saved browser profile; a **fresh isolated browser context per
  page** (no shared cookies / localStorage / sessionStorage).
- No cookies or storage state are written into the package.
- Does not capture pages behind login — if a navigation redirects onto a risky
  path, the page is skipped.
- Skips risky/private paths: `login, logout, signin, signup, admin, account,
  dashboard, payment, paiement, transfer, virement, checkout, password, otp,
  auth, delete, supprimer, confirm, send` (and locale variants).
- Skips URLs whose query params look like tokens/secrets
  (`token, secret, password, otp, auth, session, jwt, access, apikey, signature,
  sig, code, nonce, hash`, …); such params are also stripped during
  normalization.
- Redacts obvious secrets (JWTs, long hex, `bearer/token/…=value`) from rendered
  text, links, and error messages → `[REDACTED]`.
- Does not download files; document links are **recorded only**
  (`documents[]`), never fetched.
- Skips asset URLs as pages (`pdf, doc(x), xls(x), ppt(x), csv, zip, rar, png,
  jpg, jpeg, svg, css, js, mp4, mp3, woff, woff2`, …).
- Stays same-origin unless `CAPTURE_SAME_ORIGIN_ONLY=false`.

URLs are normalized (hash removed, duplicate trailing slashes collapsed,
tracking/secret params stripped) and deduplicated via a seen-set, so loops and
infinite parameter permutations cannot cause an infinite crawl even with
`CAPTURE_MAX_PAGES=0`.

## Per-page capture shape

```json
{
  "url": "", "title": "", "language": "", "metaDescription": "",
  "screenshot": "screenshots/<name>.png",
  "renderedText": "full document.body.innerText, secrets redacted",
  "headings": [ { "level": "h1", "text": "" } ],
  "sections": [ { "role": "header|nav|main|section|article|footer|other", "heading": "", "text": "" } ],
  "links": [ { "text": "", "href": "" } ],
  "buttons": [ { "text": "" } ],
  "forms": [ { "action": "", "method": "", "fields": [ { "name": "", "type": "", "placeholder": "", "label": "" } ] } ],
  "documents": [ { "text": "", "url": "", "filename": "", "fileType": "" } ],
  "warnings": []
}
```

Rendered text comes from `document.body.innerText`; French, Arabic, and English
are preserved exactly. One full-page screenshot per captured URL.

## Uploading to ChatGPT for ask-context.json generation

1. Run the exporter (full site or a test slice).
2. Find the package at
   `site-context/<domain>/playwright-capture/capture-package.zip`
   (or the `capture-package-part-NNN.zip` files if it was split).
3. In ChatGPT, start a chat and **attach** the zip(s). If split, upload the
   parts (part-001 contains `playwright-capture.json`).
4. Ask ChatGPT to read `playwright-capture.json` (and the screenshots for visual
   confirmation) and generate `ask-context.json`, instructing it to use only the
   captured evidence and copy exact text as evidence — do not invent.
5. Save ChatGPT's output as `site-context/<domain>/ask-context.json`.

The screenshots let ChatGPT visually verify layout/labels; the manifest carries
the structured text, headings, links, forms, and document references.
