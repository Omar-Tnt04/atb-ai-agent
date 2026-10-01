import { widgetRuntime, widgetStorage, widgetFetch } from './widgetRuntime.js';
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
  if (widgetRuntime.apiUrl) return `${widgetRuntime.apiUrl}/api/widget/chat`;
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
  const response = await widgetFetch(url, {
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

// ── Source parsing ─────────────────────────────────────────────────────────────
// Backend appends human "Source:" lines to the answer text, e.g.
//   Source: ask-context.json — https://atb.tn/... | https://atb.tn/...
//   Source: catalog.json (id=qr-merchant-payment-receipt, category=payment_receipt)
// We strip these from the visible answer and turn them into structured chips so the
// bubble stays clean and long URLs never render as raw text.
const SOURCE_LINE_RE = /^[ \t>*-]*source\s*:/i;

const titleCase = (value = '') =>
  String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word.length <= 2 ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');

const idToTitle = (id = '') => titleCase(String(id || '').replace(/[-_]+/g, ' '));

const prettifyFromUrl = (url = '') => {
  try {
    const parsed = new URL(url);
    let segment = parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
    segment = segment
      .replace(/\.[a-z0-9]+$/i, '')       // drop extension (.php)
      .replace(/[-_]?presentation$/i, '') // drop trailing "presentation"
      .replace(/[-_]+/g, ' ')
      .trim();
    if (!segment) segment = parsed.hostname.replace(/^www\./, '');
    return titleCase(segment);
  } catch {
    return url;
  }
};

const parseSourceLine = (line) => {
  const body = line.replace(SOURCE_LINE_RE, '').trim();

  const catalog = body.match(/catalog\.json\s*\(([^)]*)\)/i);
  if (catalog) {
    const attrs = {};
    for (const pair of catalog[1].split(',')) {
      const [key, ...rest] = pair.split('=');
      if (key) attrs[key.trim()] = rest.join('=').trim();
    }
    const label = attrs.id ? idToTitle(attrs.id) : attrs.category ? idToTitle(attrs.category) : 'Catalog';
    return [{ type: 'catalog', label, id: attrs.id || undefined, category: attrs.category || undefined }];
  }

  const urls = body.match(/https?:\/\/[^\s|]+/g) || [];
  if (urls.length) {
    const type = /ask-context/i.test(body) ? 'ask-context' : 'url';
    return urls.map((url) => ({ type, label: prettifyFromUrl(url), url }));
  }

  const label = body.replace(/^(ask-context\.json|catalog\.json)\s*[—:-]*/i, '').trim();
  return label ? [{ type: 'unknown', label: titleCase(label.slice(0, 40)) }] : [];
};

const normalizeStructuredSources = (list = []) =>
  list
    .map((entry) => {
      const str = String(entry || '');
      if (/^catalog\.json:/i.test(str)) {
        const id = str.replace(/^catalog\.json:/i, '');
        return { type: 'catalog', label: idToTitle(id), id };
      }
      const ask = str.match(/^ask-context\.json:(.*)$/i);
      if (ask) {
        const value = ask[1];
        return /^https?:/i.test(value)
          ? { type: 'ask-context', label: prettifyFromUrl(value), url: value }
          : { type: 'ask-context', label: titleCase(value) };
      }
      if (/^https?:/i.test(str)) return { type: 'url', label: prettifyFromUrl(str), url: str };
      return str ? { type: 'unknown', label: titleCase(str.slice(0, 40)) } : null;
    })
    .filter(Boolean);

// A bare homepage/root URL (e.g. https://atb.tn/) is not a useful citation — drop it so
// chips stay relevant ([Reclamation] [Contact] instead of [Reclamation] [Contact] [Atb]).
const isUsefulSource = (source) => {
  if (!source || !source.url) return true; // catalog / label-only chips always kept
  try {
    const path = new URL(source.url).pathname.replace(/\/+$/, '');
    return path.length > 0;
  } catch {
    return true;
  }
};

const dedupeSources = (sources = []) => {
  const seen = new Set();
  return sources.filter((source) => {
    if (!isUsefulSource(source)) return false;
    const key = source.url || `${source.type}:${source.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// ── Helpful-link helper ──────────────────────────────────────────────────────
// The widget no longer renders raw source chips. Instead it picks the single most
// useful public ATB page/document from the parsed sources and offers one navigation
// button. Sources stay on the message for debugging/audit; only the UI changes.
const ATB_HOST_RE = /(^|\.)atb\.tn$/i;

const isAllowedNavUrl = (url) => {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && ATB_HOST_RE.test(parsed.hostname);
  } catch {
    return false;
  }
};

const isDocUrl = (url = '') => /\.(pdf|docx?|xlsx?|pptx?)(?:$|[?#])/i.test(url);

// UI-only labelling (not retrieval). Small map for common ATB slugs; generic title-case
// otherwise. Nothing here affects which evidence was retrieved.
const KNOWN_PAGE_LABELS = {
  'services-atbpay': 'ATB PAY',
  atbpay: 'ATB PAY',
  'services-banque': 'Services bancaires',
  cartes: 'Cartes',
  carte: 'Cartes',
  reclamation: 'Réclamation',
  contact: 'Contact',
};

const pageNameFromUrl = (url = '') => {
  try {
    const parsed = new URL(url);
    const slug = (parsed.pathname.split('/').filter(Boolean).pop() || '')
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/, '')
      .replace(/[-_]?presentation$/, '');
    if (!slug) return '';
    if (/document|utile/.test(slug)) return '__DOCS__';
    if (KNOWN_PAGE_LABELS[slug]) return KNOWN_PAGE_LABELS[slug];
    return titleCase(slug.replace(/[-_]+/g, ' '));
  } catch {
    return '';
  }
};

const linkHelperLabel = (url, isDoc, lang) => {
  if (isDoc) return lang === 'fr' ? 'Ouvrir le document' : 'Open document';
  const name = pageNameFromUrl(url);
  if (name === '__DOCS__') return lang === 'fr' ? 'Ouvrir les documents utiles' : 'Open useful documents';
  if (!name) return lang === 'fr' ? 'Ouvrir la page' : 'Open page';
  return lang === 'fr' ? `Ouvrir la page ${name}` : `Open ${name} page`;
};

// FR/EN detection from the answer text (label localization only — user language == answer language).
const detectAnswerLang = (text = '') =>
  /\b(vous|pour|votre|num[eé]ro|adresse|r[eé]clamation|carte|compte|ouvrir|avec|les|des)\b|[éèàçêùîô]/i.test(text)
    ? 'fr'
    : 'en';

// Backend-authoritative ASK link: the server already ranked the selected evidence and
// chose the useful-link URL. Trust it (validated) instead of re-guessing from source order.
const buildLinkHelperFromBackend = (askLink, lang = 'en') => {
  if (!askLink || !askLink.url || !isAllowedNavUrl(askLink.url)) return null;
  const isDoc = isDocUrl(askLink.url);
  return {
    label: linkHelperLabel(askLink.url, isDoc, lang),
    url: askLink.url,
    action: isDoc ? 'open_document' : 'navigate',
    sourceType: askLink.sourceType || 'ask',
    reason: askLink.reason || '',
    lang,
  };
};

// Pick the single best public page/document to offer. Returns null when only
// catalog entries (no user-facing URL) or root/homepage URLs exist.
const buildLinkHelper = (sources = [], lang = 'en') => {
  const best = sources.find(
    (source) =>
      source.url &&
      isAllowedNavUrl(source.url) &&
      (source.type === 'ask-context' || source.type === 'url'),
  );
  if (!best) return null;
  const isDoc = isDocUrl(best.url);
  return {
    label: linkHelperLabel(best.url, isDoc, lang),
    url: best.url,
    action: isDoc ? 'open_document' : 'navigate',
    sourceType: best.type,
    reason: best.label,
    lang,
  };
};

// Click behavior:
//  - documents open in a new tab (project convention for PDFs)
//  - PAGE links navigate the SAME tab. Never window.open / _blank for pages.
// Navigation is validated by the content script on ATB pages.
export const openHelpfulLink = (linkHelper) => {
  if (!linkHelper || !linkHelper.url || !isAllowedNavUrl(linkHelper.url)) return;
  const { url } = linkHelper;

  if (linkHelper.action === 'open_document') {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }

  if (widgetRuntime.page) widgetRuntime.page.navigate(url);
  else window.location.assign(url);
};

// Split assistant text into { text (Source: lines removed), sources[] }.
export const parseAssistantSources = (text = '') => {
  const kept = [];
  const sources = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (SOURCE_LINE_RE.test(line)) sources.push(...parseSourceLine(line));
    else kept.push(line);
  }
  const cleaned = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: cleaned, sources: dedupeSources(sources) };
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
  const rawText = sanitizeAssistantText(firstString([
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

  // Strip inline "Source:" lines into structured chips; fall back to structured
  // response.sources (option A) when the text carried none.
  const { text, sources: parsedSources } = parseAssistantSources(rawText);
  const structured = Array.isArray(response?.sources) ? response.sources
    : Array.isArray(data?.sources) ? data.sources : [];
  const sources = parsedSources.length ? parsedSources : normalizeStructuredSources(structured);

  // One user-facing navigation helper replaces the raw source chips (kept internally).
  // Prefer the backend-authoritative ASK link (derived from the ranked selected evidence)
  // over guessing from source-line order; fall back to source parsing when absent.
  const backendLink = buildLinkHelperFromBackend(response?.askLink || data?.askLink, detectAnswerLang(text));
  const linkHelper = backendLink || buildLinkHelper(sources, detectAnswerLang(text));

  return {
    text,
    sources,
    linkHelper,
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
    clientCapabilities: widgetRuntime.page ? { contentScript: true } : undefined,
  });

  return normalizeAgentResponse(data);
}

// Direct calls stay inside the isolated content script; the ATB page cannot forge actions.
export async function requestPageSnapshot() { return widgetRuntime.page?.snapshot() || null; }
export async function requestSiteContext() { return widgetRuntime.page?.context() || null; }
export async function dispatchPageActions(actions) {
  return widgetRuntime.page?.actions(actions) || { ok: false, dispatched: false };
}

// Resume breadcrumb: when a safe navigation reloads the host page (and the widget with it), we
// stash the in-flight goal in sessionStorage so the widget can pick the goal back up on the new
// page and point out the next relevant step. Short TTL — a stale breadcrumb is ignored.
const PAGE_GOAL_RESUME_KEY = 'atb_widget_page_goal_resume';
const PAGE_GOAL_RESUME_TTL_MS = 30_000;

export function savePageGoalResume(data) {
  try {
    if (typeof window === 'undefined' || !widgetStorage()) return;
    widgetStorage().setItem(
      PAGE_GOAL_RESUME_KEY,
      JSON.stringify({ ...data, ts: Date.now() }),
    );
  } catch {
    /* localStorage unavailable — resume simply won't happen. */
  }
}

export function readPageGoalResume() {
  try {
    if (typeof window === 'undefined' || !widgetStorage()) return null;
    const raw = widgetStorage().getItem(PAGE_GOAL_RESUME_KEY);
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
    if (typeof window === 'undefined' || !widgetStorage()) return;
    widgetStorage().removeItem(PAGE_GOAL_RESUME_KEY);
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
    await widgetFetch(`${base}/${encodeURIComponent(jobId)}/start`, {
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
    const response = await widgetFetch(url, { headers: jsonHeaders() });
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
// Chat and goal state use private extension session storage per tab, or localStorage in preview.
const CHAT_STATE_KEY = 'atb_widget_chat_state';
const CHAT_STATE_TTL_MS = 60 * 60 * 1000;

export function saveChatState(state) {
  try {
    if (typeof window === 'undefined' || !widgetStorage()) return;
    widgetStorage().setItem(
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
    if (typeof window === 'undefined' || !widgetStorage()) return null;
    const raw = widgetStorage().getItem(CHAT_STATE_KEY);
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
    if (typeof window === 'undefined' || !widgetStorage()) return;
    widgetStorage().removeItem(CHAT_STATE_KEY);
  } catch {
    /* ignore */
  }
}

// Clear only widget-owned keys in the configured storage.
export function clearAllWidgetState() {
  try {
    if (typeof window === 'undefined' || !widgetStorage()) return;
    const storage = widgetStorage();
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
  const response = await widgetFetch(absoluteUrl, {
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
