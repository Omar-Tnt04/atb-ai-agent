const DEFAULT_AGENT_API_URL = 'http://localhost:5000/api/widget/chat';
const AUTH_REQUIRED_MESSAGE = 'Login is required to use the ATB agent.';
const WIDGET_DEMO_DISABLED_MESSAGE = 'Widget demo mode is disabled.';
const GENERIC_ERROR_MESSAGE = 'Sorry, an error occurred. Please try again.';
const FORBIDDEN_BACKEND_PORTS = new Set(['8000', '11434']);
const FORBIDDEN_BACKEND_PATHS = [
  '/agent/analyze',
  '/agent/decide',
  '/api/generate',
  '/atb-general-resources',
];

const getWindowOrigin = () =>
  typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : DEFAULT_AGENT_API_URL;

export const EMPTY_AGENT_CONTEXT = {
  extractedFields: {},
  suggestedAction: null,
  pendingAction: null,
};

export class AgentApiError extends Error {
  constructor(message, { status = 0, data = null } = {}) {
    super(message);
    this.name = 'AgentApiError';
    this.status = status;
    this.data = data;
  }

  get isAuthError() {
    return this.status === 401 || this.status === 403;
  }
}

const assertBackendEndpoint = (value) => {
  const endpoint = (value || DEFAULT_AGENT_API_URL).trim() || DEFAULT_AGENT_API_URL;
  const parsed = new URL(endpoint, getWindowOrigin());
  const normalizedPath = parsed.pathname.toLowerCase();

  if (
    FORBIDDEN_BACKEND_PORTS.has(parsed.port) ||
    FORBIDDEN_BACKEND_PATHS.some((path) => normalizedPath.includes(path))
  ) {
    throw new AgentApiError(
      'VITE_AGENT_API_URL must point to the Node.js backend, not the AI service, Ollama, or resource server.',
    );
  }

  return parsed.href;
};

const getChatEndpoint = () => {
  // 1. Build-time env var takes highest priority (set in .env for production builds).
  const envUrl = (import.meta.env || {}).VITE_AGENT_API_URL;
  if (envUrl) return assertBackendEndpoint(envUrl);
  // 2. Runtime apiUrl query param — set by the extension/loader from widget-config.js.
  //    Allows switching backend URLs (e.g. HTTPS tunnels) without rebuilding the widget.
  try {
    if (typeof window !== 'undefined') {
      const paramBase = new URLSearchParams(window.location.search).get('apiUrl');
      if (paramBase) {
        const origin = new URL(paramBase).origin;
        return assertBackendEndpoint(`${origin}/api/widget/chat`);
      }
    }
  } catch { /* fall through */ }
  // 3. Hardcoded default for local dev.
  return assertBackendEndpoint(DEFAULT_AGENT_API_URL);
};

const getAuthToken = () => ((import.meta.env || {}).VITE_AGENT_AUTH_TOKEN || '').trim();

const getBackendBaseUrl = () => {
  try {
    return new URL(getChatEndpoint()).origin;
  } catch {
    return new URL(DEFAULT_AGENT_API_URL).origin;
  }
};

const isWidgetDemoEndpoint = () => {
  try {
    return new URL(getChatEndpoint()).pathname.startsWith('/api/widget/');
  } catch {
    return true;
  }
};

const getActionBaseUrl = () =>
  isWidgetDemoEndpoint()
    ? `${getBackendBaseUrl()}/api/widget/actions`
    : `${getBackendBaseUrl()}/agent/actions`;

const toAbsoluteBackendUrl = (value) => {
  if (!value || typeof value !== 'string') {
    return null;
  }

  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      return parsed.origin === getBackendBaseUrl() ? parsed.href : null;
    } catch {
      return null;
    }
  }

  if (value.startsWith('/')) {
    return `${getBackendBaseUrl()}${value}`;
  }

  return `${getBackendBaseUrl()}/${value.replace(/^\/+/, '')}`;
};

const authHeaders = () => {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const jsonHeaders = () => ({
  'Content-Type': 'application/json',
  ...authHeaders(),
});

async function parseJson(response) {
  return response.json().catch(() => ({}));
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  const data = await parseJson(response);

  if (!response.ok) {
    throw new AgentApiError(
      response.status === 401 || response.status === 403
        ? AUTH_REQUIRED_MESSAGE
        : data?.message || GENERIC_ERROR_MESSAGE,
      { status: response.status, data },
    );
  }

  if (data?.success === false) {
    throw new AgentApiError(data.message || GENERIC_ERROR_MESSAGE, {
      status: response.status,
      data,
    });
  }

  return data;
}

const firstString = (values) =>
  values.find((value) => typeof value === 'string' && value.trim())?.trim() || '';

const firstArray = (values) =>
  values.find((value) => Array.isArray(value) && value.length) || [];

const DEBUG_PAYLOAD_KEY_RE =
  /"(?:actionName|assistantMessage|confidence|documentTypeDetected|extractedFields|finalPayload|missingFields|quickActions|suggestedOptions|toolInput)"\s*:/i;

const looksLikeJsonPayload = (value = '') => {
  const trimmed = String(value || '').trim();

  if (!trimmed) {
    return false;
  }

  if (DEBUG_PAYLOAD_KEY_RE.test(trimmed)) {
    return true;
  }

  if (!/^[{[][\s\S]*[}\]]$/.test(trimmed)) {
    return false;
  }

  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
};

const stripDebugBlocks = (value = '') =>
  String(value || '')
    .replace(/```([a-z0-9_-]*)\s*\n([\s\S]*?)```/gi, (match, language, body) => {
      const normalizedLanguage = String(language || '').toLowerCase();

      if (
        ['json', 'jsonc'].includes(normalizedLanguage) ||
        looksLikeJsonPayload(body)
      ) {
        return '';
      }

      return match;
    })
    .replace(/^\s*(?:json|debug|raw response|tool input)\s*:\s*$/gim, '')
    .trim();

const extractAssistantTextFromJson = (value = '') => {
  const trimmed = String(value || '').trim();

  if (!/^[{[]/.test(trimmed)) {
    return '';
  }

  try {
    const parsed = JSON.parse(trimmed);
    const data = parsed?.data || {};
    return firstString([
      parsed?.assistantMessage,
      data?.assistantMessage,
      data?.ai?.assistantMessage,
      parsed?.reply,
      parsed?.content,
      data?.message,
      data?.content,
      data?.messageText,
      parsed?.message,
    ]);
  } catch {
    return '';
  }
};

const sanitizeAssistantText = (value = '') => {
  const rawText = String(value || '').trim();
  const extractedText = extractAssistantTextFromJson(rawText);
  const text = extractedText || rawText;
  const withoutDebugBlocks = stripDebugBlocks(text);

  return looksLikeJsonPayload(withoutDebugBlocks) ? '' : withoutDebugBlocks;
};

const isValidUrlLike = (value) =>
  typeof value === 'string' && (/^https?:\/\//i.test(value) || value.startsWith('/'));

const looksLikePdf = (url = '', fileType = '') =>
  String(fileType).toLowerCase() === 'pdf' || /\.pdf(?:$|[?#])/i.test(url);

const getQuickActionUrl = (action = {}) =>
  action.url || action.viewUrl || action.downloadUrl || action.fileUrl || '';

const isDownloadLikeQuickAction = (action = {}) => {
  const actionType = action.action || action.type || '';
  const label = String(action.label || action.title || action.text || '').toLowerCase();
  const url = String(getQuickActionUrl(action) || '').toLowerCase();

  return (
    ['download', 'open_url', 'download_pdf'].includes(actionType) &&
    (
      label.includes('download pdf') ||
      label.includes('download document') ||
      label.includes('pdf') ||
      url.includes('/resources/download/') ||
      url.split(/[?#]/)[0].endsWith('.pdf')
    )
  );
};

const getQuickActionKey = (action = {}) => {
  if (action.id) return `id:${action.id}`;

  const actionType = action.action || action.type || '';
  const url = String(getQuickActionUrl(action) || '').trim();

  if (url) {
    return `${isDownloadLikeQuickAction(action) ? 'download' : actionType || 'url'}:${url}`;
  }

  return `${actionType}:${action.label || ''}:${action.value || action.prompt || ''}`;
};

const dedupeQuickActions = (actions = []) => {
  const seen = new Set();

  return actions.filter((action) => {
    if (!action || !action.label) return false;
    const key = getQuickActionKey(action);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const getGeneratedFileUrl = (generatedFile) => {
  if (!generatedFile) {
    return null;
  }

  if (isValidUrlLike(generatedFile.downloadUrl)) {
    return generatedFile.downloadUrl;
  }

  if (generatedFile.fileId) {
    return isWidgetDemoEndpoint()
      ? `/api/widget/generated/${generatedFile.fileId}/download`
      : `/generated/${generatedFile.fileId}/download`;
  }

  return null;
};

const extractDownloadInfo = (response) => {
  const data = response?.data || {};
  const generatedFile = data.generatedFile || response?.generatedFile || null;
  const document = data.document || response?.document || null;
  const candidates = [
    getGeneratedFileUrl(generatedFile),
    document?.downloadUrl,
    document?.fileUrl,
    data.downloadUrl,
    data.fileUrl,
    response?.downloadUrl,
    response?.fileUrl,
    data.resourceUrl,
    response?.resourceUrl,
  ];
  const downloadUrl = candidates.find(isValidUrlLike) || null;
  const safeDownloadUrl = toAbsoluteBackendUrl(downloadUrl);

  if (!safeDownloadUrl) {
    return { downloadUrl: null, downloadLabel: '' };
  }

  const fileType = generatedFile?.fileType || document?.fileType || document?.type || '';
  const downloadLabel = looksLikePdf(safeDownloadUrl, fileType)
    ? 'Download PDF'
    : 'Download document';

  return { downloadUrl: safeDownloadUrl, downloadLabel };
};

const normalizeQuickAction = (action, index) => {
  if (!action) {
    return null;
  }

  if (typeof action === 'string') {
    return { label: action, action: 'prompt', prompt: action };
  }

  const rawUrl = action.url || action.viewUrl || action.downloadUrl || action.fileUrl || null;
  const safeUrl = rawUrl ? toAbsoluteBackendUrl(rawUrl) : null;
  const rawActionType = action.action || action.type || '';
  const normalizedAction = ['open', 'view_image'].includes(rawActionType)
    ? 'open_url'
    : rawActionType === 'download_pdf'
      ? 'download'
      : rawActionType || (safeUrl ? 'open_url' : 'prompt');
  const value = action.value || action.id || null;
  const label =
    action.label ||
    action.title ||
    action.text ||
    action.name ||
    value ||
    (safeUrl ? 'Open document' : `Action ${index + 1}`);

  if (/show details/i.test(label)) {
    return null;
  }

  if (['download', 'open_url'].includes(normalizedAction) && !safeUrl) {
    return null;
  }

  return {
    label,
    value,
    action: normalizedAction,
    prompt: action.prompt || action.message || label,
    url: safeUrl,
    raw: action,
  };
};

const normalizeQuickActions = (response, downloadInfo) => {
  const data = response?.data || {};
  const rawQuickActions = firstArray([
    data?.ai?.toolInput?.quickActions,
    data?.ai?.toolInput?.suggestedOptions,
    data?.ai?.toolInput?.options,
    data?.ai?.toolInput?.actions,
    data?.ai?.quickActions,
    data?.ai?.suggestedOptions,
    data?.ai?.options,
    data?.ai?.actions,
    data?.toolInput?.quickActions,
    data?.toolInput?.suggestedOptions,
    data?.toolInput?.options,
    data?.toolInput?.actions,
    data?.actions,
    response?.toolInput?.quickActions,
    response?.toolInput?.suggestedOptions,
    response?.toolInput?.options,
    response?.toolInput?.actions,
    response?.actions,
    data?.quickActions,
    data?.suggestedOptions,
    data?.options,
    response?.quickActions,
    response?.suggestedOptions,
    response?.options,
  ]);

  const quickActions = rawQuickActions
    .map(normalizeQuickAction)
    .filter(Boolean);
  const uniqueQuickActions = dedupeQuickActions(quickActions);

  if (response?.status === 'action_prepared') {
    const resourceAction = uniqueQuickActions.find((action) => action.action === 'open_url');
    return [
      { label: 'Confirm', action: 'continue' },
      { label: 'Cancel', action: 'cancel' },
      ...(resourceAction ? [resourceAction] : []),
    ];
  }

  if (response?.status === 'confirmation_required') {
    return [
      { label: 'Confirm', action: 'confirm_pending' },
      { label: 'Cancel', action: 'cancel' },
    ];
  }

  if (downloadInfo.downloadUrl) {
    return dedupeQuickActions([
      {
        label: downloadInfo.downloadLabel,
        action: 'download',
        url: downloadInfo.downloadUrl,
      },
      ...uniqueQuickActions.filter((action) => !isDownloadLikeQuickAction(action)),
    ]);
  }

  return uniqueQuickActions;
};

export function normalizeAgentResponse(response) {
  const data = response?.data || {};
  const downloadInfo = extractDownloadInfo(response);
  const text = sanitizeAssistantText(firstString([
    response?.assistantMessage,
    data?.assistantMessage,
    data?.ai?.assistantMessage,
    response?.reply,
    response?.content,
    data?.message,
    data?.content,
    data?.messageText,
    response?.message,
  ]));

  return {
    text,
    quickActions: normalizeQuickActions(response, downloadInfo),
    downloadUrl: downloadInfo.downloadUrl
      ? toAbsoluteBackendUrl(downloadInfo.downloadUrl)
      : null,
    actionContext: {
      status: response?.status || null,
      agentMode: response?.agentMode || null,
      preparation: data?.preparation || null,
      pendingAction: data?.pendingAction || null,
      pendingConfirmation: data?.confirmationId ? data : null,
      finalPayload: data?.finalPayload || null,
      generatedFile: data?.generatedFile || null,
      ai: data?.ai || null,
    },
    raw: response,
  };
}

const inferActionFromFields = (fields = {}) => {
  if (fields._visionNoAction === true) return null;
  if (fields.billReference || fields.provider) return 'pay_bill';
  if (fields.beneficiaryId) return 'make_transfer';
  if (fields.documentType || fields.period) return 'generate_document';
  if (fields.category) return 'create_complaint';
  if (fields.branch || fields.appointmentDate) return 'book_appointment';
  return null;
};

export const stripPrivateResourceFields = (fields = {}) =>
  Object.fromEntries(
    Object.entries(fields || {}).filter(
      ([key]) => !String(key).toLowerCase().startsWith('_resource'),
    ),
  );

export const deriveAgentContext = (previousContext, response) => {
  const raw = response?.raw || response || {};
  const data = raw.data || {};
  const ai = data.ai || {};
  const finalPayload = data.finalPayload || {};
  const hasNewFileContext = Boolean(data.fileContext?.files?.length);
  const mergedFields = {
    ...(hasNewFileContext
      ? {}
      : stripPrivateResourceFields(previousContext?.extractedFields || {})),
    ...stripPrivateResourceFields(ai.extractedFields || {}),
    ...stripPrivateResourceFields(finalPayload),
  };
  const suggestedAction =
    ai.actionName ||
    data.actionName ||
    inferActionFromFields(mergedFields) ||
    previousContext?.suggestedAction ||
    null;
  const pendingAction =
    raw.status === 'missing_fields'
      ? data.pendingAction || previousContext?.pendingAction || null
      : null;

  return { extractedFields: mergedFields, suggestedAction, pendingAction };
};

export async function sendAgentMessage({
  message,
  conversationId,
  conversationHistory = [],
  agentContext = {},
  profileContext = {},
  payload = {},
  pageSnapshot = null,
  pageGoalState = null,
  mode = 'ask',
  cacheContext = null,
  siteContext = null,
}) {
  const data = await postJson(toAbsoluteBackendUrl(getChatEndpoint()), {
    message,
    payload,
    conversationId,
    conversationHistory,
    profileContext,
    agentContext: agentContext || {},
    pageSnapshot,
    pageGoalState,
    mode,
    cacheContext,
    siteContext,
  });

  return normalizeAgentResponse(data);
}

// Same-page control bridge (widget iframe ↔ host-page loader).
// Ask the loader (which lives in the host page and can read its DOM) for a generic snapshot.
// Resolves null when not embedded or when no loader answers in time → backend then uses its
// browser-use fallback instead of same-page control.
export function requestPageSnapshot({ timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || window.parent === window) {
      resolve(null);
      return;
    }

    const requestId = `snap-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let settled = false;

    const onMessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'ATB_PAGE_SNAPSHOT' && msg.requestId === requestId) {
        settled = true;
        window.removeEventListener('message', onMessage);
        resolve(msg.snapshot || null);
      }
    };

    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'ATB_PAGE_INSPECT_REQUEST', requestId }, '*');

    window.setTimeout(() => {
      if (!settled) {
        window.removeEventListener('message', onMessage);
        resolve(null);
      }
    }, timeoutMs);
  });
}

// Ask the host-page loader for a full structured site-context object extracted from the
// current DOM. Used by Ask mode to enrich answers with page-specific content.
// Resolves null when not embedded, no loader responds, or on timeout.
export function requestSiteContext({ timeoutMs = 1200 } = {}) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || window.parent === window) {
      resolve(null);
      return;
    }

    const requestId = `ctx-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let settled = false;

    const onMessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'ATB_SITE_CONTEXT_RESPONSE' && msg.requestId === requestId) {
        settled = true;
        window.removeEventListener('message', onMessage);
        resolve(msg.context || null);
      }
    };

    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'ATB_SITE_CONTEXT_REQUEST', requestId }, '*');

    window.setTimeout(() => {
      if (!settled) {
        window.removeEventListener('message', onMessage);
        resolve(null);
      }
    }, timeoutMs);
  });
}

// Forward a backend-produced page action plan to the host-page loader for safe execution.
// Resolves once the loader confirms it ran the actions (ATB_PAGE_ACTION_RESULT) or after a
// timeout — so the widget can wait for the scroll/highlight to happen before showing its final
// answer, and never blocks the UI if no loader answers.
export function dispatchPageActions(actions, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    if (!Array.isArray(actions) || actions.length === 0) {
      resolve({ ok: false, dispatched: false });
      return;
    }
    if (typeof window === 'undefined' || window.parent === window) {
      resolve({ ok: false, dispatched: false });
      return;
    }

    const requestId = `act-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let settled = false;

    const onMessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'ATB_PAGE_ACTION_RESULT' && msg.requestId === requestId) {
        settled = true;
        window.removeEventListener('message', onMessage);
        resolve({ ok: !!(msg.result && msg.result.ok), dispatched: true, result: msg.result || null });
      }
    };

    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'ATB_PAGE_ACTION', actions, requestId }, '*');

    window.setTimeout(() => {
      if (!settled) {
        window.removeEventListener('message', onMessage);
        resolve({ ok: false, dispatched: true, result: null, timedOut: true });
      }
    }, timeoutMs);
  });
}

// Resume breadcrumb: when a safe navigation reloads the host page (and the widget with it), we
// stash the in-flight goal in sessionStorage so the widget can pick the goal back up on the new
// page and point out the next relevant step. Short TTL — a stale breadcrumb is ignored.
const PAGE_GOAL_RESUME_KEY = 'atb_widget_page_goal_resume';
const PAGE_GOAL_RESUME_TTL_MS = 30_000;

export function savePageGoalResume(data) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(
      PAGE_GOAL_RESUME_KEY,
      JSON.stringify({ ...data, ts: Date.now() }),
    );
  } catch {
    /* localStorage unavailable — resume simply won't happen. */
  }
}

export function readPageGoalResume() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(PAGE_GOAL_RESUME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.ts || Date.now() - parsed.ts > PAGE_GOAL_RESUME_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearPageGoalResume() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.removeItem(PAGE_GOAL_RESUME_KEY);
  } catch {
    /* ignore */
  }
}

// Tell the backend to launch a queued browser-use job. Called AFTER saveChatState so the widget
// state is persisted before python runs and potentially navigates the host page. Idempotent.
export async function triggerBrowserAgentJobStart(jobId) {
  if (!jobId) return;
  const base = isWidgetDemoEndpoint()
    ? `${getBackendBaseUrl()}/api/widget/browser-agent`
    : `${getBackendBaseUrl()}/agent/browser-agent`;
  try {
    await fetch(`${base}/${encodeURIComponent(jobId)}/start`, {
      method: 'POST',
      headers: jsonHeaders(),
    });
  } catch {
    // Network error — polling will handle not_found/timeout.
  }
}

// Poll a backend browser-use job until it finishes. Returns the raw job payload:
//   { status: 'browser_agent_running' } | { status:'browser_agent_done', assistantMessage }
//   | { status:'browser_agent_error', message } | { status:'not_found' }
export async function fetchBrowserAgentJob(jobId) {
  if (!jobId) {
    return { status: 'not_found' };
  }
  const base = isWidgetDemoEndpoint()
    ? `${getBackendBaseUrl()}/api/widget/browser-agent`
    : `${getBackendBaseUrl()}/agent/browser-agent`;
  const url = `${base}/${encodeURIComponent(jobId)}`;

  try {
    const response = await fetch(url, { headers: jsonHeaders() });
    const data = await parseJson(response);
    if (response.status === 404) {
      return { status: 'not_found' };
    }
    return data || { status: 'browser_agent_running' };
  } catch {
    // Transient network/reload error — let the caller keep polling.
    return { status: 'browser_agent_running' };
  }
}

// ---------------------------------------------------------------------------------------------
// Chat persistence across host-page navigation. The injected widget lives in an iframe; when the
// host page navigates, the iframe is destroyed and recreated with empty React state. We stash the
// conversation (messages, open state, pending browser-use job) in sessionStorage — same-origin,
// per-tab — so the freshly-injected widget restores it instead of resetting.
// ---------------------------------------------------------------------------------------------
const CHAT_STATE_KEY = 'atb_widget_chat_state';
const CHAT_STATE_TTL_MS = 60 * 60 * 1000;

export function saveChatState(state) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(
      CHAT_STATE_KEY,
      JSON.stringify({ ...state, ts: Date.now() }),
    );
    if (state.pendingBrowserJob) {
      console.log('[ATB_WIDGET_APP] saveChatState: pending job saved, jobId=', state.pendingBrowserJob.jobId, 'isOpen=', state.isOpen);
    }
  } catch {
    /* localStorage unavailable — persistence simply won't happen. */
  }
}

export function readChatState() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(CHAT_STATE_KEY);
    console.log('[ATB_WIDGET_APP] readChatState: localStorage key exists =', raw ? 'yes' : 'no');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.ts || Date.now() - parsed.ts > CHAT_STATE_TTL_MS) {
      console.log('[ATB_WIDGET_APP] readChatState: state expired or missing ts');
      return null;
    }
    console.log('[ATB_WIDGET_APP] readChatState: pendingBrowserJob =', parsed.pendingBrowserJob ? JSON.stringify(parsed.pendingBrowserJob) : 'none', '| isOpen =', parsed.isOpen);
    return parsed;
  } catch {
    return null;
  }
}

export function clearChatState() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.removeItem(CHAT_STATE_KEY);
  } catch {
    /* ignore */
  }
}

// Removes all atb_widget_* localStorage keys from the iframe origin (localhost:5174).
// Does NOT clear the atb.tn bridge key (lives in parent page localStorage).
// Call from iframe DevTools console: __atbWidgetReset()
// Or trigger via postMessage ATB_WIDGET_DEV_RESET from content.js.
export function clearAllWidgetState() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const storage = window.localStorage;
    const removed = [];
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (key && key.startsWith('atb_widget_')) {
        storage.removeItem(key);
        removed.push(key);
      }
    }
    console.log('[ATB_WIDGET_APP] clearAllWidgetState: removed', removed.length, 'keys:', removed.join(', ') || '(none)');
  } catch {
    /* ignore */
  }
}

if (typeof window !== 'undefined') {
  window.__atbWidgetReset = clearAllWidgetState;
  console.log('[ATB_WIDGET_APP] dev reset: call __atbWidgetReset() from iframe DevTools console, or __atbWidgetReset() from ATB page console (after content.js sets it up)');
}

export async function executePreparedAction(preparation) {
  const actionName = preparation?.actionName;
  const payload = preparation?.payload || {};

  if (!actionName) {
    throw new AgentApiError(GENERIC_ERROR_MESSAGE);
  }

  const data = await postJson(`${getActionBaseUrl()}/execute`, {
    actionName,
    payload,
  });

  return normalizeAgentResponse(data);
}

export async function confirmAgentAction(confirmationId) {
  if (!confirmationId) {
    throw new AgentApiError(GENERIC_ERROR_MESSAGE);
  }

  const data = await postJson(`${getActionBaseUrl()}/confirm`, {
    confirmationId,
  });

  return normalizeAgentResponse(data);
}

export async function cancelAgentAction(confirmationId) {
  if (!confirmationId) {
    throw new AgentApiError(GENERIC_ERROR_MESSAGE);
  }

  const data = await postJson(`${getActionBaseUrl()}/cancel`, {
    confirmationId,
  });

  return normalizeAgentResponse(data);
}

export async function verifyAndExecuteAgentAction(confirmationId, code) {
  if (!confirmationId || !code) {
    throw new AgentApiError(GENERIC_ERROR_MESSAGE);
  }

  const data = await postJson(`${getActionBaseUrl()}/verify-and-execute`, {
    confirmationId,
    code,
  });

  return normalizeAgentResponse(data);
}

export async function openDownloadUrl(url) {
  const absoluteUrl = toAbsoluteBackendUrl(url);
  const token = getAuthToken();

  if (!absoluteUrl) {
    throw new AgentApiError(GENERIC_ERROR_MESSAGE);
  }

  if (!token || absoluteUrl.includes('/resources/download/')) {
    window.open(absoluteUrl, '_blank', 'noopener,noreferrer');
    return;
  }

  const popup = window.open('', '_blank', 'noopener,noreferrer');
  const response = await fetch(absoluteUrl, {
    headers: authHeaders(),
  });

  if (!response.ok) {
    if (popup) popup.close();
    throw new AgentApiError(
      response.status === 401 || response.status === 403
        ? AUTH_REQUIRED_MESSAGE
        : GENERIC_ERROR_MESSAGE,
      { status: response.status },
    );
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);

  if (popup) {
    popup.location.href = objectUrl;
  } else {
    window.open(objectUrl, '_blank', 'noopener,noreferrer');
  }

  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

export const getAgentErrorMessage = (error) => {
  if (
    error instanceof AgentApiError &&
    error.status === 403 &&
    (error.data?.status === 'widget_demo_disabled' ||
      error.message === WIDGET_DEMO_DISABLED_MESSAGE)
  ) {
    return WIDGET_DEMO_DISABLED_MESSAGE;
  }

  if (error instanceof AgentApiError && error.isAuthError) {
    return AUTH_REQUIRED_MESSAGE;
  }

  return GENERIC_ERROR_MESSAGE;
};
