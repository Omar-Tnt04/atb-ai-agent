const {
  getConnectedActionsByRole,
} = require('../actions/actionRegistry');
const { executeAction } = require('../services/actionExecution.service');
const { prepareAction } = require('../services/actionPreparation.service');
const { analyzeMessage } = require('../services/aiClient.service');
const { createAuditLog } = require('../services/auditLog.service');
const { buildFileContext } = require('../services/fileContext.service');
const { generateFile } = require('../services/generatedFile.service');
const { findMatchingResource } = require('../services/resourceCatalog.service');
const { resolveResource } = require('../services/resourceResolver.service');

const RESOURCE_JSON_URL_PATTERN =
  /http:\/\/localhost\/atb-resources\/json\/[^\s<>"')]+/i;
const RESOURCE_TEXT_PREVIEW_LIMIT = 2000;

const toAiAction = (action) => ({
  name: action.name,
  riskLevel: action.riskLevel,
  requiredFields: action.requiredFields,
});

const getAvailableAiActions = (role) =>
  getConnectedActionsByRole(role).map(toAiAction);

const buildResourceTextPreview = (value = '') => {
  if (!value || value.length <= RESOURCE_TEXT_PREVIEW_LIMIT) {
    return value || '';
  }

  return `${value.slice(0, RESOURCE_TEXT_PREVIEW_LIMIT)}\n[Preview truncated]`;
};

const extractResourceJsonUrl = (value) => {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    const match = value.match(RESOURCE_JSON_URL_PATTERN);
    return match ? match[0] : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nestedUrl = extractResourceJsonUrl(item);
      if (nestedUrl) return nestedUrl;
    }
    return null;
  }

  if (typeof value === 'object') {
    for (const item of Object.values(value)) {
      const nestedUrl = extractResourceJsonUrl(item);
      if (nestedUrl) return nestedUrl;
    }
  }

  return null;
};

const buildResolvedResourceContext = async (message) => {
  let resourceUrl = extractResourceJsonUrl(message);
  let matchedResource = null;

  if (!resourceUrl) {
    matchedResource = await findMatchingResource(message).catch(() => null);
    resourceUrl = matchedResource?.url || null;
  }

  if (!resourceUrl) {
    return null;
  }

  try {
    const resolved = await resolveResource(resourceUrl);
    return {
      resourceUrl,
      resourceJson: resolved.resourceJson,
      fileUrl: resolved.fileUrl,
      fileTextPreview: buildResourceTextPreview(resolved.fileText),
      fileText: resolved.fileText || '',
      contentType: resolved.contentType,
      extractionStatus: resolved.extractionStatus,
      ...(matchedResource
        ? {
            matchedResource: {
              fileName: matchedResource.fileName,
              score: matchedResource.score,
              resourceType: matchedResource.metadata?.resourceType,
              title: matchedResource.metadata?.title,
            },
          }
        : {}),
      ...(resolved.extractionError
        ? { extractionError: resolved.extractionError }
        : {}),
    };
  } catch (error) {
    return {
      resourceUrl,
      resourceJson: null,
      fileUrl: null,
      fileTextPreview: '',
      fileText: '',
      contentType: null,
      extractionStatus: 'failed',
      extractionError: error.message || 'Resource resolution failed',
    };
  }
};

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
  currency: 'Currency',
  reference: 'Complaint reference',
  sourceAccountId: 'Source account',
  time: 'Preferred time slot',
};

const formatFieldLabel = (field) =>
  fieldLabels[field] ||
  String(field || '').replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase());

const fieldHints = {
  accountId: ['the account ID', 'acc_001'],
  sourceAccountId: ['the account to use', 'acc_001'],
  billReference: ['the bill reference', 'STEG-2026-001'],
  amount: ['the amount', '300'],
  beneficiaryId: ['the beneficiary', 'ben_001'],
  branch: ['the branch', 'Tunis Centre'],
  date: ['the date', '2026-05-21'],
  time: ['a time', '10:00'],
  documentType: ['the document type', 'statement'],
  period: ['the period', 'April 2026'],
  category: ['the complaint category', 'failed transfer'],
  description: ['a short description of the issue', null],
  reference: ['the complaint reference', 'CMP-DEMO-2026-000001'],
};

const describeMissingField = (field) => {
  const [phrase, example] = fieldHints[field] || [
    formatFieldLabel(field).toLowerCase(),
    null,
  ];
  return example ? `${phrase} (for example \`${example}\`)` : phrase;
};

const createMissingFieldsMessage = (missingFields, actionName) => {
  const titleByAction = {
    book_appointment: 'I can book the appointment, but',
    generate_document: 'I can generate the document, but',
    create_complaint: 'I can prepare the complaint, but',
    check_complaint_status: 'I can check the complaint status, but',
    pay_bill: 'I can prepare the bill payment, but',
    check_balance: 'I can check the balance, but',
    make_transfer: 'I can prepare the transfer, but',
  };
  const intro = titleByAction[actionName] || 'I can help, but';
  const displayedFields = missingFields.slice(0, 2).map(describeMissingField);

  if (displayedFields.length === 1) {
    return `${intro} I still need ${displayedFields[0]}.`;
  }

  return `${intro} I still need ${displayedFields.join(' and ')}.`;
};

const mergePayloadWithExtractedFields = ({ extractedFields = {}, payload = {} }) => ({
  ...extractedFields,
  ...payload,
});

const parseSummaryItems = (summary = []) =>
  summary.reduce((items, item) => {
    const [label, ...valueParts] = String(item || '').split(':');
    if (!label || valueParts.length === 0) return items;

    return {
      ...items,
      [label.trim().toLowerCase()]: valueParts.join(':').trim(),
    };
  }, {});

// Renders a compact Markdown table from [label, value] rows, skipping empties.
const buildDetailsTable = (rows) => {
  const usableRows = rows.filter(([, value]) => value !== undefined && value !== null && value !== '');

  if (!usableRows.length) {
    return '';
  }

  return [
    '| Field | Value |',
    '|---|---|',
    ...usableRows.map(([label, value]) => `| ${label} | ${value} |`),
  ].join('\n');
};

const formatMoney = (amount, currency = 'TND') => {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount)) {
    return amount ? `${amount} ${currency || 'TND'}` : '';
  }
  return `${numericAmount.toFixed(3)} ${currency || 'TND'}`;
};

const formatStatus = (value = '') => {
  const text = String(value || 'Active').trim();
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : 'Active';
};

const PREPARED_ACTION_CONFIG = {
  pay_bill: {
    intro: 'I can prepare this bill payment.',
    rows: (summary, payload) => [
      ['Provider', summary.provider || payload.provider],
      ['Reference', summary['bill reference'] || payload.billReference],
      ['Amount', summary.amount],
      ['From account', summary.account || payload.sourceAccountId],
    ],
  },
  make_transfer: {
    intro: 'I can prepare this transfer.',
    rows: (summary, payload) => [
      ['Amount', summary.amount],
      ['Beneficiary', summary.beneficiary || payload.beneficiaryId],
      ['From account', summary.account || payload.sourceAccountId],
    ],
  },
  create_complaint: {
    intro: 'I can prepare this complaint.',
    fileIntro: 'I can prepare this complaint from the document.',
    confirmText: 'Please confirm before I submit it.',
    rows: (summary, payload) => [
      ['Category', payload.category],
      ['Description', payload.description],
      ['Related account', payload.sourceAccountId || payload.relatedAccountId],
      ['Beneficiary', payload.beneficiaryId],
      [
        'Amount',
        payload.amount !== undefined && payload.amount !== null
          ? `${payload.amount} ${payload.currency || 'TND'}`
          : '',
      ],
      [
        'Reference',
        payload.relatedReference ||
          payload.transferReference ||
          payload.transactionReference ||
          payload.reference,
      ],
    ],
  },
  book_appointment: {
    intro: 'I can book this appointment.',
    rows: (summary, payload) => [
      ['Branch', payload.branch],
      ['Date', payload.date],
      ['Time', payload.time],
    ],
  },
  generate_document: {
    intro: 'I can generate this document.',
    rows: (summary, payload) => [
      ['Document type', payload.documentType],
      ['Period', payload.period],
      ['Account', summary.account || payload.accountId],
    ],
  },
  check_balance: {
    intro: 'I can check this balance.',
    rows: (summary, payload) => [['Account', summary.account || payload.accountId]],
  },
};

const buildPreparedActionMessage = (preparation = {}, options = {}) => {
  const summary = parseSummaryItems(preparation.summary || []);
  const payload = preparation.payload || {};
  const config = PREPARED_ACTION_CONFIG[preparation.actionName];

  if (config) {
    const table = buildDetailsTable(config.rows(summary, payload));
    const intro = options.fromFile && config.fileIntro ? config.fileIntro : config.intro;
    const confirmText = config.confirmText || 'Please confirm before I continue.';

    return [intro, '', table, '', confirmText]
      .filter((line) => line !== null)
      .join('\n');
  }

  const table = buildDetailsTable(
    (preparation.summary || []).map((item) => {
      const [label, ...rest] = String(item).split(':');
      return [label.trim(), rest.join(':').trim()];
    }),
  );

  return ['I can continue with this.', '', table, '', 'Please confirm before I continue.']
    .filter((line) => line !== null)
    .join('\n');
};

const buildBalanceResultMessage = (data = {}) => {
  const account = data.account || {};
  return [
    `Your balance is **${formatMoney(account.balance, account.currency)}**.`,
    '',
    `Account: ${account.accountNumber || account.id || 'not found'}`,
    `Status: ${formatStatus(account.status)}`,
  ].join('\n');
};

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
  'confirm',
  'proceed',
  'please proceed',
  'proceed with it',
  'do it',
  'go ahead',
  'create it',
  'book it',
  'generate it',
  'download it',
  'submit it',
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

const parseAgentContext = (value) => {
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

const hasFieldValue = (value) =>
  value !== undefined &&
  value !== null &&
  !(typeof value === 'string' && value.trim() === '');

const PAY_BILL_REQUIRED_FIELDS = [
  'provider',
  'billReference',
  'amount',
  'sourceAccountId',
];

const getPayBillMissingFields = (payload = {}) =>
  PAY_BILL_REQUIRED_FIELDS.filter((field) => {
    if (field === 'sourceAccountId') {
      return !hasFieldValue(payload.sourceAccountId) && !hasFieldValue(payload.accountId);
    }

    return !hasFieldValue(payload[field]);
  });

const hasVisualOrOcrFileContext = (fileContext) => {
  if (!fileContext?.files?.length) return false;

  return fileContext.files.some((file) => {
    const mimeType = String(file.mimeType || '').toLowerCase();
    const name = String(file.originalName || '').toLowerCase();
    return (
      file.isVisualInput ||
      file.isOcrDerived ||
      file.isScannedOrImageBased ||
      file.extractionStatus === 'ocr_extracted' ||
      file.extractionStatus === 'ocr_empty' ||
      mimeType.startsWith('image/') ||
      name.endsWith('.png') ||
      name.endsWith('.jpg') ||
      name.endsWith('.jpeg') ||
      name.endsWith('.webp')
    );
  });
};

const hasOcrExtractedFile = (fileContext) =>
  Boolean(
    fileContext?.files?.some(
      (file) => file.isOcrDerived || file.extractionStatus === 'ocr_extracted',
    ),
  );

const hasVisualOrOcrContext = (fileContext, payload = {}) =>
  hasVisualOrOcrFileContext(fileContext) ||
  payload._sourceIsVisual === true ||
  payload._sourceExtractionStatus === 'ocr_extracted' ||
  payload._sourceExtractionStatus === 'ocr_empty';

const buildOcrPaymentMissingFieldsMessage = (missingFields, payload = {}) => {
  const onlySourceAccountMissing =
    missingFields.length === 1 &&
    missingFields[0] === 'sourceAccountId' &&
    hasFieldValue(payload.provider) &&
    hasFieldValue(payload.billReference) &&
    hasFieldValue(payload.amount);

  if (onlySourceAccountMissing) {
    return 'I can read the bill, but the source account is unclear. Which account should I use?';
  }

  const labels = missingFields.map((field) =>
    field === 'sourceAccountId'
      ? 'source account'
      : formatFieldLabel(field).toLowerCase(),
  );
  const fieldText =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  const verb = labels.length === 1 ? 'is' : 'are';

  return `I can read parts of the scanned bill, but the ${fieldText} ${verb} unclear. Please provide ${fieldText} before I prepare the payment.`;
};

const buildSafeFileAttachments = (fileContext) =>
  fileContext.files.map((file) => ({
    originalName: file.originalName,
    mimeType: file.mimeType,
    size: file.size,
    fileKind: file.fileKind,
    isVisualInput: file.isVisualInput,
    isOcrDerived: file.isOcrDerived,
    isScannedOrImageBased: file.isScannedOrImageBased,
    extractedText: file.extractedText || '',
    extractionStatus: file.extractionStatus,
    ...(file.extractionError ? { extractionError: file.extractionError } : {}),
  }));

const buildFileFallbackMessage = (fileContext) => {
  if (!fileContext.files.length) return null;
  if (fileContext.combinedText) return null;

  const pdfFiles = fileContext.files.filter((file) =>
    String(file.mimeType || '').toLowerCase() === 'application/pdf' ||
    String(file.originalName || '').toLowerCase().endsWith('.pdf'),
  );

  if (pdfFiles.length > 0) {
    return 'I received the image, but I could not read enough text from it.';
  }

  const imageFiles = fileContext.files.filter((file) =>
    String(file.mimeType || '').toLowerCase().startsWith('image/') ||
    ['metadata_only', 'ocr_empty'].includes(file.extractionStatus),
  );

  if (imageFiles.length > 0) {
    return 'I received the image, but I could not read enough text from it.';
  }

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

const handleBankingActionMode = async (res, req, ai, finalPayload, fileContext) => {
  const fileData = fileContext
    ? {
        fileContext: {
          files: buildSafeFileAttachments(fileContext),
          extractedContextUsed: Boolean(fileContext.combinedText),
        },
      }
    : {};

  if (
    ai.actionName === 'pay_bill' &&
    fileContext?.hasUploadedFiles &&
    hasVisualOrOcrFileContext(fileContext) &&
    !hasOcrExtractedFile(fileContext)
  ) {
    return res.json({
      success: true,
      status: 'file_analyzed',
      agentMode: 'file_analysis',
      assistantMessage:
        buildFileFallbackMessage(fileContext) ||
        'I received the image, but I could not read enough text from it.',
      data: { ai, finalPayload, ...fileData },
    });
  }

  if (ai.actionName === 'pay_bill' && hasVisualOrOcrContext(fileContext, finalPayload)) {
    const ocrMissingFields = getPayBillMissingFields(finalPayload);

    if (ocrMissingFields.length > 0) {
      return res.json({
        success: true,
        status: 'missing_fields',
        agentMode: 'banking_action',
        assistantMessage: buildOcrPaymentMissingFieldsMessage(
          ocrMissingFields,
          finalPayload,
        ),
        data: {
          ai: { ...ai, missingFields: ocrMissingFields },
          finalPayload,
          missingFields: ocrMissingFields,
          ...fileData,
        },
      });
    }
  }

  const preparation = prepareAction({
    actionName: ai.actionName,
    payload: finalPayload,
    user: req.user,
  });

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
    const preparationData = preparation.body.data;

    if (ai.actionName === 'check_balance') {
      const execution = await executeAction({
        actionName: ai.actionName,
        payload: finalPayload,
        user: req.user,
      });

      if (execution.body.status === 'completed') {
        return res.json({
          success: true,
          status: 'completed',
          agentMode: 'banking_action',
          assistantMessage: buildBalanceResultMessage(execution.body.data),
          data: {
            ai: {
              ...ai,
              toolInput: {},
            },
            finalPayload,
            execution: execution.body.data,
            ...fileData,
          },
        });
      }

      return res.status(execution.httpStatus).json({
        ...execution.body,
        data: { ...(execution.body.data || {}), ...fileData },
      });
    }

    return res.json({
      success: true,
      status: 'action_prepared',
      agentMode: 'banking_action',
      assistantMessage: buildPreparedActionMessage(preparationData, {
        fromFile: Boolean(fileContext?.combinedText),
      }),
      data: { ai, finalPayload, preparation: preparationData, ...fileData },
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
  const { message, conversationHistory = [], agentContext = {} } = req.body;

  if (!message) {
    return res.status(400).json({ success: false, message: 'message is required' });
  }

  try {
    const resolvedResourceContext = await buildResolvedResourceContext(message);
    const availableActions = getAvailableAiActions(req.user.role);
    const aiResponse = await analyzeMessage({
      message,
      userRole: req.user.role,
      availableActions,
      conversationHistory,
      resolvedResourceContext,
      agentContext,
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
    const resolvedResourceContext = await buildResolvedResourceContext(message);

    if (resolvedResourceContext) {
      console.log('[chat/message] resolved resource:', {
        resourceUrl: resolvedResourceContext.resourceUrl,
        fileUrl: resolvedResourceContext.fileUrl,
        extractionStatus: resolvedResourceContext.extractionStatus,
        fileTextLength: resolvedResourceContext.fileText?.length || 0,
      });
    }

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
      resolvedResourceContext,
      agentContext,
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
  const agentContext = parseAgentContext(req.body.agentContext);
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
    const resolvedResourceContext = await buildResolvedResourceContext(message);
    const fileContext = await buildFileContext(uploadedFiles);
    createFileChatAuditLog({ req, fileContext });

    console.log('[chat/with-files] fileContext.files:', fileContext.files.length);
    console.log('[chat/with-files] fileContext.hasUploadedFiles:', fileContext.hasUploadedFiles);
    console.log('[chat/with-files] fileContext.combinedText length:', fileContext.combinedText?.length || 0);

    console.log('[chat/with-files] Sending to AI:', {
      hasUploadedFiles: fileContext.hasUploadedFiles,
      fileCount: fileContext.files.length,
      combinedTextLength: fileContext.combinedText?.length || 0,
      resourceExtractionStatus: resolvedResourceContext?.extractionStatus,
    });

    const aiResponse = await analyzeMessage({
      message,
      userRole: req.user.role,
      availableActions: getAvailableAiActions(req.user.role),
      conversationHistory,
      fileContext,
      resolvedResourceContext,
      profileContext,
      agentContext,
    });

    let ai = aiResponse.data;
    console.log('[chat/with-files] AI agentMode:', ai.agentMode);
    console.log('[chat/with-files] AI intent:', ai.intent);
    console.log('[chat/with-files] AI actionName:', ai.actionName);
    console.log('[chat/with-files] AI assistantMessage:', ai.assistantMessage);

    const fileFallbackMessage = buildFileFallbackMessage(fileContext);

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
            : fileFallbackMessage ||
              'I received the uploaded file, but I could not extract readable text from it.',
        };
      }
    }

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
