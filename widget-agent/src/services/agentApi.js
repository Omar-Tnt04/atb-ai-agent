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

const getChatEndpoint = () =>
  assertBackendEndpoint((import.meta.env || {}).VITE_AGENT_API_URL || DEFAULT_AGENT_API_URL);

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
  action.url || action.downloadUrl || action.fileUrl || '';

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

  const rawUrl = action.url || action.downloadUrl || action.fileUrl || null;
  const safeUrl = rawUrl ? toAbsoluteBackendUrl(rawUrl) : null;
  const rawActionType = action.action || action.type || '';
  const normalizedAction = rawActionType === 'download_pdf'
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
}) {
  const data = await postJson(toAbsoluteBackendUrl(getChatEndpoint()), {
    message,
    payload,
    conversationId,
    conversationHistory,
    profileContext,
    agentContext: agentContext || {},
  });

  return normalizeAgentResponse(data);
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
