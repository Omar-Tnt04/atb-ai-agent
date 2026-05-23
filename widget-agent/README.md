# ATB Chatbot Widget

Standalone frontend preview for the floating ATB banking assistant widget.

This app uses the same existing backend agent as the main `web-client`. It does not duplicate AI logic, service connectors, action execution, confirmation, SMS verification, resources, or audit logging.

The widget is not integrated into `web-client` yet.

## Run Standalone

```bash
cd widget-agent
npm install
npm run dev
```

Local URL:

```text
http://localhost:5174
```

## Run Full Stack

From the project root:

```bash
npm run dev
```

The root dev launcher starts the existing backend, AI service, web client, internal demo services, and this widget preview on `http://localhost:5174`.

## Backend Configuration

Create a local `.env` file in `widget-agent/` if you need to override defaults:

```env
VITE_AGENT_API_URL=http://localhost:5000/api/widget/chat
VITE_AGENT_AUTH_TOKEN=
```

For local widget preview, the default route is:

```text
http://localhost:5000/api/widget/chat
```

That route is a development-only standalone widget preview route. It injects a synthetic demo user and delegates to the same backend chat/action controllers used by the authenticated web app.

Make sure the backend local environment includes:

```env
WIDGET_DEMO_MODE=true
```

The demo route is for development only. If it is disabled, the widget shows:

```text
Widget demo mode is disabled.
```

For a future authenticated widget integration, point `VITE_AGENT_API_URL` back to the normal backend chat route and provide a token:

```env
VITE_AGENT_API_URL=http://localhost:5000/chat/message
VITE_AGENT_AUTH_TOKEN=your_local_token
```

If the backend requires a token and `VITE_AGENT_AUTH_TOKEN` is missing or invalid, the widget shows:

```text
Login is required to use the ATB agent.
```

Do not hardcode real tokens in source files.

## Supported Frontend Behavior

The widget sends the same chat payload style as `web-client`, including:

- `message`
- `conversationId`
- `conversationHistory`
- `agentContext`
- `profileContext`
- `payload`

It also supports backend-driven assistant output:

- Markdown answers
- Markdown tables
- links
- generated file/document download buttons when the backend returns a download URL
- prepared-action `Confirm` and `Cancel` buttons

Conversation state is kept in React memory for the widget preview.
