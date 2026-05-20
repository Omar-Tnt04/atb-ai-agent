# ATB AI Banking Agent

Local MVP / Proof of Concept for a secure AI banking assistant for ATB.

## Main Stack

- React Web App
- React Native Expo Mobile App
- Node.js / Express Backend
- Python / FastAPI AI Service
- Ollama Open-Source LLM
- Supabase PostgreSQL
- Mock REST APIs
- Risk-Based SMS Verification
- Admin Dashboard
- Audit Logging

## Main Objective

Build an authenticated AI banking agent that understands banking requests, selects available actions, checks permissions, asks for confirmation, applies SMS verification for high-risk actions, executes mock API calls, and returns clear results inside the chat.

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

Run individual services:

```bash
npm run dev:backend
npm run dev:ai
npm run dev:web
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

The chat supports local MVP uploads for documents and images. Text extraction
works for common document formats such as TXT, CSV, PDF, and DOCX. Image
uploads are stored as attachment metadata for now, with OCR or multimodal AI
understanding ready to be connected later.

## External connected services

The backend has a connector layer for future ATB integrations. Actions can call
hybrid connectors that try an external service first, then safely fall back to
the current mock or sandbox connector when the external service is disabled,
missing, timed out, or unavailable.

External API keys and service URLs belong only in the backend `.env`; the
frontend and AI service do not receive or call those APIs directly. The AI only
selects an allowed action. The backend performs permission checks,
confirmation/SMS flow, connector execution, and audit logging.

Use `GET /integrations/connectors` to list available connector operations and
`GET /integrations/external/status` to see safe enabled/configured status for
external services without exposing secrets.
