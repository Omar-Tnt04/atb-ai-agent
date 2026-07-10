const axios = require('axios');
const env = require('../config/env');
const { selectModel } = require('../config/modelRouting');
const {
  endTimer,
  logArchitecture,
  logError,
  messagePreview,
  startTimer,
} = require('./architectureLogger.service');

const routingLogFields = (routing) => ({
  model_routing_mode: routing.modelRoutingMode,
  selected_model: routing.selectedModel,
  selected_model_reason: routing.selectedModelReason,
  vision_used: routing.visionUsed,
});

const aiRoutingPayload = (routing) => ({
  modelRoutingMode: routing.modelRoutingMode,
  selectedModel: routing.selectedModel,
  selectedKeepAlive: routing.selectedKeepAlive,
  selectedModelReason: routing.selectedModelReason,
  visionUsed: routing.visionUsed,
});

const isImageMimeType = (mimeType = '') =>
  String(mimeType || '').toLowerCase().startsWith('image/');

const visionRequestTimeoutMsForMimeType = (mimeType = '') =>
  isImageMimeType(mimeType) ? env.visionRequestTimeoutMs : 60000;

const IMPORTANT_RESOURCE_KEYS = [
  'resourceId',
  'id',
  'title',
  'name',
  'resourceType',
  'type',
  'status',
  'provider',
  'service',
  'billReference',
  'billRef',
  'invoiceReference',
  'amount',
  'currency',
  'dueDate',
  'paymentDueDate',
  'sourceAccountId',
  'accountId',
  'branch',
  'date',
  'time',
  'summary',
  'description',
  'purpose',
  'requiredId',
  'steps',
  'fileUrl',
  'documentUrl',
  'url',
];

const safeJsonLength = (value) => {
  try {
    return JSON.stringify(value || {}).length;
  } catch {
    return 0;
  }
};

const trimText = (value, limit) => {
  const text = String(value || '');
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit))}\n[Context trimmed]`;
};

const resourceIdFromContext = (context = {}) =>
  context?.resourceJson?.resourceId ||
  context?.resourceJson?.id ||
  context?.matchedResource?.fileName ||
  context?.matchedResource?.resourceId ||
  context?.resourceUrl ||
  'unknown_resource';

const compactResourceJson = (resourceJson = {}, limit = env.maxContextChars) => {
  if (!resourceJson || typeof resourceJson !== 'object') return resourceJson;
  if (safeJsonLength(resourceJson) <= limit) return resourceJson;

  const compact = {
    _trimmed: true,
    _originalCharCount: safeJsonLength(resourceJson),
    _availableKeys: Object.keys(resourceJson).slice(0, 40),
  };

  for (const key of IMPORTANT_RESOURCE_KEYS) {
    const value = resourceJson[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      compact[key] = trimText(value, Math.min(600, limit));
    } else if (Array.isArray(value)) {
      compact[key] = value.slice(0, 6).map((item) =>
        typeof item === 'string' ? trimText(item, 240) : item,
      );
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      compact[key] = value;
    } else if (typeof value === 'object') {
      compact[key] = Object.fromEntries(Object.entries(value).slice(0, 12));
    }
  }

  return compact;
};

const trimConversationHistory = (history = []) => {
  if (!Array.isArray(history)) return [];
  return history.slice(-8).map((entry) => {
    if (!entry || typeof entry !== 'object') {
      return { role: 'unknown', content: trimText(entry || '', 500) };
    }
    return {
      ...entry,
      content: trimText(entry.content || entry.message || '', 500),
      message: entry.message ? trimText(entry.message, 500) : entry.message,
    };
  });
};

const trimFileContext = (fileContext = null) => {
  if (!fileContext || typeof fileContext !== 'object') return fileContext;
  const maxChars = Math.max(500, env.maxContextChars);
  return {
    ...fileContext,
    combinedText: trimText(fileContext.combinedText || '', maxChars),
    files: Array.isArray(fileContext.files)
      ? fileContext.files.slice(0, 8).map((file) => ({
          originalName: file.originalName,
          mimeType: file.mimeType,
          size: file.size,
          fileKind: file.fileKind,
          isVisualInput: file.isVisualInput,
          isOcrDerived: file.isOcrDerived,
          isScannedOrImageBased: file.isScannedOrImageBased,
          extractionStatus: file.extractionStatus,
          extractionError: file.extractionError,
          extractedText: file.extractedText ? trimText(file.extractedText, 500) : '',
        }))
      : [],
  };
};

const trimResolvedResourceContext = (context = null) => {
  if (!context || typeof context !== 'object') return context;
  const maxChars = Math.max(500, env.maxContextChars);
  let trimmed = {
    ...context,
    pdfBase64: undefined,
    fileBuffer: undefined,
    fileTextPreview: '',
    fileText: trimText(context.fileText || '', maxChars),
    resourceJson: compactResourceJson(context.resourceJson || {}, Math.floor(maxChars * 0.75)),
    matchedResources: Array.isArray(context.matchedResources)
      ? context.matchedResources.slice(0, 5).map((resource) => ({
          fileName: resource.fileName,
          score: resource.score,
          resourceType: resource.resourceType,
          status: resource.status,
        }))
      : [],
  };

  let remaining = safeJsonLength(trimmed);
  while (remaining > maxChars && trimmed.fileText) {
    const nextLimit = Math.max(300, Math.floor(String(trimmed.fileText).length * 0.6));
    trimmed = {
      ...trimmed,
      fileText: trimText(trimmed.fileText, nextLimit),
    };
    const nextLength = safeJsonLength(trimmed);
    if (nextLength >= remaining) break;
    remaining = nextLength;
  }

  return trimmed;
};

const trimResourceResponseWriterContext = (writer = null, maxChars = env.maxContextChars) => {
  if (!writer || typeof writer !== 'object') return writer;
  const compact = { ...writer };

  if (compact.resource && typeof compact.resource === 'object') {
    compact.resource = {
      ...compact.resource,
      summary: compact.resource.summary
        ? trimText(compact.resource.summary, Math.min(900, maxChars))
        : compact.resource.summary,
      fields: compactResourceJson(compact.resource.fields || {}, Math.floor(maxChars * 0.4)),
    };
  }

  if (compact.actionDraft && typeof compact.actionDraft === 'object') {
    compact.actionDraft = {
      ...compact.actionDraft,
      fields: compactResourceJson(compact.actionDraft.fields || {}, Math.floor(maxChars * 0.25)),
    };
  }

  if (Array.isArray(compact.resources)) {
    compact.resources = compact.resources.slice(0, 3).map((resource) =>
      compactResourceJson(resource, Math.floor(maxChars * 0.25)),
    );
  }

  return compact;
};

const trimAgentContext = (agentContext = null) => {
  if (!agentContext || typeof agentContext !== 'object') return agentContext;
  const maxChars = Math.max(500, env.maxContextChars);
  const context = { ...agentContext };

  if (context.resourceResponseWriter) {
    context.resourceResponseWriter = {
      ...trimResourceResponseWriterContext(context.resourceResponseWriter, maxChars),
    };
  }

  if (safeJsonLength(context) <= maxChars) return context;

  return {
    ...context,
    systemInstruction: context.systemInstruction ? trimText(context.systemInstruction, 800) : context.systemInstruction,
    backendMemory: context.backendMemory
      ? {
          lastCase: context.backendMemory.lastCase,
          lastTopic: context.backendMemory.lastTopic,
          lastActiveResource: compactResourceJson(context.backendMemory.lastActiveResource || {}, 1000),
        }
      : context.backendMemory,
  };
};

const buildTrimmedAiPayload = ({
  requestId,
  threadId,
  endpoint,
  payload,
}) => {
  const contextCharsBefore = safeJsonLength(payload);
  const trimmedPayload = {
    ...payload,
    conversationHistory: trimConversationHistory(payload.conversationHistory),
    fileContext: trimFileContext(payload.fileContext),
    resolvedResourceContext: trimResolvedResourceContext(payload.resolvedResourceContext),
    agentContext: trimAgentContext(payload.agentContext),
    ...(Object.prototype.hasOwnProperty.call(payload, 'resourceJson')
      ? { resourceJson: compactResourceJson(payload.resourceJson || {}, Math.floor(env.maxContextChars * 0.75)) }
      : {}),
  };
  const contextCharsAfter = safeJsonLength(trimmedPayload);

  if (contextCharsAfter < contextCharsBefore) {
    logArchitecture('large_context_trimmed', {
      requestId,
      threadId,
      endpoint,
      large_context_trimmed: true,
      context_chars_before: contextCharsBefore,
      context_chars_after: contextCharsAfter,
      resourceId: resourceIdFromContext(payload.resolvedResourceContext || {}),
    });
  }

  return {
    payload: trimmedPayload,
    contextCharsBefore,
    contextCharsAfter,
  };
};

const clearLargeTempReferences = (payload) => {
  if (!payload || typeof payload !== 'object') return;
  if (payload.fileContext) {
    payload.fileContext.combinedText = '';
    payload.fileContext.files = [];
  }
  if (payload.resolvedResourceContext) {
    payload.resolvedResourceContext.fileText = '';
    payload.resolvedResourceContext.resourceJson = null;
  }
  if (payload.agentContext?.resourceResponseWriter) {
    payload.agentContext.resourceResponseWriter.resources = [];
    payload.agentContext.resourceResponseWriter.resource = null;
    payload.agentContext.resourceResponseWriter.actionDraft = null;
  }
  payload.conversationHistory = [];
};

const analyzeMessage = async ({
  requestId,
  threadId,
  message,
  userRole,
  availableActions,
  conversationHistory,
  fileContext,
  resolvedResourceContext,
  profileContext,
  agentContext,
}) => {
  const timer = startTimer();
  const routing = selectModel({ requiresVision: false });
  let requestPayload = null;
  let contextCharsBefore = 0;
  let contextCharsAfter = 0;
  logArchitecture('ai_text_flow_started', {
    requestId,
    threadId,
    endpoint: '/agent/analyze',
    mode: 'text',
    promptType: 'agent_analyze',
    messagePreview: messagePreview(message),
    ...routingLogFields(routing),
  });
  try {
    const trimmed = buildTrimmedAiPayload({
      requestId,
      threadId,
      endpoint: '/agent/analyze',
      payload: {
        requestId,
        threadId,
        message,
        userRole,
        availableActions,
        conversationHistory,
        fileContext,
        resolvedResourceContext,
        profileContext,
        agentContext,
        modelRouting: aiRoutingPayload(routing),
      },
    });
    requestPayload = trimmed.payload;
    contextCharsBefore = trimmed.contextCharsBefore;
    contextCharsAfter = trimmed.contextCharsAfter;
    // Bounded timeout so a stale/hung Python AI service (:8000) can never block the whole
    // request during the demo. On timeout axios throws ECONNABORTED → same catch/fallback
    // path as any other AI-service error (behavior unchanged when the service is healthy).
    const aiTimeoutMs = parseInt(process.env.AI_TEXT_TIMEOUT_MS || '15000', 10);
    const response = await axios.post(`${env.aiServiceUrl}/agent/analyze`, requestPayload, { timeout: aiTimeoutMs });
    logArchitecture('ai_text_flow_finished', {
      requestId,
      threadId,
      endpoint: '/agent/analyze',
      latencyMs: endTimer(timer),
      status: response.status,
      responseIntent: response.data?.data?.intent,
      responseStyle: response.data?.data?.responseStyle,
      ...routingLogFields(routing),
    });
    return response.data;
  } catch (error) {
    logError('ai_text_flow_failed', error, {
      requestId,
      threadId,
      endpoint: '/agent/analyze',
      latencyMs: endTimer(timer),
    });
    throw error;
  } finally {
    clearLargeTempReferences(requestPayload);
    logArchitecture('request_temp_cleanup_done', {
      requestId,
      threadId,
      endpoint: '/agent/analyze',
      request_temp_cleanup_done: true,
      context_chars_before: contextCharsBefore,
      context_chars_after: contextCharsAfter,
    });
    requestPayload = null;
  }
};

const decideMessage = async ({
  requestId,
  threadId,
  message,
  userRole,
  availableActions,
  conversationHistory,
  fileContext,
  profileContext,
  agentContext,
}) => {
  const timer = startTimer();
  const routing = selectModel({ requiresVision: false });
  let requestPayload = null;
  let contextCharsBefore = 0;
  let contextCharsAfter = 0;
  logArchitecture('ai_decide_started', {
    requestId,
    threadId,
    endpoint: '/agent/decide',
    mode: 'text',
    promptType: 'agent_decide',
    messagePreview: messagePreview(message),
    ...routingLogFields(routing),
  });
  try {
    const trimmed = buildTrimmedAiPayload({
      requestId,
      threadId,
      endpoint: '/agent/decide',
      payload: {
        requestId,
        threadId,
        message,
        userRole,
        availableActions,
        conversationHistory,
        fileContext,
        profileContext,
        agentContext,
        modelRouting: aiRoutingPayload(routing),
      },
    });
    requestPayload = trimmed.payload;
    contextCharsBefore = trimmed.contextCharsBefore;
    contextCharsAfter = trimmed.contextCharsAfter;
    // Bounded timeout — see analyzeMessage. Prevents a hung :8000 from blocking the demo;
    // timeout → ECONNABORTED → existing catch/fallback. No change on the healthy path.
    const aiTimeoutMs = parseInt(process.env.AI_TEXT_TIMEOUT_MS || '15000', 10);
    const response = await axios.post(`${env.aiServiceUrl}/agent/decide`, requestPayload, { timeout: aiTimeoutMs });
    logArchitecture('ai_decide_finished', {
      requestId,
      threadId,
      endpoint: '/agent/decide',
      latencyMs: endTimer(timer),
      status: response.status,
      decision: response.data?.data?.decision,
      intent: response.data?.data?.intent,
      ...routingLogFields(routing),
    });
    return response.data;
  } catch (error) {
    logError('ai_decide_failed', error, {
      requestId,
      threadId,
      endpoint: '/agent/decide',
      latencyMs: endTimer(timer),
    });
    throw error;
  } finally {
    clearLargeTempReferences(requestPayload);
    logArchitecture('request_temp_cleanup_done', {
      requestId,
      threadId,
      endpoint: '/agent/decide',
      request_temp_cleanup_done: true,
      context_chars_before: contextCharsBefore,
      context_chars_after: contextCharsAfter,
    });
    requestPayload = null;
  }
};

const planIntent = async ({
  requestId,
  threadId,
  message,
  userRole,
  availableActions,
  conversationHistory,
  fileContext,
  profileContext,
  agentContext,
  threadContext = null,
  requestContext = null,
  agentPlan = null,
}) => {
  const timer = startTimer();
  const routing = selectModel({ requiresVision: false });
  let requestPayload = null;
  let contextCharsBefore = 0;
  let contextCharsAfter = 0;
  logArchitecture('intent_planner_started', {
    requestId,
    threadId,
    endpoint: '/agent/plan',
    mode: 'text',
    promptType: 'intent_planner',
    messageLength: String(message || '').length,
    ...routingLogFields(routing),
  });
  try {
    const trimmed = buildTrimmedAiPayload({
      requestId,
      threadId,
      endpoint: '/agent/plan',
      payload: {
        requestId,
        threadId,
        message,
        userRole,
        availableActions,
        conversationHistory,
        fileContext,
        profileContext,
        agentContext,
        modelRouting: aiRoutingPayload(routing),
        ...(threadContext ? { threadContext } : {}),
        ...(requestContext ? { requestContext } : {}),
        ...(agentPlan ? { agentPlan } : {}),
      },
    });
    requestPayload = trimmed.payload;
    contextCharsBefore = trimmed.contextCharsBefore;
    contextCharsAfter = trimmed.contextCharsAfter;
    // Bounded timeout: the Python planner is a legacy fallback and is NOT started in the
    // hosted-browser demo. Without this, a stale/hung :8000 could block the whole request.
    const planTimeoutMs = parseInt(process.env.PY_PLAN_TIMEOUT_MS || '5000', 10);
    const response = await axios.post(`${env.aiServiceUrl}/agent/plan`, requestPayload, { timeout: planTimeoutMs });
    logArchitecture('intent_planner_finished', {
      requestId,
      threadId,
      endpoint: '/agent/plan',
      latencyMs: endTimer(timer),
      status: response.status,
      intentType: response.data?.data?.intentType || response.data?.data?.mode,
      resourceNeed: response.data?.data?.resourceNeed ?? response.data?.data?.needsResourceSearch,
      resourceQueryLength: String(response.data?.data?.resourceQuery || response.data?.data?.resourceSearchQuery || '').length,
      userGoalLength: String(response.data?.data?.userGoal || '').length,
      missingFieldCount: Array.isArray(response.data?.data?.missingFields)
        ? response.data.data.missingFields.length
        : 0,
      ...routingLogFields(routing),
    });
    return response.data;
  } catch (error) {
    const detail = error?.response?.data?.detail || error?.message || '';
    const plannerError = new Error(detail || 'Intent planner failed');
    plannerError.cause = error;
    plannerError.isPlannerJsonParseFailure =
      error?.response?.status === 422 || /planner_json_parse_failed|valid JSON|JSON/i.test(detail);
    logError('intent_planner_failed', error, {
      requestId,
      threadId,
      endpoint: '/agent/plan',
      latencyMs: endTimer(timer),
      status: error?.response?.status || null,
      detail,
    });
    throw plannerError;
  } finally {
    clearLargeTempReferences(requestPayload);
    logArchitecture('request_temp_cleanup_done', {
      requestId,
      threadId,
      endpoint: '/agent/plan',
      request_temp_cleanup_done: true,
      context_chars_before: contextCharsBefore,
      context_chars_after: contextCharsAfter,
    });
    requestPayload = null;
  }
};

const analyzeVisionDocument = async ({
  requestId,
  threadId,
  message,
  userRole,
  conversationHistory,
  profileContext,
  agentContext,
  source,
  fileName,
  mimeType,
  pdfBase64,
  resourceJson,
  goal,
  maxPages,
  pageNumbers,
  detailMode,
}) => {
  const timer = startTimer();
  const routing = selectModel({ requiresVision: false });
  const isImagePayload = isImageMimeType(mimeType);
  const requestTimeoutMs = visionRequestTimeoutMsForMimeType(mimeType);
  let requestPayload = null;
  let contextCharsBefore = 0;
  let contextCharsAfter = 0;
  if (env.architectureLogsEnabled) {
    console.log('[ai-client] sending OCR extraction request:', {
      endpoint: '/agent/analyze-vision-document',
      source,
      fileType: isImagePayload ? 'image' : 'pdf',
      mimeType,
      payloadLength: pdfBase64 ? String(pdfBase64).length : 0,
      maxPages,
      pageNumbers,
      detailMode: Boolean(detailMode),
      selected_model: routing.selectedModel,
      vision_used: false,
      requestTimeoutMs,
    });
  }
  logArchitecture('ocr_document_request_sent', {
    requestId,
    threadId,
    endpoint: '/agent/analyze-vision-document',
    mode: 'ocr',
    selectedPages: pageNumbers,
    detailMode: Boolean(detailMode),
    pageCount: Array.isArray(pageNumbers) ? pageNumbers.length : 0,
    messagePreview: messagePreview(message),
    selected_model: routing.selectedModel,
    requestTimeoutMs,
    ...routingLogFields(routing),
  });

  let response;
  try {
    const trimmed = buildTrimmedAiPayload({
      requestId,
      threadId,
      endpoint: '/agent/analyze-vision-document',
      payload: {
        requestId,
        threadId,
        message,
        userRole,
        conversationHistory,
        profileContext,
        agentContext,
        resourceJson,
        modelRouting: aiRoutingPayload(routing),
      },
    });
    contextCharsBefore = trimmed.contextCharsBefore;
    contextCharsAfter = trimmed.contextCharsAfter;
      requestPayload = {
      ...trimmed.payload,
      source,
      fileName,
      mimeType,
      pdfBase64,
      ...(goal ? { goal } : {}),
      maxPages,
      pageNumbers,
      detailMode,
      resourceJson: compactResourceJson(trimmed.payload.resourceJson || resourceJson || {}, env.maxContextChars),
    };
    response = await axios.post(
      `${env.aiServiceUrl}/agent/analyze-vision-document`,
      requestPayload,
      {
        timeout: requestTimeoutMs,
      },
    );
    if (!response.data?.data) {
      logArchitecture('ocr_empty_response', {
        requestId,
        threadId,
        endpoint: '/agent/analyze-vision-document',
        ocr_empty_response: true,
        selected_model: routing.selectedModel,
        isImagePayload,
      });
    }
    if (env.architectureLogsEnabled) {
      console.log('[ai-client] OCR response received:', {
        status: response.status,
        hasData: Boolean(response.data?.data),
        selected_model: routing.selectedModel,
        vision_used: false,
        extractedFieldCount: Object.keys(response.data?.data?.extractedFields || {}).length,
      });
    }
    logArchitecture('ocr_document_response_received', {
      requestId,
      threadId,
      endpoint: '/agent/analyze-vision-document',
      latencyMs: endTimer(timer),
      status: response.status,
      hasData: Boolean(response.data?.data),
      ...routingLogFields(routing),
    });
    return response.data;
  } catch (error) {
    const detail = String(error?.response?.data?.detail || error?.message || '');
    const didTimeout =
      error?.code === 'ECONNABORTED' ||
      /timeout|timed?\s*out|vision_timeout/i.test(detail);
    if (didTimeout) {
      error.code = 'VISION_TIMEOUT';
      logArchitecture('ocr_timeout', {
        requestId,
        threadId,
        endpoint: '/agent/analyze-vision-document',
        ocr_timeout: true,
        timeoutMs: requestTimeoutMs,
        selected_model: routing.selectedModel,
        isImagePayload,
      });
    }
    if (/empty_ollama_response/i.test(detail)) {
      logArchitecture('ocr_empty_response', {
        requestId,
        threadId,
        endpoint: '/agent/analyze-vision-document',
        ocr_empty_response: true,
        selected_model: routing.selectedModel,
        isImagePayload,
      });
    }
    logError('pdf_vision_request_failed', error, {
      requestId,
      threadId,
      endpoint: '/agent/analyze-vision-document',
      latencyMs: endTimer(timer),
      ...routingLogFields(routing),
    });
    throw error;
  } finally {
    if (requestPayload) {
      requestPayload.pdfBase64 = '';
      requestPayload.resourceJson = null;
      requestPayload.conversationHistory = [];
      requestPayload.agentContext = null;
    }
    logArchitecture('request_temp_cleanup_done', {
      requestId,
      threadId,
      endpoint: '/agent/analyze-vision-document',
      request_temp_cleanup_done: true,
      context_chars_before: contextCharsBefore,
      context_chars_after: contextCharsAfter,
    });
    requestPayload = null;
    response = null;
  }
};

const rerankResources = async ({ requestId, threadId, message, candidates }) => {
  const timer = startTimer();
  const routing = selectModel({ requiresVision: false });
  logArchitecture('resource_reranker_started', {
    requestId,
    threadId,
    endpoint: '/agent/rerank-resources',
    mode: 'text',
    candidateCount: candidates?.length ?? 0,
    ...routingLogFields(routing),
  });
  try {
    const response = await axios.post(`${env.aiServiceUrl}/agent/rerank-resources`, {
      requestId,
      threadId,
      message,
      candidates: candidates || [],
      modelRouting: aiRoutingPayload(routing),
    });
    logArchitecture('resource_reranker_finished', {
      requestId,
      threadId,
      endpoint: '/agent/rerank-resources',
      latencyMs: endTimer(timer),
      status: response.status,
      chosenId: response.data?.data?.chosenId,
      ...routingLogFields(routing),
    });
    return response.data;
  } catch (error) {
    logError('resource_reranker_failed', error, {
      requestId,
      threadId,
      endpoint: '/agent/rerank-resources',
      latencyMs: endTimer(timer),
    });
    throw error;
  }
};

// ⚠️ NOT PART OF THE TRUSTED BANKING ANSWER PATH — DO NOT WIRE INTO RESOURCE QA. ⚠️
// This calls /agent/answer-from-descriptions, which answers FREELY from full catalog descriptions.
// The production flow uses descriptions for retrieval/selection ONLY; banking facts come from the
// trusted file + fact extraction + reformulation + deterministic fallback. This export is retained
// for diagnostics/experiments only and is intentionally NOT imported by the chat controller.
const answerFromDescriptions = async ({ requestId, threadId, message, candidates }) => {
  const timer = startTimer();
  const routing = selectModel({ requiresVision: false });
  logArchitecture('description_qa_started', {
    requestId,
    threadId,
    endpoint: '/agent/answer-from-descriptions',
    mode: 'text',
    candidateCount: candidates?.length ?? 0,
    ...routingLogFields(routing),
  });
  try {
    const response = await axios.post(`${env.aiServiceUrl}/agent/answer-from-descriptions`, {
      requestId,
      threadId,
      message,
      candidates: candidates || [],
      modelRouting: aiRoutingPayload(routing),
    });
    logArchitecture('description_qa_finished', {
      requestId,
      threadId,
      endpoint: '/agent/answer-from-descriptions',
      latencyMs: endTimer(timer),
      status: response.status,
      selectedResourceId: response.data?.data?.selectedResourceId,
      answerableFromDescription: response.data?.data?.answerableFromDescription,
      ...routingLogFields(routing),
    });
    return response.data;
  } catch (error) {
    logError('description_qa_failed', error, {
      requestId,
      threadId,
      endpoint: '/agent/answer-from-descriptions',
      latencyMs: endTimer(timer),
    });
    throw error;
  }
};

// Reformulation: the model receives ONLY pre-extracted facts (never the full description), so it
// cannot mix rows. Used by the resource_qa description-analysis path for natural wording.
const reformulateAnswer = async ({ requestId, threadId, userQuestion, selectedResourceId, extractedFacts }) => {
  const timer = startTimer();
  const routing = selectModel({ requiresVision: false });
  logArchitecture('reformulate_answer_started', {
    requestId,
    threadId,
    endpoint: '/agent/reformulate-answer',
    mode: 'text',
    ...routingLogFields(routing),
  });
  try {
    const response = await axios.post(`${env.aiServiceUrl}/agent/reformulate-answer`, {
      requestId,
      threadId,
      userQuestion,
      selectedResourceId,
      extractedFacts: extractedFacts || {},
      modelRouting: aiRoutingPayload(routing),
    });
    logArchitecture('reformulate_answer_finished', {
      requestId,
      threadId,
      endpoint: '/agent/reformulate-answer',
      latencyMs: endTimer(timer),
      status: response.status,
      ...routingLogFields(routing),
    });
    return response.data;
  } catch (error) {
    logError('reformulate_answer_failed', error, {
      requestId,
      threadId,
      endpoint: '/agent/reformulate-answer',
      latencyMs: endTimer(timer),
    });
    throw error;
  }
};

module.exports = {
  analyzeMessage,
  analyzeVisionDocument,
  answerFromDescriptions,
  decideMessage,
  planIntent,
  reformulateAnswer,
  rerankResources,
  visionRequestTimeoutMsForMimeType,
};
