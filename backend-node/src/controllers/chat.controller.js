const {
  getConnectedActionsByRole,
} = require('../actions/actionRegistry');
const { prepareAction } = require('../services/actionPreparation.service');
const { analyzeMessage } = require('../services/aiClient.service');
const { createAuditLog } = require('../services/auditLog.service');
const { buildFileContext } = require('../services/fileContext.service');
const { generateFile } = require('../services/generatedFile.service');

const toAiAction = (action) => ({
  name: action.name,
  riskLevel: action.riskLevel,
  requiredFields: action.requiredFields,
});

const getAvailableAiActions = (role) =>
  getConnectedActionsByRole(role).map(toAiAction);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fieldLabels = {
  accountId: 'Account',
  amount: 'Amount',
  beneficiaryId: 'Beneficiary',
  billReference: 'Bill reference',
  branch: 'Branch name',
  category: 'Complaint category',
  date: 'Preferred date',
  description: 'Description',
  documentType: 'Document type',
  period: 'Period',
  sourceAccountId: 'Source account',
  time: 'Preferred time slot',
};

const formatFieldLabel = (field) =>
  fieldLabels[field] ||
  String(field || '').replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase());

const createMissingFieldsMessage = (missingFields, actionName) => {
  const titleByAction = {
    book_appointment: 'To book your appointment, I need a few details:',
    generate_document: 'To generate your document, I need a few details:',
    create_complaint: 'To create your complaint, I need a few details:',
    pay_bill: 'To prepare this bill payment, I need a few details:',
    check_balance: 'To check your balance, I need one detail:',
    make_transfer: 'To prepare this transfer, I need a few details:',
  };
  const fieldLines = missingFields.map((field) => `- ${formatFieldLabel(field)}`).join('\n');

  return `${titleByAction[actionName] || 'I need a few details before I can continue:'}\n\n**Required information**\n${fieldLines}\n\nChoose one of the options below or type your answer.`;
};

const mergePayloadWithExtractedFields = ({ extractedFields = {}, payload = {} }) => ({
  ...extractedFields,
  ...payload,
});

// ---------------------------------------------------------------------------
// Follow-up context memory
// ---------------------------------------------------------------------------
// Short confirmation phrases that mean "continue the action we were discussing"
// rather than starting a brand-new request. Matched exactly (after trimming
// punctuation / trailing politeness words) so unrelated sentences never misfire.
const FOLLOW_UP_PHRASES = new Set([
  'pay it',
  'pay this',
  'pay this bill',
  'pay the bill',
  'pay my bill',
  'continue',
  'proceed',
  'proceed with it',
  'do it',
  'go ahead',
  'create it',
  'book it',
  'generate it',
  'download it',
  'send it',
  'confirm it',
  'execute it',
  'do it now',
  'yes do it',
  'ok do it',
]);

const isFollowUpMessage = (message) => {
  const normalized = String(message || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, '')
    .replace(/\s+(please|now|thanks|thank you)$/g, '')
    .trim();

  return FOLLOW_UP_PHRASES.has(normalized);
};

// Resolves which banking action a follow-up phrase refers to, using the
// context the frontend carried over from earlier messages.
const inferActionFromContext = (agentContext = {}) => {
  if (agentContext.suggestedAction) {
    return agentContext.suggestedAction;
  }

  const fields = agentContext.extractedFields || {};

  if (fields.billReference || fields.provider) return 'pay_bill';
  if (fields.beneficiaryId) return 'make_transfer';
  if (fields.documentType || fields.period) return 'generate_document';
  if (fields.category) return 'create_complaint';
  if (fields.branch || fields.appointmentDate) return 'book_appointment';

  return null;
};

const buildFollowUpAi = (actionName, agentContext = {}) => ({
  source: 'follow_up_context',
  language: 'english',
  agentMode: 'banking_action',
  intent: actionName,
  actionName,
  confidence: 0.9,
  missingFields: [],
  extractedFields: agentContext.extractedFields || {},
  requiredTool: 'connector_action',
  toolInput: {},
  assistantMessage: 'Continuing with the details from our earlier messages.',
});

const parseConversationHistory = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const parseProfileContext = (value) => {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const sanitizeProfileContext = (profileContext = {}) => ({
  fullName: String(profileContext.fullName || '').trim(),
  email: String(profileContext.email || '').trim(),
  phoneNumber: String(profileContext.phoneNumber || '').trim(),
  rib: String(profileContext.rib || '').trim(),
});

const buildSafeFileAttachments = (fileContext) =>
  fileContext.files.map((file) => ({
    originalName: file.originalName,
    mimeType: file.mimeType,
    size: file.size,
    extractionStatus: file.extractionStatus,
  }));

const buildFileFallbackMessage = (fileContext) => {
  if (!fileContext.files.length) return null;
  if (fileContext.combinedText) return null;
  return (
    'I received the file, but I could not extract readable text from it. ' +
    'Please provide the missing details manually.'
  );
};

const createFileChatAuditLog = ({ req, fileContext }) =>
  createAuditLog({
    userId: req.user.id,
    role: req.user.role,
    status: 'chat_files_received',
    apiEndpoint: '/chat/message-with-files',
    metadata: {
      filesAttached: true,
      fileCount: fileContext.files.length,
      extractedContextUsed: Boolean(fileContext.combinedText),
    },
    result: {
      files: buildSafeFileAttachments(fileContext),
    },
  });

// Summarise conversation history as plain text for file generation
const buildConversationSummary = (conversationHistory = []) => {
  if (!conversationHistory.length) {
    return 'No conversation history available.';
  }

  return conversationHistory
    .slice(-20)
    .map((msg) => {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      return `${role}: ${msg.content}`;
    })
    .join('\n\n');
};

// ---------------------------------------------------------------------------
// Agent-mode dispatch helpers
// ---------------------------------------------------------------------------

const handleInformationalMode = (res, ai, fileContext) => {
  const fileData = fileContext
    ? {
        fileContext: {
          files: buildSafeFileAttachments(fileContext),
          extractedContextUsed: Boolean(fileContext.combinedText),
        },
      }
    : {};

  return res.json({
    success: true,
    status: 'answered',
    agentMode: ai.agentMode || 'informational_answer',
    assistantMessage: ai.assistantMessage,
    data: { ai, ...fileData },
  });
};

const handleFileAnalysisMode = (res, ai, fileContext) => {
  const fileData = fileContext
    ? {
        fileContext: {
          files: buildSafeFileAttachments(fileContext),
          extractedContextUsed: Boolean(fileContext.combinedText),
        },
      }
    : {};

  return res.json({
    success: true,
    status: 'file_analyzed',
    agentMode: 'file_analysis',
    assistantMessage: ai.assistantMessage,
    data: { ai, ...fileData },
  });
};

const handleFileGenerationMode = async (
  res,
  req,
  ai,
  conversationHistory,
  fileContext,
) => {
  const toolInput = ai.toolInput || {};
  const fileType = toolInput.fileType || 'txt';
  const title = toolInput.title || 'Generated File';

  const content =
    toolInput.content ||
    buildConversationSummary(conversationHistory);

  const fileData = fileContext
    ? {
        fileContext: {
          files: buildSafeFileAttachments(fileContext),
          extractedContextUsed: Boolean(fileContext.combinedText),
        },
      }
    : {};

  const fileResult = await generateFile({
    fileType,
    title,
    content,
    data: toolInput.data || null,
  });

  createAuditLog({
    userId: req.user.id,
    role: req.user.role,
    status: 'file_generated',
    apiEndpoint: req.originalUrl || '/chat/message',
    metadata: {
      fileGenerated: true,
      fileType: fileResult.fileType,
      fileName: fileResult.fileName,
    },
    result: { fileId: fileResult.fileId, downloadUrl: fileResult.downloadUrl },
  });

  return res.json({
    success: true,
    status: 'file_generated',
    agentMode: 'file_generation',
    assistantMessage: `I've generated your ${fileResult.fileType.toUpperCase()} file. Use the download button below.`,
    data: {
      ai,
      generatedFile: {
        fileId: fileResult.fileId,
        fileName: fileResult.fileName,
        fileType: fileResult.fileType,
        title: fileResult.title,
        downloadUrl: fileResult.downloadUrl,
      },
      ...fileData,
    },
  });
};

const handleBankingActionMode = (res, req, ai, finalPayload, fileContext) => {
  const preparation = prepareAction({
    actionName: ai.actionName,
    payload: finalPayload,
    user: req.user,
  });

  const fileData = fileContext
    ? {
        fileContext: {
          files: buildSafeFileAttachments(fileContext),
          extractedContextUsed: Boolean(fileContext.combinedText),
        },
      }
    : {};

  if (preparation.body.status === 'missing_fields') {
    return res.json({
      success: true,
      status: 'missing_fields',
      agentMode: 'banking_action',
      assistantMessage:
        ai.assistantMessage ||
        createMissingFieldsMessage(preparation.body.missingFields, ai.actionName),
      data: {
        ai,
        finalPayload,
        missingFields: preparation.body.missingFields,
        ...fileData,
      },
    });
  }

  if (preparation.body.status === 'not_connected') {
    return res.json({
      success: true,
      status: 'not_connected',
      agentMode: 'banking_action',
      assistantMessage:
        'I understood your request, but this action is not connected in the current MVP.',
      data: { ai, finalPayload, actionName: ai.actionName, ...fileData },
    });
  }

  if (preparation.body.status === 'prepared') {
    return res.json({
      success: true,
      status: 'action_prepared',
      agentMode: 'banking_action',
      assistantMessage: fileContext
        ? '**Review this banking action**\n\nI prepared this action using the uploaded file context. Please review the summary before continuing.'
        : '**Review this banking action**\n\nI prepared this action. Please review the summary before continuing.',
      data: { ai, finalPayload, preparation: preparation.body.data, ...fileData },
    });
  }

  return res.status(preparation.httpStatus).json({
    ...preparation.body,
    data: { ...(preparation.body.data || {}), ...fileData },
  });
};

// ---------------------------------------------------------------------------
// Core dispatch — shared by both message handlers
// ---------------------------------------------------------------------------

const dispatchByAgentMode = async ({
  res,
  req,
  ai,
  message,
  payload = {},
  conversationHistory = [],
  fileContext = null,
  fileFallbackMessage = null,
}) => {
  const agentMode = ai.agentMode || 'informational_answer';

  // file_analysis
  if (agentMode === 'file_analysis') {
    return handleFileAnalysisMode(res, ai, fileContext);
  }

  // file_generation
  if (agentMode === 'file_generation') {
    return handleFileGenerationMode(res, req, ai, conversationHistory, fileContext);
  }

  // banking_action
  if (agentMode === 'banking_action' && ai.actionName) {
    const finalPayload = mergePayloadWithExtractedFields({
      extractedFields: ai.extractedFields || {},
      payload,
    });
    return handleBankingActionMode(res, req, ai, finalPayload, fileContext);
  }

  // unsupported / informational_answer / unknown (fallback)
  if (fileFallbackMessage) {
    ai = { ...ai, assistantMessage: fileFallbackMessage };
  }
  return handleInformationalMode(res, ai, fileContext);
};

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

const analyzeChatMessage = async (req, res) => {
  const { message, conversationHistory = [] } = req.body;

  if (!message) {
    return res.status(400).json({ success: false, message: 'message is required' });
  }

  try {
    const availableActions = getAvailableAiActions(req.user.role);
    const aiResponse = await analyzeMessage({
      message,
      userRole: req.user.role,
      availableActions,
      conversationHistory,
    });

    return res.json({
      success: true,
      message: 'Message analyzed successfully',
      data: aiResponse.data,
    });
  } catch {
    return res.status(503).json({
      success: false,
      message: 'AI service is currently unavailable. Please try again later.',
    });
  }
};

const handleChatMessage = async (req, res) => {
  const {
    message,
    payload = {},
    conversationHistory = [],
    profileContext = {},
    agentContext = {},
  } = req.body;

  if (!message) {
    return res.status(400).json({ success: false, message: 'message is required' });
  }

  try {
    // Follow-up commands ("pay it", "continue", ...) reuse the context the
    // assistant extracted earlier instead of being re-analyzed from scratch.
    if (isFollowUpMessage(message)) {
      const followUpAction = inferActionFromContext(agentContext);

      if (followUpAction) {
        console.log('[chat/message] follow-up resolved to action:', followUpAction);
        return await dispatchByAgentMode({
          res,
          req,
          ai: buildFollowUpAi(followUpAction, agentContext),
          message,
          payload,
          conversationHistory,
          fileContext: null,
        });
      }
    }

    const aiResponse = await analyzeMessage({
      message,
      userRole: req.user.role,
      availableActions: getAvailableAiActions(req.user.role),
      conversationHistory,
      profileContext: sanitizeProfileContext(profileContext),
    });

    const ai = aiResponse.data;
    console.log('[chat/message] AI agentMode:', ai.agentMode);
    console.log('[chat/message] AI intent:', ai.intent);
    console.log('[chat/message] AI actionName:', ai.actionName);

    return await dispatchByAgentMode({
      res,
      req,
      ai,
      message,
      payload,
      conversationHistory,
      fileContext: null,
    });
  } catch {
    return res.status(503).json({
      success: false,
      message: 'AI service is currently unavailable. Please try again later.',
    });
  }
};

const handleChatMessageWithFiles = async (req, res) => {
  const message =
    req.body.message?.trim() || 'Please review the uploaded file attachments.';
  const payload = {};
  const conversationHistory = parseConversationHistory(req.body.conversationHistory);
  const profileContext = sanitizeProfileContext(
    parseProfileContext(req.body.profileContext),
  );
  const uploadedFiles = req.files || [];

  console.log('[chat/with-files] message-with-files called');
  console.log('[chat/with-files] Uploaded files count:', uploadedFiles.length);
  console.log('[chat/with-files] Uploaded files:', uploadedFiles.map((f) => f.originalname));

  if (!message && !uploadedFiles.length) {
    return res.status(400).json({
      success: false,
      message: 'message or files are required',
    });
  }

  try {
    const fileContext = await buildFileContext(uploadedFiles);
    createFileChatAuditLog({ req, fileContext });

    console.log('[chat/with-files] fileContext.files:', fileContext.files.length);
    console.log('[chat/with-files] fileContext.hasUploadedFiles:', fileContext.hasUploadedFiles);
    console.log('[chat/with-files] fileContext.combinedText length:', fileContext.combinedText?.length || 0);

    console.log('[chat/with-files] Sending to AI:', {
      hasUploadedFiles: fileContext.hasUploadedFiles,
      fileCount: fileContext.files.length,
      combinedTextLength: fileContext.combinedText?.length || 0,
    });

    const aiResponse = await analyzeMessage({
      message,
      userRole: req.user.role,
      availableActions: getAvailableAiActions(req.user.role),
      conversationHistory,
      fileContext,
      profileContext,
    });

    let ai = aiResponse.data;
    console.log('[chat/with-files] AI agentMode:', ai.agentMode);
    console.log('[chat/with-files] AI intent:', ai.intent);
    console.log('[chat/with-files] AI actionName:', ai.actionName);
    console.log('[chat/with-files] AI assistantMessage:', ai.assistantMessage);

    // Safeguard: AI must never tell the user to upload a file they already uploaded.
    if (fileContext.hasUploadedFiles && ai.assistantMessage) {
      const lower = ai.assistantMessage.toLowerCase();
      if (
        lower.includes('please upload') ||
        lower.includes('upload the file') ||
        lower.includes('upload a file') ||
        lower.includes('upload your file')
      ) {
        console.log('[chat/with-files] SAFEGUARD triggered — overriding bad AI message');
        ai = {
          ...ai,
          agentMode: 'file_analysis',
          assistantMessage: fileContext.combinedText
            ? `I read the uploaded file. Here is what I found:\n\n${fileContext.combinedText.slice(0, 500)}`
            : 'I received the uploaded file, but I could not extract readable text from it.',
        };
      }
    }

    const fileFallbackMessage = buildFileFallbackMessage(fileContext);

    return await dispatchByAgentMode({
      res,
      req,
      ai,
      message,
      payload,
      conversationHistory,
      fileContext,
      fileFallbackMessage,
    });
  } catch {
    return res.status(503).json({
      success: false,
      message: 'AI service is currently unavailable. Please try again later.',
    });
  }
};

module.exports = {
  analyzeChatMessage,
  handleChatMessage,
  handleChatMessageWithFiles,
};
