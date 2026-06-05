const axios = require('axios');
const env = require('../config/env');
const {
  endTimer,
  logArchitecture,
  logError,
  messagePreview,
  startTimer,
} = require('./architectureLogger.service');

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
  logArchitecture('ai_text_flow_started', {
    requestId,
    threadId,
    endpoint: '/agent/analyze',
    mode: 'text',
    promptType: 'agent_analyze',
    messagePreview: messagePreview(message),
  });
  try {
    const response = await axios.post(`${env.aiServiceUrl}/agent/analyze`, {
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
    });
    logArchitecture('ai_text_flow_finished', {
      requestId,
      threadId,
      endpoint: '/agent/analyze',
      latencyMs: endTimer(timer),
      status: response.status,
      responseIntent: response.data?.data?.intent,
      responseStyle: response.data?.data?.responseStyle,
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
  logArchitecture('ai_decide_started', {
    requestId,
    threadId,
    endpoint: '/agent/decide',
    mode: 'text',
    promptType: 'agent_decide',
    messagePreview: messagePreview(message),
  });
  try {
    const response = await axios.post(`${env.aiServiceUrl}/agent/decide`, {
      requestId,
      threadId,
      message,
      userRole,
      availableActions,
      conversationHistory,
      fileContext,
      profileContext,
      agentContext,
    });
    logArchitecture('ai_decide_finished', {
      requestId,
      threadId,
      endpoint: '/agent/decide',
      latencyMs: endTimer(timer),
      status: response.status,
      decision: response.data?.data?.decision,
      intent: response.data?.data?.intent,
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
}) => {
  const timer = startTimer();
  logArchitecture('intent_planner_started', {
    requestId,
    threadId,
    endpoint: '/agent/plan',
    mode: 'text',
    promptType: 'intent_planner',
    messagePreview: messagePreview(message),
  });
  try {
    const response = await axios.post(`${env.aiServiceUrl}/agent/plan`, {
      requestId,
      threadId,
      message,
      userRole,
      availableActions,
      conversationHistory,
      fileContext,
      profileContext,
      agentContext,
    });
    logArchitecture('intent_planner_finished', {
      requestId,
      threadId,
      endpoint: '/agent/plan',
      latencyMs: endTimer(timer),
      status: response.status,
      mode: response.data?.data?.mode,
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
  maxPages,
  pageNumbers,
  detailMode,
}) => {
  const timer = startTimer();
  console.log('[ai-client] sending PDF vision request:', {
    endpoint: '/agent/analyze-vision-document',
    source,
    mimeType,
    pdfBase64Length: pdfBase64 ? String(pdfBase64).length : 0,
    maxPages,
    pageNumbers,
    detailMode: Boolean(detailMode),
    modelProvider: 'python_ai_service',
  });
  logArchitecture('pdf_vision_request_sent', {
    requestId,
    threadId,
    endpoint: '/agent/analyze-vision-document',
    mode: 'vision',
    selectedPages: pageNumbers,
    detailMode: Boolean(detailMode),
    pageCount: Array.isArray(pageNumbers) ? pageNumbers.length : 0,
    messagePreview: messagePreview(message),
  });

  let response;
  try {
    response = await axios.post(
      `${env.aiServiceUrl}/agent/analyze-vision-document`,
      {
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
        maxPages,
        pageNumbers,
        detailMode,
      },
      {
        timeout: 180000,
      },
    );
  } catch (error) {
    logError('pdf_vision_request_failed', error, {
      requestId,
      threadId,
      endpoint: '/agent/analyze-vision-document',
      latencyMs: endTimer(timer),
    });
    throw error;
  }

  console.log('[ai-client] PDF vision response received:', {
    status: response.status,
    hasData: Boolean(response.data?.data),
  });
  logArchitecture('pdf_vision_response_received', {
    requestId,
    threadId,
    endpoint: '/agent/analyze-vision-document',
    latencyMs: endTimer(timer),
    status: response.status,
    hasData: Boolean(response.data?.data),
  });

  return response.data;
};

module.exports = {
  analyzeMessage,
  analyzeVisionDocument,
  decideMessage,
  planIntent,
};
