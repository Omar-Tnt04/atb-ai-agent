# ATB AI Banking Agent

Local MVP / Proof of Concept for a secure AI banking assistant for ATB.

## Main Stack

- React Web App
- React Native Expo Mobile App
- Node.js / Express Backend
- Python / FastAPI AI Service
- Ollama Open-Source LLM
- Supabase PostgreSQL
- Internal Demo Services (separate local Express apps)
- Risk-Based SMS Verification
- Admin Dashboard
- Audit Logging

## Main Objective

Build an authenticated AI banking agent that understands banking requests, selects available actions, checks permissions, asks for confirmation, applies SMS verification for high-risk actions, routes execution through internal service connectors, and returns clear results inside the chat.

## Internal Services Demo

The MVP uses separate local Express services to simulate ATB internal applications. The AI agent does not execute actions directly. It detects intent, then the backend orchestrator calls the appropriate internal service through a connector. In production, these local service URLs are replaced by real ATB internal APIs.

### Architecture

```text
User -> React Chat/Widget -> Node Chat Route -> Python AI Decision Stage -> Node Secure Resource/Action Layer -> Python AI Final Response -> Result -> Admin Dashboard
```

Checkpoint 2 follows the supervisor-requested Ollama-first flow conceptually:

- AI decides whether the request is `answer_directly`, `search_resource`, `prepare_action`, or `ask_clarification`.
- Backend validates and executes resource lookups/actions. Laragon JSON/PDF URLs, internal services, confirmations, SMS verification, and audit logs stay backend-controlled.
- Frontend displays the final Markdown answer, quick actions, Download PDF, Confirm, and Cancel controls.

### Checkpoint 3 hybrid routing

The main flow uses a hybrid, resource-first architecture. The backend searches
and resolves resources before any model call, so normal JSON, TXT, PDF-text,
and resource questions are handled with `qwen2.5:7b`. `qwen3-vl:8b` is reserved
for images, scanned PDFs, and explicit visual reasoning.

Backend RAM does not cache raw PDFs, images, base64 payloads, full prompts, or
full model responses. The vision-summary cache is disabled by default; if a
production cache is added later, it should store only small extracted JSON
outside app memory, never raw files.

The benchmark script compares `qwen2.5:7b` and `qwen3-vl:8b` and exports both
CSV and JSON results.

### Internal services

| Service              | Port | Purpose                          |
| -------------------- | ---- | -------------------------------- |
| payment-service      | 7101 | Bill payments and transfers      |
| document-service     | 7102 | Document generation and download |
| atb-service          | 7106 | Customers, cards, branches, products, and complaints |
| appointment-service  | 7104 | Branch appointment slots/booking |
| account-service      | 7105 | Account balance lookups          |

Each service exposes `GET /health`. The backend connectors call these services
over HTTP. If a service is disabled, offline, or unreachable, the action is not
executed against a mock fallback — the agent returns a clean
`The internal service is currently unavailable.` message and the failed attempt
is audited.

## Run the full MVP locally

Make sure Ollama is installed and running.

Make sure the `qwen2.5:7b` model exists locally:

```bash
ollama list
```

Recommended:

```bash
npm run dev
```

This runs all services in one terminal with clean output.

Full logs for debugging:

```bash
npm run dev:verbose
```

Separate terminals:

```bash
npm run dev:separate
```

This opens separate terminals.

`npm run dev` starts all processes with readable prefixes:
`[api]`, `[ai]`, `[web]`, `[pay]`, `[doc]`, `[atb]`, `[apt]`, `[acc]`.

Run individual services:

```bash
npm run dev:backend
npm run dev:ai
npm run dev:web
npm run dev:pay
npm run dev:doc
npm run dev:atb
npm run dev:apt
npm run dev:acc
```

Open the web app at:

```text
http://localhost:5173
```

Demo access:

```text
USER:  user@atb.com / user123
ADMIN: admin@atb.com / admin123
```

USER accounts open the Chat experience. ADMIN accounts open the Admin Dashboard.

## Chat file uploads

The chat supports local MVP uploads for banking PDFs and images, plus simple
TXT, CSV, and JSON files. PDF text extraction, scanned/image PDF handling,
image OCR, and text/CSV/JSON understanding are handled by the backend file
context service.

## Laragon demo resources

For the current local demo, Laragon resources live in:

```text
C:\laragon\www\atb-general-resources
```

The active local resource base URL is:

```text
http://localhost/atb-general-resources
```

The backend reads the catalog from
`http://localhost/atb-general-resources/json/catalog.json` and resolves PDFs
under `http://localhost/atb-general-resources/documents/`.

The chat route does not search this catalog until the AI decision stage returns
`search_resource`. After that decision, the backend searches the catalog,
validates the selected resource URL against the configured resource base URL,
extracts trusted PDF text when available, and sends the resolved context back
to the AI service for the final answer.

## Connector layer

The backend has a stable connector layer that is the boundary between actions
and the services that perform them. In this MVP the normal action path routes
through internal connectors that call the internal demo services over HTTP. In
production, the connectors point at real ATB internal APIs without changing the
action registry.

Service URLs and any credentials belong only in the backend `.env`; the frontend
and AI service do not receive or call those services directly. The AI only
selects an allowed action. The backend performs permission checks,
confirmation/SMS flow, connector execution, and audit logging.

Use `GET /integrations/connectors` to list available connector operations and
`GET /integrations/internal/status` to see each internal service as
`Connected`, `Offline`, or `Disabled`.
