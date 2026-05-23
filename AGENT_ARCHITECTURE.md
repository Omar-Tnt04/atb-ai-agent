# ATB AI Banking Agent Architecture

## 1. Project Overview

This project is an AI banking agent MVP for ATB. It demonstrates how a chat-based assistant can act as an orchestrator between a user and internal banking services.

The agent understands natural-language banking requests, extracts context from the current chat, uploaded files, the user's profile, and remembered conversation context, then prepares safe backend-controlled actions. When an action is confirmed, the Node.js backend calls internal demo services through connector modules, returns the result in the chat UI, and records audit entries for the admin dashboard.

The AI service does not execute banking actions directly. It classifies intent and extracts fields. The Node.js backend owns validation, safety rules, action preparation, execution, confirmation, SMS verification, connector routing, and audit logging.

## 2. High-Level Architecture

```text
User
-> React Chat UI
-> Node.js Backend Orchestrator
-> Python AI Intent Service
-> Action Registry
-> Internal Service Connector
-> Internal Demo Service API
-> Result in Chat
-> Admin Dashboard / Audit Logs
```

The frontend sends messages and optional files to the backend. The backend sends the content and context to the Python AI service. The Python service returns an `agentMode`, `intent`, `actionName`, `extractedFields`, and assistant text. The backend checks the action registry, prepares the action, applies confirmation and SMS rules, executes through the configured connector, and logs the result.

## 3. Main Folders

- `web-client/`: React frontend. Contains the chat UI, conversation state, quick actions, file upload, confirmation/SMS UI, profile menu, and admin dashboard.
- `backend-node/`: Node.js/Express backend orchestrator. Handles auth, chat routes, AI service calls, action preparation/execution, connector routing, confirmations, SMS verification, generated files, audit logs, and integration status.
- `ai-service-python/`: FastAPI AI intent service. Detects banking intents, classifies uploaded documents, extracts fields, builds assistant responses, and returns structured analysis to the backend.
- `internal-services-demo/`: Separate local HTTP services that simulate internal ATB systems for payments, documents, complaints, and appointments.
- `scripts/`: Development orchestration scripts. `scripts/dev/start.js` starts the backend, AI service, web client, and all internal demo services through `npm run dev`.

## 4. Frontend Flow

The main chat implementation is in `web-client/src/pages/ChatPage.jsx`.

Important frontend files:

- `web-client/src/pages/ChatPage.jsx`: owns message state, conversation threads, `agentContext`, profile context, selected files, pending action state, confirmation state, SMS state, generated file state, quick actions, and assistant rendering.
- `web-client/src/api/chatApi.js`: sends chat requests to the backend.
- `web-client/src/components/chat/MarkdownContent.jsx`: renders assistant Markdown responses.
- `web-client/src/components/chat/ChatMessage.jsx`: renders user and assistant chat messages.
- `web-client/src/api/actionApi.js`: calls backend endpoints for action execution, confirmation, cancellation, and SMS verification.

Text-only messages use:

```text
POST /chat/message
```

from `sendChatMessage()` in `web-client/src/api/chatApi.js`.

Messages with files use:

```text
POST /chat/message-with-files
```

from `sendChatMessageWithFiles()` in `web-client/src/api/chatApi.js`. The frontend builds a `FormData` payload containing:

- `message`
- `conversationHistory`
- `profileContext`
- `agentContext`
- one or more `files`

`ChatPage.jsx` maintains `agentContext` as:

```js
{ extractedFields: {}, suggestedAction: null }
```

After every backend response, `deriveAgentContext()` merges newly extracted fields and final payload fields into the thread context. This lets follow-up messages such as "Pay it", "Book it", "Download it", or "Continue" reuse details from previous chat turns or uploaded documents.

Quick actions are defined in `ChatPage.jsx` through `QUICK_ACTIONS` and `quickRepliesByAction`. They populate common prompts such as checking a balance, generating a document, creating a complaint, booking an appointment, or uploading a bill.

Assistant responses are rendered as Markdown, so prepared action summaries, bullet lists, and result details can be shown cleanly in chat.

## 5. AI Service Flow

The AI service is a FastAPI app in `ai-service-python/app/main.py`. Its main endpoint is:

```text
POST /agent/analyze
```

The request/response schema is defined in `ai-service-python/app/schemas/agent.py`. The main analysis implementation is in:

- `ai-service-python/app/services/intent_service.py`
- `ai-service-python/app/services/field_extraction_service.py`
- `ai-service-python/app/prompts/banking_intent_prompt.py`

The service performs:

- intent detection
- document classification for uploaded file content
- field extraction
- file analysis and file summary generation
- context reuse from `agentContext`
- profile-aware analysis from `profileContext`
- fallback informational answers

Supported current intents include:

- `check_balance`
- `pay_bill`
- `make_transfer`
- `generate_document`
- `create_complaint`
- `book_appointment`
- `file_analysis`
- `informational_answer`

The code also contains connected support for `check_complaint_status` and `list_appointment_slots` in the backend action registry, but the main user-facing MVP flows are the intents listed above.

Uploaded files are first processed by the backend in `backend-node/src/services/fileContext.service.js`. It supports banking PDFs and images, plus TXT, CSV, and JSON files. PDF text is extracted directly when available; scanned/image PDFs and image uploads go through OCR when possible. The extracted `fileContext` is then sent to the Python AI service, where `intent_service.py` can classify bills, account statements, complaint documents, appointment requests, transaction CSVs, generic documents, or unreadable scanned/image documents.

## 6. Backend Orchestrator Flow

The backend chat orchestrator is implemented in:

- `backend-node/src/controllers/chat.controller.js`
- `backend-node/src/services/aiClient.service.js`
- `backend-node/src/services/actionPreparation.service.js`
- `backend-node/src/services/actionExecution.service.js`
- `backend-node/src/actions/actionRegistry.js`

There is no `backend-node/src/services/actionRegistry.service.js`; the actual registry file is `backend-node/src/actions/actionRegistry.js`.

Flow:

1. `backend-node/src/controllers/chat.controller.js` receives `/chat/message` or `/chat/message-with-files`.
2. For file uploads, it builds `fileContext` using `backend-node/src/services/fileContext.service.js`.
3. It calls the Python AI service through `backend-node/src/services/aiClient.service.js`.
4. The AI service returns structured data such as `agentMode`, `intent`, `actionName`, `missingFields`, and `extractedFields`.
5. For `file_analysis`, the backend returns the AI file summary directly.
6. For `informational_answer`, the backend returns the assistant answer directly.
7. For `banking_action`, the backend merges extracted fields with payload data and calls `prepareAction()` in `backend-node/src/services/actionPreparation.service.js`.
8. `prepareAction()` checks the action exists, the user role is allowed, required fields are present, the action is connected, and returns a safe prepared action summary.
9. The frontend then asks the user to continue or confirm.
10. `backend-node/src/services/actionExecution.service.js` applies risk rules:
    - low-risk actions execute directly
    - medium-risk actions require confirmation
    - high-risk actions require confirmation and SMS verification
11. When execution is allowed, the backend calls the configured connector through `backend-node/src/connectors/connectorRegistry.js`.
12. Results and failures are logged through `backend-node/src/services/auditLog.service.js`.

The backend also resolves short follow-up phrases in `chat.controller.js`. If the user says "pay it", "book it", "generate it", "download it", or "continue", the backend can infer the intended action from `agentContext` and proceed with the previously extracted fields.

## 7. Internal Demo Services

The local demo services simulate ATB internal systems over HTTP. They live under `internal-services-demo/`.

### payment-service on 7101

File: `internal-services-demo/payment-service/server.js`

Endpoints:

- `GET /health`
- `POST /payments/pay-bill`
- `POST /transfers/create`

Payment references use the `PAY-DEMO-...` format. Transfer references use the `TRF-DEMO-...` format.

### document-service on 7102

File: `internal-services-demo/document-service/server.js`

Endpoints:

- `GET /health`
- `POST /documents/generate`
- `GET /documents/:documentId/download`

Generated document IDs use the `DOC-DEMO-...` format. The download endpoint returns a text document for the MVP.

### atb-service on 7106

File: `internal-services-demo/atb-service/server.js`

Endpoints:

- `GET /health`
- `GET /customers/:userId`
- `GET /branches`
- `GET /products`
- `GET /cards/:userId`
- `POST /complaints`
- `GET /complaints/:reference`

Complaint references use the `CMP-DEMO-...` format and are handled as part of the ATB service.

### appointment-service on 7104

File: `internal-services-demo/appointment-service/server.js`

Endpoints:

- `GET /health`
- `GET /appointments/slots`
- `POST /appointments/book`

Appointment references use the `APT-DEMO-...` format.

## 8. Connector Layer

Backend connectors call the internal demo services through HTTP. The internal connector files are:

- `backend-node/src/connectors/internal/internalService.config.js`
- `backend-node/src/connectors/internal/internalService.client.js`
- `backend-node/src/connectors/internal/internalPayment.connector.js`
- `backend-node/src/connectors/internal/internalDocument.connector.js`
- `backend-node/src/connectors/internal/internalAtb.connector.js`
- `backend-node/src/connectors/internal/internalAppointment.connector.js`
- `backend-node/src/connectors/internal/internalAccount.connector.js`

`backend-node/src/connectors/connectorRegistry.js` registers the connectors and exposes `executeConnectorOperation()`.

The normal connected action path uses the `internal*` connectors:

- `internalPaymentConnector`
- `internalDocumentConnector`
- `internalAtbConnector`
- `internalAppointmentConnector`
- `internalAccountConnector`

Each connector calls `callInternalService()` from `backend-node/src/connectors/internal/internalService.client.js`.

There is no sandbox/mock fallback in normal execution for internal demo service actions. If an internal service is disabled, offline, unreachable, or returns an unsuccessful service response, the app returns:

```text
The internal service is currently unavailable.
```

The returned connector source for successful internal calls is:

```text
internal_demo_service
```

Internal service defaults are configured in `backend-node/src/connectors/internal/internalService.config.js`:

- `payment`: `http://localhost:7101`
- `document`: `http://localhost:7102`
- `atb`: `http://localhost:7106`
- `appointment`: `http://localhost:7104`
- `account`: `http://localhost:7105`

The services must also be enabled by environment variables such as `PAYMENT_SERVICE_ENABLED`, `DOCUMENT_SERVICE_ENABLED`, `ATB_SERVICE_ENABLED`, `APPOINTMENT_SERVICE_ENABLED`, and `ACCOUNT_SERVICE_ENABLED`.

## 9. Security and Safety Flow

The AI service never executes actions directly. It only returns analysis and suggested action data.

The backend controls execution through:

- `backend-node/src/actions/actionRegistry.js`
- `backend-node/src/services/actionPreparation.service.js`
- `backend-node/src/services/actionExecution.service.js`
- `backend-node/src/services/confirmation.service.js`
- `backend-node/src/services/smsVerification.service.js`

Safety rules are defined per action in `backend-node/src/actions/actionRegistry.js`:

- `check_balance`: low risk, no confirmation, no SMS
- `generate_document`: medium risk, confirmation required
- `create_complaint`: medium risk, confirmation required
- `book_appointment`: medium risk, confirmation required
- `pay_bill`: high risk, confirmation and SMS required
- `make_transfer`: high risk, confirmation and SMS required

High-risk actions require the user to confirm the action and then enter a simulated SMS code. SMS records are managed by `backend-node/src/services/smsVerification.service.js`, and the simulated SMS connector exists at `backend-node/src/connectors/notifications/simulatedSms.connector.js`.

Every preparation, confirmation, SMS, execution, failure, cancellation, or service outage can be recorded as an audit log through `backend-node/src/services/auditLog.service.js`.

## 10. Context Memory

The MVP maintains conversation memory through `agentContext`.

Context sources:

- uploaded file extracted fields from `fileContext`
- previous conversation context from `conversationHistory`
- profile context from `profileContext`
- previous extracted fields and selected action from `agentContext`

The frontend stores `agentContext` per conversation thread in `ChatPage.jsx`. It merges:

- `response.data.ai.extractedFields`
- `response.data.finalPayload`
- inferred `suggestedAction`

The backend also reads `agentContext` in `chat.controller.js` to resolve follow-up phrases. For example:

- If a bill PDF extracted `billReference` and `provider`, "Pay it" can resolve to `pay_bill`.
- If a document request extracted `documentType` and `period`, "Download it" or "Generate it" can resolve to `generate_document`.
- If an appointment request extracted branch/date/time, "Book it" can resolve to `book_appointment`.

This is how the agent supports natural follow-up messages without forcing the user to repeat every field.

## 11. Example End-to-End Flows

### A. PDF bill -> understand -> pay it -> SMS -> payment service -> PAY-DEMO result

1. User uploads a bill PDF in the React chat UI.
2. `web-client/src/api/chatApi.js` sends it to `POST /chat/message-with-files`.
3. `backend-node/src/services/fileContext.service.js` extracts PDF text.
4. `ai-service-python/app/services/intent_service.py` classifies the document as a bill and extracts fields such as provider and bill reference.
5. The assistant summarizes the bill.
6. User says "Pay it".
7. `chat.controller.js` resolves the follow-up using `agentContext` and prepares `pay_bill`.
8. `actionExecution.service.js` requires confirmation because `pay_bill` is high risk.
9. After confirmation, the backend creates a simulated SMS code.
10. User enters the SMS code.
11. `internalPaymentConnector` calls `POST /payments/pay-bill` on `payment-service`.
12. The payment service returns a `PAY-DEMO-...` reference.
13. The chat shows the completed result, and the admin dashboard records the audit log.

### B. Generate statement -> document service -> download

1. User asks to generate an account statement.
2. The Python AI service returns `generate_document` and extracted fields such as `accountId`, `documentType`, and `period`.
3. The backend prepares the action and requires confirmation because it is medium risk.
4. After confirmation, `internalDocumentConnector` calls `POST /documents/generate` on `document-service`.
5. The service returns a `DOC-DEMO-...` document ID and download URL.
6. The chat shows the generated document result and download action.
7. The document can be downloaded from `GET /documents/:documentId/download`.

### C. Complaint paragraph -> ATB service -> CMP-DEMO result

1. User describes a complaint in chat.
2. The AI service returns `create_complaint` with `category` and `description`.
3. The backend prepares the complaint and requires confirmation because it is medium risk.
4. After confirmation, `internalAtbConnector` calls `POST /complaints` on `atb-service`.
5. The service returns a `CMP-DEMO-...` complaint reference.
6. The chat shows the complaint reference and status, and the audit log records the action.

### D. Appointment request -> appointment service -> APT-DEMO result

1. User asks to book an appointment.
2. The AI service extracts branch, date, and time.
3. The backend prepares `book_appointment` and requires confirmation because it is medium risk.
4. After confirmation, `internalAppointmentConnector` calls `POST /appointments/book` on `appointment-service`.
5. The service returns an `APT-DEMO-...` appointment reference.
6. The chat shows the booking result, and the admin dashboard records the action.

## 12. Admin Dashboard

The admin dashboard is implemented in `web-client/src/pages/DashboardPage.jsx`.

It loads:

- audit logs from `web-client/src/api/auditApi.js`
- connector registry data from `web-client/src/api/integrationApi.js`
- internal service health from `web-client/src/api/integrationApi.js`

Backend files:

- `backend-node/src/controllers/audit.controller.js`
- `backend-node/src/services/auditLog.service.js`
- `backend-node/src/controllers/integration.controller.js`
- `backend-node/src/connectors/connectorRegistry.js`
- `backend-node/src/connectors/internal/internalService.config.js`

The dashboard shows:

- internal service status
- available connector operations
- audit log status
- risk level
- action references
- `serviceName`
- `connectorSource`

For successful internal demo service executions, `connectorSource` is:

```text
internal_demo_service
```

The dashboard derives references from payment, transfer, complaint, appointment, document, or confirmation IDs.

## 13. How to Run

Install root dependencies:

```bash
npm install
```

Install internal demo service dependencies:

```bash
npm --prefix internal-services-demo install
```

Start the full development stack:

```bash
npm run dev
```

`npm run dev` runs `scripts/dev/start.js`, which starts the Node backend, Python AI service, React web client, and the five internal demo services.

Internal service health URLs:

- `http://localhost:7101/health`
- `http://localhost:7102/health`
- `http://localhost:7106/health`
- `http://localhost:7104/health`
- `http://localhost:7105/health`

The Python AI service health endpoint is:

```text
http://localhost:8000/health
```

## 14. Production Mapping

In production, the local demo service URLs are replaced with real ATB internal service URLs. This mapping is centralized in `backend-node/src/connectors/internal/internalService.config.js` through service-specific base URL environment variables.

The chat UI, AI intent service contract, backend action registry, backend safety rules, connector interface, and audit logging flow can remain the same. The connector layer is the boundary where local demo HTTP services are swapped for real ATB internal APIs.

The production version should keep the same principle used in the MVP: the AI understands and extracts, but the backend orchestrator validates, confirms, executes, and audits.
