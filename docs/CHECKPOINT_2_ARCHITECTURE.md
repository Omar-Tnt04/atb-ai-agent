# ATB AI Banking Agent — Checkpoint 2 Architecture

## 1. Overview

After Checkpoint 2, the ATB AI Banking Agent is no longer only a chatbot. It is a service-based AI banking agent that connects a conversational interface, a local AI reasoning layer, a secure Node.js orchestration backend, Laragon-hosted resource files, internal service APIs, and dashboard/audit visibility.

The agent can:

- understand natural banking requests
- keep short-term action context between chat turns
- search Laragon-hosted JSON resources when the user asks naturally
- resolve linked PDF files from trusted local resource URLs
- extract text from PDFs and send that context to the AI layer
- call internal banking service APIs through backend connectors
- return clean Markdown responses instead of raw technical output
- log banking operations so the dashboard can show service and action activity

Checkpoint 2 proves the separation between reasoning and execution:

- Ollama helps classify requests, extract fields, and format user-facing answers.
- The backend validates safety, resolves trusted resources, prepares actions, executes actions, and logs results.
- Internal services simulate service-owned banking systems.
- Laragon serves local JSON/PDF banking resources for document-like context.

## 2. Final Architecture Flow

The supervisor-level conceptual flow is:

```text
User
  -> React Frontend
  -> AI/Ollama layer
  -> Node.js Backend Orchestrator
  -> Laragon resource layer when JSON/PDF context is needed
  -> Internal demo services when banking actions are needed
  -> Backend returns result/context
  -> Ollama/AI formats answer
  -> Frontend displays answer
  -> Dashboard logs operation
```

In the actual HTTP implementation, the React frontend sends requests to the Node.js backend first. The backend then calls the AI service, resolves Laragon resources, and calls internal services as needed. This keeps authentication, URL safety, action confirmation, SMS verification, and audit logging under backend control.

ASCII architecture diagram:

```text
+----------------+
|      User      |
+-------+--------+
        |
        v
+-----------------------------+
| React Frontend              |
| ChatPage + ChatMessage      |
| Markdown + quick actions    |
+--------------+--------------+
               |
               v
+-----------------------------+
| Node.js Backend Orchestrator|
| auth, chat routes, actions  |
| resource lookup, audit logs |
+------+--------------+-------+
       |              |
       |              |
       v              v
+-------------+   +-------------------------+
| AI Service  |   | Laragon Resource Layer  |
| Ollama      |   | /atb-resources/json     |
| qwen2.5:7b  |   | /atb-resources/documents|
+------+------+   +------------+------------+
       |                       |
       | resolved context      | JSON + linked PDF
       v                       v
+-----------------------------+
| Backend action orchestrator |
| prepare, confirm, SMS, exec |
+------+-------+------+-------+
       |       |      |
       v       v      v
+---------+ +---------+ +---------+
| Payment | | Account | |  ATB    |
| 7101    | | 7105    | | 7106    |
+---------+ +---------+ +---------+
       |
       v
+-----------------------------+
| Dashboard / Audit Logs      |
+-----------------------------+
```

There are two important response paths:

1. Resource and informational path: backend resolves a Laragon resource, sends `resolvedResourceContext` to the AI service, and the AI service formats a clean Markdown answer.
2. Banking execution path: AI detects the action and extracted fields, but the backend enforces action safety, confirmation, SMS, connector calls, and audit logs. Backend-generated execution results are returned as clean chat responses.

## 3. Frontend Layer

Main frontend files:

| File | Role |
|---|---|
| `web-client/src/pages/ChatPage.jsx` | Main chat screen, message sending, pending actions, quick actions, SMS UI, auto-scroll |
| `web-client/src/components/chat/ChatMessage.jsx` | Renders assistant/user messages and quick action controls |
| `web-client/src/api/chatApi.js` | Sends chat, file, action, confirmation, and SMS requests to the backend |

The frontend is responsible for the user experience, not banking execution. It sends the message and context to the backend and displays the structured response returned by the backend.

### User Message Sending

`ChatPage.jsx` sends normal text messages to:

```text
POST /chat/message
```

Messages with uploaded files go to:

```text
POST /chat/message-with-files
```

The request can include:

- current user message
- conversation history
- profile context
- accumulated agent context
- file attachments for upload flows

The frontend keeps only safe conversational context. Hidden resource metadata such as `_resourceUrl` is stripped before reuse so resource quick actions do not leak into unrelated future turns.

### ChatGPT-Style Rendering

Assistant messages are rendered as Markdown through the chat components. This supports:

- headings
- paragraphs
- bold values
- compact tables
- short bullet lists

The frontend does not display raw backend fields such as `resourceJsonUrl`, raw `fileUrl`, internal paths, extraction status, or raw PDF text in the main chat answer.

### Inline Quick Actions

Quick actions are small inline controls attached to the current assistant response. They are generated fresh per response.

Examples:

| Button | When it appears |
|---|---|
| `Download PDF` | Only when the current resolved resource is document-oriented and has a useful file URL |
| `Confirm` | When a prepared action needs user confirmation |
| `Cancel` | When a prepared action can be cancelled |

The `Download PDF` button opens the current resolved resource's PDF. It is not reused across unrelated messages.

### Download PDF Behavior

`Download PDF` appears only when useful for the current response. Examples:

- `Can you get my RIB certificate?`
- `Summarize my April current account statement.`
- `Show my account ownership certificate.`

It does not appear for direct factual questions:

- `What was my closing balance in April?`
- `When is my next loan payment due?`
- `How much will I pay in bank fees for June?`
- `Do I have a confirmed branch appointment?`

### Confirm / Cancel Behavior

For actions that require confirmation, the frontend shows inline `Confirm` and `Cancel` buttons. The backend still owns the actual confirmation state and validates the action before execution.

Typical examples:

- `pay_bill`
- `make_transfer`
- `create_complaint`
- `book_appointment`
- `generate_document`

### SMS Input Behavior

High-risk actions require SMS verification after confirmation. The frontend shows an SMS code input only when the backend returns an SMS-required state.

Examples of high-risk actions:

- bill payment
- money transfer

The frontend sends the SMS code back to the backend. The backend verifies the code and executes the action only if verification succeeds.

### Raw URL Hiding

The UI does not print technical URLs by default. For Laragon resources, the user sees a clean answer and possibly a `Download PDF` button. The raw JSON URL, raw PDF URL, extracted PDF text, backend path, and extraction status are kept out of the visible assistant answer unless a future explicit technical/debug mode is added.

## 4. AI / Ollama Layer

Main AI files:

| File | Role |
|---|---|
| `ai-service-python/app/services/intent_service.py` | Rule-based and Ollama-backed intent handling, resource answer formatting, field extraction orchestration |
| `ai-service-python/app/prompts/banking_intent_prompt.py` | Prompt builder for structured AI analysis |
| `ai-service-python/app/schemas/agent.py` | Pydantic schemas for AI request/response payloads |

Current model configuration:

```text
OLLAMA_MODEL=qwen2.5:7b
```

The AI service receives:

- user message
- available backend actions
- conversation history
- uploaded file context
- resolved Laragon resource context
- profile context
- agent context

The AI service can:

- detect the user's intent
- extract structured fields from text
- answer from `resolvedResourceContext`
- summarize extracted PDF text
- format resource answers as clean Markdown
- distinguish direct factual questions from document-oriented requests
- decide whether a `Download PDF` quick action is useful

The AI service does not execute banking actions directly. It returns structured data such as:

```json
{
  "agentMode": "banking_action",
  "intent": "pay_bill",
  "actionName": "pay_bill",
  "missingFields": [],
  "extractedFields": {
    "provider": "SONEDE",
    "billReference": "SONEDE-2026-003",
    "amount": 42.5,
    "sourceAccountId": "acc_001"
  }
}
```

The backend decides whether the action can be prepared, confirmed, verified by SMS, and executed.

### Resolved Resource Context

When the backend resolves a Laragon resource, it sends the AI service a `resolvedResourceContext` object containing:

- `resourceJson`
- `fileUrl`
- `fileTextPreview`
- full `fileText`
- `contentType`
- `extractionStatus`

The AI service uses this context to answer from the actual JSON/PDF content instead of only reacting to the user wording.

### Direct Factual Questions

For direct factual questions, the AI returns only the answer. Example:

```text
User: What was my closing balance in April?

Assistant: Your closing balance for April 2026 was **2450.750 TND**.
```

No `Download PDF` button is shown because the user asked for a value, not the document.

### Document-Oriented Requests

For document-oriented requests, the AI can include `Download PDF` when a current resolved resource has a file URL.

Examples:

```text
User: Can you get my RIB certificate?
User: Show my account ownership certificate.
User: Summarize my April current account statement.
```

### Vision and Scanned Documents

The current model handles text-based resources and extracted PDF text. Scanned PDFs, image-only PDFs, and direct vision understanding are future work. A future checkpoint can add a vision-capable model such as `qwen2.5vl` or another OCR/vision pipeline.

## 5. Backend Orchestrator

Main backend orchestration files:

| File | Role |
|---|---|
| `backend-node/src/controllers/chat.controller.js` | Main chat orchestration, resource lookup, AI calls, action dispatch |
| `backend-node/src/services/aiClient.service.js` | HTTP client from backend to Python AI service |
| `backend-node/src/services/actionPreparation.service.js` | Validates action payloads and builds prepared action summaries |
| `backend-node/src/services/actionExecution.service.js` | Executes actions, handles confirmation/SMS rules, writes audit logs |
| `backend-node/src/actions/actionRegistry.js` | Defines available actions, required fields, risk levels, connectors, and operations |

The backend orchestrator receives authenticated chat requests and coordinates all non-UI work.

### Backend Responsibilities

The backend:

- validates authentication through Express middleware
- receives text and file chat requests
- detects direct Laragon JSON URLs in user messages
- performs natural resource lookup when no URL is pasted
- resolves trusted Laragon JSON/PDF resources
- sends `resolvedResourceContext` to the AI service
- receives structured AI output
- prepares banking actions
- validates required fields
- applies confirmation and SMS rules based on action risk
- calls the correct connector
- logs action preparation/execution results

### Resource Detection

Direct resource URL example:

```text
http://localhost/atb-resources/json/01_current_account_statement_april_2026.json
```

Natural resource lookup example:

```text
Summarize my April current account statement.
```

The backend first tries to find a trusted direct URL in the current message. If there is no pasted URL, it searches the Laragon resource catalog.

### Action Preparation

The AI service can say that a message maps to an action such as:

- `check_balance`
- `pay_bill`
- `make_transfer`
- `create_complaint`
- `book_appointment`
- `generate_document`

The backend then validates the required fields using `actionPreparation.service.js`. Missing fields are returned as natural assistant questions.

### Action Execution

`actionExecution.service.js` enforces the safety rules:

- low-risk read-only actions execute directly
- medium-risk actions require confirmation
- high-risk actions require confirmation and SMS verification

The AI never bypasses this layer.

## 6. Laragon / WAMP-style Resource Layer

Laragon is used as the local static resource server for Checkpoint 2. It replaces the earlier WAMP-style idea for local development.

Local resource root:

```text
C:\laragon\www\atb-resources\
```

Served URLs:

```text
http://localhost/atb-resources/json/
http://localhost/atb-resources/documents/
```

Expected folder structure:

```text
atb-resources/
|-- json/
|   |-- 01_current_account_statement_april_2026.json
|   |-- 03_rib_certificate_acc_001.json
|   `-- ...
`-- documents/
    |-- current_account_statement_april_2026.pdf
    |-- rib_certificate_acc_001.pdf
    `-- ...
```

The JSON files represent service-owned banking resources. Each JSON file can include metadata and a `fileUrl` field pointing to a PDF under the trusted documents folder.

Example JSON concept:

```json
{
  "resourceType": "account_statement",
  "accountId": "acc_001",
  "period": "April 2026",
  "openingBalance": 970,
  "closingBalance": 2450.75,
  "currency": "TND",
  "fileUrl": "http://localhost/atb-resources/documents/current_account_statement_april_2026.pdf"
}
```

The backend treats these URLs as trusted only if they start with:

```text
http://localhost/atb-resources/
```

External arbitrary URLs are rejected.

## 7. Resource Catalog and Resolver

Resource layer files:

| File | Role |
|---|---|
| `backend-node/src/services/resourceCatalog.service.js` | Loads Laragon JSON resources and matches natural language requests to resources |
| `backend-node/src/services/resourceResolver.service.js` | Validates trusted URLs, fetches JSON, fetches linked PDF, extracts text |
| `backend-node/src/controllers/resource.controller.js` | Test controller for resource resolution |
| `backend-node/src/routes/resource.routes.js` | Exposes the test route |

Test route:

```text
GET /resources/resolve?url=<encoded-url>
```

### Resource Catalog

`resourceCatalog.service.js` loads JSON resource metadata from:

```text
http://localhost/atb-resources/json/
```

If directory listing is unavailable, it can fall back to:

```text
http://localhost/atb-resources/json/catalog.json
```

It scores resources using:

- resource type
- file name
- title
- period
- account ID
- holder/customer name
- branch/status/reference fields
- provider/bill keywords for bill resources

Natural query example:

```text
Summarize my April current account statement.
```

Flow:

```text
message
  -> resourceCatalog.service.js
  -> matches 01_current_account_statement_april_2026.json
  -> resourceResolver.service.js
  -> fetch JSON
  -> fetch linked PDF
  -> extract text
  -> send resolvedResourceContext to AI
```

### Resource Resolver

`resourceResolver.service.js`:

1. Accepts a JSON resource URL.
2. Validates that it starts with the trusted Laragon resource base.
3. Fetches the JSON.
4. Reads `fileUrl` if present.
5. Validates the linked file URL.
6. Fetches the linked file.
7. If the file is a PDF, extracts text using `pdf-parse`.
8. Returns a structured object.

Returned fields:

```json
{
  "resourceJson": {},
  "fileUrl": "http://localhost/atb-resources/documents/example.pdf",
  "fileText": "full extracted PDF text",
  "fileTextPreview": "short preview",
  "contentType": "application/pdf",
  "extractionStatus": "extracted"
}
```

### Example: Account Statement

```text
User: Summarize my April current account statement.
```

Expected flow:

```text
Natural message
  -> catalog match
  -> 01_current_account_statement_april_2026.json
  -> linked PDF resolved
  -> PDF text extracted
  -> AI receives resourceJson + fileText
  -> assistant returns Markdown summary + transaction table
```

Expected response type:

```text
Account statement summary table
Transaction table
Download PDF button
```

### Example: RIB Certificate

```text
User: Can you get my RIB certificate?
```

Expected flow:

```text
Natural message
  -> catalog match
  -> RIB certificate JSON
  -> linked PDF resolved
  -> AI formats clean table
```

Expected response type:

```text
Clean RIB table
Download PDF button
No raw URL
```

## 8. Internal Services

Checkpoint 2 uses five supervisor-required internal demo services.

| Service | Port | Purpose |
|---|---:|---|
| Payment Service | 7101 | Bill payments and transfers |
| Document Service | 7102 | Generated banking documents |
| ATB Service | 7106 | ATB customer/service data and complaints |
| Appointment Service | 7104 | Appointment slots and bookings |
| Account Service | 7105 | Account balance lookup |

Start banner:

```text
Payment:     http://localhost:7101/health
Document:    http://localhost:7102/health
ATB:         http://localhost:7106/health
Appointment: http://localhost:7104/health
Account:     http://localhost:7105/health
```

### Payment Service

Location:

```text
internal-services-demo/payment-service/server.js
```

Endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/payments/pay-bill` | Execute a bill payment |
| `POST` | `/transfers/create` | Execute a transfer |

### Document Service

Location:

```text
internal-services-demo/document-service/server.js
```

Endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/documents/generate` | Generate a banking document |
| `GET` | `/documents/:documentId/download` | Download a generated document |

### ATB Service

Location:

```text
internal-services-demo/atb-service/server.js
```

Endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/customers/:userId` | Read customer profile-like data |
| `GET` | `/branches` | List branches |
| `GET` | `/products` | List banking products |
| `GET` | `/cards/:userId` | Read customer card information |
| `POST` | `/complaints` | Create a complaint |
| `GET` | `/complaints/:reference` | Check complaint status |

Complaints are handled under ATB Service in Checkpoint 2.

### Appointment Service

Location:

```text
internal-services-demo/appointment-service/server.js
```

Endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/appointments/slots` | List available appointment slots |
| `POST` | `/appointments/book` | Book an appointment |

### Account Service

Location:

```text
internal-services-demo/account-service/server.js
```

Endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/accounts/:accountId/balance` | Read an account balance |

## 9. Connector Layer

Connector files:

| File | Role |
|---|---|
| `backend-node/src/connectors/internal/internalPayment.connector.js` | Routes payment and transfer actions to Payment Service |
| `backend-node/src/connectors/internal/internalDocument.connector.js` | Routes document generation to Document Service |
| `backend-node/src/connectors/internal/internalAtb.connector.js` | Routes customer/card/complaint operations to ATB Service |
| `backend-node/src/connectors/internal/internalAppointment.connector.js` | Routes appointment actions to Appointment Service |
| `backend-node/src/connectors/internal/internalAccount.connector.js` | Routes balance lookups to Account Service |
| `backend-node/src/connectors/internal/internalService.client.js` | Shared HTTP client for internal services |
| `backend-node/src/connectors/internal/internalService.config.js` | Service names, base URLs, ports, enable flags |
| `backend-node/src/connectors/connectorRegistry.js` | Selects connector implementations by connector name |

The connector layer translates backend actions into internal HTTP API calls.

### Connector Configuration

`internalService.config.js` defines the service defaults:

```js
const SERVICE_DEFAULTS = {
  payment: { port: 7101 },
  document: { port: 7102 },
  atb: { port: 7106 },
  appointment: { port: 7104 },
  account: { port: 7105 },
};
```

Environment variables can override base URLs and enable/disable services.

### Shared HTTP Client

`internalService.client.js` performs the HTTP request and normalizes errors:

- disabled service
- service unavailable
- service error
- not found
- successful response

### Action Registry Mapping

`actionRegistry.js` maps action names to connectors and operations.

Example: bill payment

```text
pay_bill
  -> actionRegistry
  -> internalPaymentConnector
  -> internalService.client
  -> POST http://localhost:7101/payments/pay-bill
```

Example: complaint creation

```text
create_complaint
  -> actionRegistry
  -> internalAtbConnector
  -> internalService.client
  -> POST http://localhost:7106/complaints
```

Example: balance lookup

```text
check_balance
  -> actionRegistry
  -> internalAccountConnector
  -> internalService.client
  -> GET http://localhost:7105/accounts/acc_002/balance
```

## 10. Action Safety Flow

The backend enforces action safety. The AI only interprets the request.

| Risk type | Example action | Safety behavior |
|---|---|---|
| Read-only / low risk | `check_balance` | Execute directly when required fields are present |
| Medium risk | `create_complaint`, `book_appointment`, `generate_document` | Require confirmation |
| High risk | `pay_bill`, `make_transfer` | Require confirmation and SMS verification |

### Read-Only Example: Balance

```text
User: Check my account balance for acc_002.

Backend:
  -> AI extracts check_balance + accountId acc_002
  -> backend validates accountId
  -> action is low risk
  -> backend calls Account Service directly
  -> audit log is written

Assistant:
  Your balance is **8700.000 TND**.
  Account: ********1098
  Status: Active
```

No confirmation and no SMS are required.

### High-Risk Example: Pay Bill

```text
User: Pay my SONEDE bill from acc_001.

Backend:
  -> search Laragon catalog for a matching bill resource
  -> if found, resolve JSON/PDF and merge bill fields
  -> if not found, ask for bill reference and amount
  -> prepare pay_bill action
  -> return Confirm / Cancel
  -> after confirmation, require SMS
  -> after SMS verification, call Payment Service
  -> write audit log
```

Execution target:

```text
POST http://localhost:7101/payments/pay-bill
```

### Complaint Example

```text
User: Create a complaint because my transfer failed yesterday.

AI:
  -> intent create_complaint
  -> category Failed transfer
  -> description My transfer failed yesterday

Backend:
  -> prepares complaint
  -> requires confirmation
  -> calls ATB Service after confirmation
```

Execution target:

```text
POST http://localhost:7106/complaints
```

## 11. Response Formatting Rules

Checkpoint 2 uses clean Markdown responses.

Rules:

- assistant replies should be natural and short enough to read
- tables are used when they improve clarity
- raw URLs are hidden from the main answer
- raw JSON resource URLs are hidden
- raw PDF text is hidden
- extraction status is hidden
- backend file paths are hidden
- `Show details` is not shown
- `Generate document` is not shown for stored Laragon resources
- direct factual questions do not show `Download PDF`
- `Download PDF` appears only when document-oriented wording makes it useful

### Example: Direct Factual Question

```text
User: What was my closing balance in April?

Assistant:
Your closing balance for April 2026 was **2450.750 TND**.

Buttons:
none
```

### Example: Statement Summary

```text
User: Summarize my April current account statement.

Assistant:
## Account Statement Summary

This is your current account statement for April 2026.

| Field | Value |
|---|---|
| Account | acc_001 |
| Period | April 2026 |
| Opening balance | 970.000 TND |
| Closing balance | 2450.750 TND |
| Net change | +1480.750 TND |

Buttons:
Download PDF
```

### Example: RIB Certificate

```text
User: Can you get my RIB certificate?

Assistant:
I found your RIB certificate.

| Field | Value |
|---|---|
| Holder | Omar Tentouch |
| Account | acc_001 |
| RIB | TN59 1000 0100 0001 2345 6789 |
| Branch | Tunis Centre |
| Currency | TND |

Buttons:
Download PDF
```

### Example: Fees Question

```text
User: How much will I pay in bank fees for June?

Assistant:
For June 2026, your total bank fees are **... TND**.

Buttons:
none
```

## 12. Dashboard and Audit Logs

The dashboard gives operational visibility into the Checkpoint 2 architecture.

Dashboard responsibilities:

- show internal service status
- list the five supervisor-required services
- show audit log entries for banking operations
- show action name, service, status, reference, and timestamp when available

Service cards should show:

| Service | Health URL |
|---|---|
| Payment | `http://localhost:7101/health` |
| Document | `http://localhost:7102/health` |
| ATB | `http://localhost:7106/health` |
| Appointment | `http://localhost:7104/health` |
| Account | `http://localhost:7105/health` |

Laragon resource lookups are context operations. They enrich the AI answer but do not by themselves execute a banking operation.

Internal service API actions are banking operations. They are logged through the backend action execution path.

Examples of logged operations:

- `check_balance`
- `pay_bill`
- `make_transfer`
- `create_complaint`
- `book_appointment`
- `generate_document`

## 13. End-to-End Demo Scenarios

### 1. Summarize April Current Account Statement

User prompt:

```text
Summarize my April current account statement.
```

Expected flow:

```text
Frontend
  -> backend chat
  -> resource catalog
  -> account statement JSON
  -> linked PDF extraction
  -> AI resource formatter
  -> Markdown statement summary
```

Expected response type:

```text
Statement summary table
Transaction table
Download PDF
```

### 2. Ask Closing Balance

User prompt:

```text
What was my closing balance in April?
```

Expected flow:

```text
Backend finds April statement resource
  -> resolver extracts PDF text
  -> AI answers direct factual question
```

Expected response type:

```text
Direct answer: closing balance 2450.750 TND
No Download PDF
```

### 3. Get RIB Certificate

User prompt:

```text
Can you get my RIB certificate?
```

Expected flow:

```text
Resource catalog
  -> RIB certificate JSON
  -> linked PDF
  -> AI formats RIB table
```

Expected response type:

```text
Clean RIB table
Download PDF
```

### 4. Ask Loan Due Date

User prompt:

```text
When is my next loan payment due?
```

Expected flow:

```text
Resource catalog
  -> loan schedule JSON/PDF
  -> AI answers due date from resource
```

Expected response type:

```text
Direct due date answer
No Download PDF
```

### 5. Ask Card Dispute Status

User prompt:

```text
What is the status of my card dispute?
```

Expected flow:

```text
Resource catalog
  -> card dispute resource
  -> AI answers status
```

Expected response type:

```text
Direct dispute status answer
No Download PDF
```

### 6. Show Account Ownership Certificate

User prompt:

```text
Show my account ownership certificate.
```

Expected flow:

```text
Resource catalog
  -> account certificate JSON/PDF
  -> AI formats certificate table
```

Expected response type:

```text
Certificate table
Download PDF
No Generate document button
```

### 7. Ask June Fees

User prompt:

```text
How much will I pay in bank fees for June?
```

Expected flow:

```text
Resource catalog
  -> fees notice JSON/PDF
  -> AI answers fee amount/table
```

Expected response type:

```text
Fee answer/table
No Download PDF
```

### 8. Prepare Transfer Order for Hiba

User prompt:

```text
Prepare the transfer order for Hiba.
```

Expected flow:

```text
Resource catalog
  -> transfer order resource
  -> AI extracts transfer details
  -> backend prepares make_transfer if required fields are available
  -> confirmation flow
  -> SMS flow for high-risk transfer
  -> Payment Service transfer endpoint
```

Expected response type:

```text
Prepared transfer summary
Confirm / Cancel
SMS required after confirmation
```

### 9. Create Complaint for Failed Transfer

User prompt:

```text
Create a complaint because my transfer failed yesterday.
```

Expected flow:

```text
AI detects create_complaint
  -> extracts category Failed transfer
  -> extracts description
  -> backend prepares complaint
  -> confirmation
  -> ATB Service complaints endpoint
```

Expected response type:

```text
Prepared complaint table
Confirm / Cancel
No Download PDF
```

### 10. Check Balance for acc_002

User prompt:

```text
Check my account balance for acc_002.
```

Expected flow:

```text
AI detects check_balance
  -> extracts accountId acc_002
  -> backend validates low-risk read-only action
  -> Account Service balance endpoint
```

Expected response type:

```text
Your balance is **8700.000 TND**.
Account: ********1098
Status: Active
No Confirm / Cancel
No SMS
```

### 11. Generate Account Statement

User prompt:

```text
Generate my account statement for acc_001 for April 2026.
```

Expected flow:

```text
AI detects generate_document
  -> backend prepares document generation
  -> confirmation
  -> Document Service generate endpoint
  -> generated document download
```

Expected response type:

```text
Prepared document generation summary
Confirm / Cancel
Generated document result after confirmation
```

This is different from a stored Laragon resource. Stored resources use `Download PDF`; new document generation uses the Document Service.

### 12. Book Appointment

User prompt:

```text
Book an appointment at Tunis Centre on 2026-05-25 at 10:00.
```

Expected flow:

```text
AI detects book_appointment
  -> backend prepares appointment
  -> confirmation
  -> Appointment Service booking endpoint
```

Expected response type:

```text
Prepared appointment table
Confirm / Cancel
Booked appointment result after confirmation
```

### 13. Pay Bill With Full Details

User prompt:

```text
Pay my SONEDE bill SONEDE-2026-003 for 42.500 TND from acc_001.
```

Expected flow:

```text
AI detects pay_bill
  -> extracts provider, reference, amount, source account
  -> backend prepares high-risk action
  -> confirmation
  -> SMS verification
  -> Payment Service pay-bill endpoint
  -> audit log
```

Expected response type:

```text
Prepared payment table
Confirm / Cancel
SMS required after confirmation
Payment completion message after SMS verification
```

## 14. What This Proves

Checkpoint 2 proves that the project has moved from a simple chat UI to a layered AI banking agent architecture.

It demonstrates:

- natural language resource lookup
- JSON resource resolution from Laragon
- linked PDF fetching and text extraction
- AI answers grounded in resolved JSON/PDF content
- backend as a secure orchestrator
- Ollama as the reasoning/NLP layer
- internal services as the execution layer
- Laragon as the local resource server
- confirmation and SMS safety for risky actions
- read-only direct execution for low-risk actions
- auditability through backend logs and dashboard visibility
- service-based architecture aligned with the required supervisor service list

The most important architectural point is that the AI does not directly execute banking operations. It interprets and formats. The backend validates, protects, executes, and logs.

## 15. Future Improvements

Future checkpoints can extend the architecture with:

- a vision-capable model such as `qwen2.5vl` for scanned PDFs and image understanding
- OCR for image-only PDFs and scanned documents
- replacement of demo internal services with real ATB APIs
- database-backed resource catalog instead of directory listing/catalog JSON
- stronger authentication and role policies
- production-grade audit logging and monitoring
- file-level permissions for Laragon-hosted or production-hosted resources
- stricter resource ownership checks before exposing documents
- persistent conversation/action state in a database
- better multilingual extraction for French, Arabic, and Tunisian banking wording
