const DEFAULT_AGENT_API_URL = 'http://localhost:5000/api/widget/chat';
const AUTH_REQUIRED_MESSAGE = 'Login is required to use the ATB agent.';
const WIDGET_DEMO_DISABLED_MESSAGE = 'Widget demo mode is disabled.';
const GENERIC_ERROR_MESSAGE = 'Sorry, an error occurred. Please try again.';

export const EMPTY_AGENT_CONTEXT = { extractedFields: {}, suggestedAction: null };

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

const getChatEndpoint = () =>
  (import.meta.env.VITE_AGENT_API_URL || DEFAULT_AGENT_API_URL).trim() ||
  DEFAULT_AGENT_API_URL;

const getAuthToken = () => (import.meta.env.VITE_AGENT_AUTH_TOKEN || '').trim();

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
    return value;
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

const isValidUrlLike = (value) =>
  typeof value === 'string' && (/^https?:\/\//i.test(value) || value.startsWith('/'));

const looksLikePdf = (url = '', fileType = '') =>
  String(fileType).toLowerCase() === 'pdf' || /\.pdf(?:$|[?#])/i.test(url);

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

  if (!downloadUrl) {
    return { downloadUrl: null, downloadLabel: '' };
  }

  const fileType = generatedFile?.fileType || document?.fileType || document?.type || '';
  const downloadLabel = looksLikePdf(downloadUrl, fileType)
    ? 'Download PDF'
    : 'Download document';

  return { downloadUrl, downloadLabel };
};

const normalizeQuickAction = (action, index) => {
  if (!action) {
    return null;
  }

  if (typeof action === 'string') {
    return { label: action, action: 'prompt', prompt: action };
  }

  const url = action.url || action.downloadUrl || action.fileUrl || null;
  const normalizedAction = action.action || action.type || (url ? 'open_url' : 'prompt');
  const label =
    action.label ||
    action.title ||
    action.text ||
    action.name ||
    (url ? 'Open document' : `Action ${index + 1}`);

  if (/show details/i.test(label)) {
    return null;
  }

  return {
    label,
    action: normalizedAction,
    prompt: action.prompt || action.message || label,
    url: url ? toAbsoluteBackendUrl(url) : null,
    raw: action,
  };
};

const normalizeQuickActions = (response, downloadInfo) => {
  const data = response?.data || {};
  const rawQuickActions = firstArray([
    data?.ai?.toolInput?.quickActions,
    data?.toolInput?.quickActions,
    response?.toolInput?.quickActions,
    data?.quickActions,
    response?.quickActions,
  ]);

  const quickActions = rawQuickActions
    .map(normalizeQuickAction)
    .filter(Boolean);

  if (response?.status === 'action_prepared') {
    const resourceAction = quickActions.find((action) => action.action === 'open_url');
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
    return [
      {
        label: downloadInfo.downloadLabel,
        action: 'download',
        url: downloadInfo.downloadUrl,
      },
      ...quickActions.filter((action) => action.action !== 'open_url'),
    ];
  }

  return quickActions;
};

export function normalizeAgentResponse(response) {
  const data = response?.data || {};
  const downloadInfo = extractDownloadInfo(response);
  const text = firstString([
    response?.assistantMessage,
    data?.assistantMessage,
    data?.ai?.assistantMessage,
    response?.reply,
    response?.content,
    data?.message,
    data?.content,
    data?.messageText,
    response?.message,
  ]);

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

  return { extractedFields: mergedFields, suggestedAction };
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

export async function openDownloadUrl(url) {
  const absoluteUrl = toAbsoluteBackendUrl(url);
  const token = getAuthToken();

  if (!absoluteUrl) {
    throw new AgentApiError(GENERIC_ERROR_MESSAGE);
  }

  if (!token) {
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
