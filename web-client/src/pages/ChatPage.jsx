import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  cancelAction,
  confirmAction,
  executeAction,
  verifyAndExecuteAction,
} from '../api/actionApi';
import { downloadGeneratedFile, sendChatMessage, sendChatMessageWithFiles } from '../api/chatApi';
import Badge from '../components/Badge.jsx';
import Button from '../components/Button.jsx';
import AssistantAvatar from '../components/chat/AssistantAvatar.jsx';
import ChatMessage from '../components/chat/ChatMessage.jsx';
import ChatSidebar from '../components/chat/ChatSidebar.jsx';
import ChatStatusSticker from '../components/chat/ChatStatusSticker.jsx';
import {
  createChatThread,
  createWelcomeMessage,
  getThreadTitleFromMessages,
  loadChatThreads,
  saveChatThreads,
} from '../utils/chatStorage';
import {
  getToken,
  getUser,
  removeToken,
  removeUser,
} from '../utils/authStorage';

const statusLabels = {
  action_prepared: 'Action Prepared',
  missing_fields: 'Missing Fields',
  confirmation_required: 'Confirmation Required',
  sms_required: 'SMS Required',
  completed: 'Completed',
  cancelled: 'Cancelled',
  error: 'Error',
  failed: 'Failed',
  high_risk_blocked: 'High Risk Blocked',
  not_connected: 'Not Connected',
  sms_invalid: 'Invalid SMS',
  sms_expired: 'SMS Expired',
  sms_failed: 'SMS Failed',
  file_analyzed: 'File Analyzed',
  file_generated: 'File Generated',
  answered: 'Answered',
};

const statusTone = (status) => {
  if (['completed', 'sms_verified', 'file_analyzed', 'file_generated', 'answered'].includes(status)) {
    return 'success';
  }
  if (['error', 'failed', 'sms_invalid', 'sms_expired', 'sms_failed'].includes(status)) {
    return 'danger';
  }
  if (['confirmation_required', 'sms_required', 'missing_fields'].includes(status)) {
    return 'warning';
  }
  return 'neutral';
};

const riskTone = (riskLevel) => {
  if (riskLevel === 'high') return 'danger';
  if (riskLevel === 'medium') return 'warning';
  return 'success';
};

const formatStatus = (status) =>
  statusLabels[status] || status?.replaceAll('_', ' ') || 'Status';

const getProfileStorageKey = (user) =>
  `atb_user_profile_${user?.id || user?.email || 'anonymous'}`;

const buildDefaultProfile = (user) => ({
  fullName: user?.fullName || '',
  email: user?.email || '',
  phoneNumber: user?.phoneNumber || '',
  rib: '',
});

const loadUserProfile = (user) => {
  try {
    const savedProfile = window.localStorage.getItem(getProfileStorageKey(user));
    return {
      ...buildDefaultProfile(user),
      ...(savedProfile ? JSON.parse(savedProfile) : {}),
    };
  } catch {
    return buildDefaultProfile(user);
  }
};

const saveUserProfile = (user, profile) => {
  window.localStorage.setItem(getProfileStorageKey(user), JSON.stringify(profile));
};

// Contextual status messages for agent activity sticker
const ACTIVITY_LABELS = {
  reading_file: 'Reading uploaded file...',
  extracting: 'Extracting information...',
  generating_file: 'Generating your file...',
  preparing_action: 'Preparing secure action...',
  executing_action: 'Executing sandbox action...',
  verifying_sms: 'Verifying SMS code...',
  understanding: 'Understanding your request...',
};

const EMPTY_AGENT_CONTEXT = { extractedFields: {}, suggestedAction: null };

const QUICK_ACTIONS = [
  { label: 'Upload a bill', type: 'upload' },
  { label: 'Check balance', prompt: 'Check my account balance' },
  { label: 'Generate document', prompt: 'Generate my account statement' },
  { label: 'Create complaint', prompt: 'Create a complaint' },
  { label: 'Book appointment', prompt: 'Book an appointment' },
];

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
  fieldLabels[field] || field?.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase());

const getTomorrowDate = () => {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
};

const quickRepliesByAction = {
  book_appointment: {
    branch: [
      { label: 'Tunis Centre branch', prompt: 'branch Tunis Centre' },
      { label: 'La Marsa branch', prompt: 'branch La Marsa' },
    ],
    date: [
      { label: 'Tomorrow', prompt: `date ${getTomorrowDate()}` },
      { label: 'Show available slots', prompt: 'Show available appointment slots' },
    ],
    time: [
      { label: '10:00', prompt: 'time 10:00' },
      { label: '14:00', prompt: 'time 14:00' },
    ],
  },
  check_balance: {
    accountId: [
      { label: 'Current account', prompt: 'account acc_001' },
      { label: 'Savings account', prompt: 'account acc_002' },
    ],
  },
  generate_document: {
    accountId: [
      { label: 'Current account', prompt: 'account acc_001' },
      { label: 'Savings account', prompt: 'account acc_002' },
    ],
    documentType: [
      { label: 'Statement', prompt: 'statement' },
      { label: 'RIB', prompt: 'rib' },
    ],
    period: [
      { label: 'April 2026', prompt: 'April 2026' },
      { label: 'Generate document', prompt: 'Generate my account statement' },
    ],
  },
  create_complaint: {
    category: [
      { label: 'Failed transfer', prompt: 'transfer complaint' },
      { label: 'Card issue', prompt: 'card complaint' },
      { label: 'Account access issue', prompt: 'account complaint' },
    ],
    description: [
      { label: 'Failed transfer', prompt: 'I have a failed transfer issue' },
      { label: 'Card issue', prompt: 'I have a card issue' },
      { label: 'Continue', prompt: 'Continue' },
    ],
  },
  pay_bill: {
    sourceAccountId: [
      { label: 'Use current account', prompt: 'source account acc_001' },
      { label: 'Use savings account', prompt: 'source account acc_002' },
    ],
    billReference: [
      { label: 'Enter bill reference', prompt: 'bill reference ' },
      { label: 'Upload a bill', action: 'upload' },
    ],
  },
};

// Infers which banking action a remembered field set points to.
const inferActionFromFields = (fields = {}) => {
  if (fields.billReference || fields.provider) return 'pay_bill';
  if (fields.beneficiaryId) return 'make_transfer';
  if (fields.documentType || fields.period) return 'generate_document';
  if (fields.category) return 'create_complaint';
  if (fields.branch || fields.appointmentDate) return 'book_appointment';
  return null;
};

// Accumulates the context the assistant extracted so follow-up commands
// ("pay it", "continue", ...) can reuse it on the next turn.
const deriveAgentContext = (previousContext, response) => {
  const ai = response?.data?.ai || {};
  const finalPayload = response?.data?.finalPayload || {};
  const mergedFields = {
    ...(previousContext?.extractedFields || {}),
    ...(ai.extractedFields || {}),
    ...finalPayload,
  };
  const suggestedAction =
    ai.actionName ||
    response?.data?.actionName ||
    inferActionFromFields(mergedFields) ||
    previousContext?.suggestedAction ||
    null;

  return { extractedFields: mergedFields, suggestedAction };
};

// Direct completion wording for chat results. Sandbox details stay in collapsed technical details.
const buildCompletionText = (_executionMode, data = {}) => {
  if (data.paymentReference) return 'Payment completed.';
  if (data.transferReference) return 'Transfer completed.';
  if (data.document) return 'Document ready.';
  if (data.complaint) return 'Complaint submitted.';
  if (data.appointment) return 'Appointment booked.';
  return 'Action completed.';
};
const executionModeLabel = (executionMode) =>
  executionMode === 'external'
    ? 'Live ATB connector'
    : 'Sandbox demo';

const buildMissingFieldsMessage = (response) => {
  const missingFields = response.data?.missingFields || response.data?.ai?.missingFields || [];
  const actionName = response.data?.ai?.actionName || response.data?.actionName;

  if (!missingFields.length) {
    return response.assistantMessage || 'I need a few more details before I can continue.';
  }

  const titleByAction = {
    book_appointment: 'To book your appointment, I need a few details:',
    generate_document: 'To generate your document, I need a few details:',
    create_complaint: 'To create your complaint, I need a few details:',
    pay_bill: 'To prepare this bill payment, I need a few details:',
    check_balance: 'To check your balance, I need one detail:',
    make_transfer: 'To prepare this transfer, I need a few details:',
  };

  const fields = missingFields
    .map((field) => `- ${formatFieldLabel(field)}`)
    .join('\n');

  return `${titleByAction[actionName] || 'I need a few details before I can continue:'}\n\n**Required information**\n${fields}\n\nChoose one of the options below or type your answer.`;
};

const buildAssistantText = (response) => {
  if (response.status === 'missing_fields') {
    return buildMissingFieldsMessage(response);
  }

  if (response.status === 'action_prepared') {
    const displayName = response.data?.preparation?.displayName || 'banking action';
    return `**Review ${displayName.toLowerCase()}**\n\nI prepared this request using the details available so far. Review the summary below, then continue or cancel.`;
  }

  return (
    response.assistantMessage ||
    'I reviewed your request. Please review the details below.'
  );
};

const uniqueQuickReplies = (replies) => {
  const seen = new Set();
  return replies.filter((reply) => {
    const key = `${reply.label}-${reply.prompt || reply.action || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const buildMissingFieldQuickReplies = (response) => {
  const actionName = response.data?.ai?.actionName || response.data?.actionName;
  const missingFields = response.data?.missingFields || response.data?.ai?.missingFields || [];
  const actionReplies = quickRepliesByAction[actionName] || {};

  return uniqueQuickReplies(
    missingFields.flatMap((field) =>
      (actionReplies[field] || []).map((reply) => ({
        ...reply,
        field,
        fieldLabel: formatFieldLabel(field),
        selectable:
          !reply.action &&
          !String(reply.prompt || reply.label).toLowerCase().startsWith('show '),
      })),
    ),
  ).slice(0, 6);
};

const buildPreparedActionQuickReplies = (response) => {
  const actionName = response.data?.preparation?.actionName || response.data?.ai?.actionName;

  if (actionName === 'pay_bill') {
    return [
      { label: 'Pay it', action: 'continue' },
      { label: 'Cancel', action: 'cancel' },
      { label: 'Show details', prompt: 'Show payment details' },
    ];
  }

  if (actionName === 'generate_document') {
    return [
      { label: 'Generate document', action: 'continue' },
      { label: 'Cancel', action: 'cancel' },
    ];
  }

  return [
    { label: 'Continue', action: 'continue' },
    { label: 'Cancel', action: 'cancel' },
  ];
};

const buildAssistantQuickReplies = (response) => {
  if (response.status === 'missing_fields') {
    return buildMissingFieldQuickReplies(response);
  }

  if (response.status === 'action_prepared') {
    return buildPreparedActionQuickReplies(response);
  }

  if (
    response.status === 'file_analyzed' &&
    response.data?.ai?.extractedFields?.billReference
  ) {
    return [
      { label: 'Pay it', prompt: 'Pay it' },
      { label: 'Show details', prompt: 'Show bill details' },
    ];
  }

  return [];
};

function InlineAssistantPanel({ children, className = '' }) {
  return (
    <div className="chat-row chat-row-assistant">
      <AssistantAvatar />
      <div className={`inline-action-panel ${className}`.trim()}>{children}</div>
    </div>
  );
}

// Generated file download card
function GeneratedFileCard({ generatedFile, token }) {
  const handleDownload = () => {
    downloadGeneratedFile({ fileId: generatedFile.fileId, token });
  };

  return (
    <InlineAssistantPanel className="generated-file-card">
      <h2>Document ready.</h2>
      <p>{generatedFile.title || 'Your generated document is ready.'}</p>
      <div className="action-button-row">
        <Button type="button" onClick={handleDownload}>
          Download document
        </Button>
      </div>
      <details className="technical-details">
        <summary>Technical details</summary>
        <pre>{JSON.stringify(generatedFile, null, 2)}</pre>
      </details>
    </InlineAssistantPanel>
  );
}

function ChatPage() {
  const navigate = useNavigate();
  const transcriptRef = useRef(null);
  const fileInputRef = useRef(null);
  const [session] = useState(() => {
    const sessionUser = getUser();
    const sessionToken = getToken();
    const savedThreads = sessionUser ? loadChatThreads(sessionUser) : [];
    const initialThreads =
      savedThreads.length > 0 ? savedThreads : sessionUser ? [createChatThread()] : [];
    const initialThread = initialThreads[0] || null;

    return {
      initialThread,
      initialThreads,
      token: sessionToken,
      user: sessionUser,
    };
  });
  const { initialThread, initialThreads, token, user } = session;
  const [threads, setThreads] = useState(initialThreads);
  const [activeThreadId, setActiveThreadId] = useState(initialThread?.id || '');
  const [messages, setMessages] = useState(
    initialThread?.messages?.length ? initialThread.messages : [createWelcomeMessage()],
  );
  const [message, setMessage] = useState('');
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [isSending, setIsSending] = useState(false);
  const [assistantActivity, setAssistantActivity] = useState('');
  const [actionLoadingText, setActionLoadingText] = useState('');
  const [pendingAction, setPendingAction] = useState(
    initialThread?.pendingAction || null,
  );
  const [pendingConfirmation, setPendingConfirmation] = useState(
    initialThread?.pendingConfirmation || null,
  );
  const [pendingSms, setPendingSms] = useState(initialThread?.pendingSms || null);
  const [smsCode, setSmsCode] = useState(initialThread?.smsCode || '');
  const [smsError, setSmsError] = useState(initialThread?.smsError || '');
  const [pendingGeneratedFile, setPendingGeneratedFile] = useState(
    initialThread?.pendingGeneratedFile || null,
  );
  const [agentContext, setAgentContext] = useState(
    initialThread?.agentContext || EMPTY_AGENT_CONTEXT,
  );
  const [threadPendingDeleteId, setThreadPendingDeleteId] = useState('');
  const [profile, setProfile] = useState(() =>
    session.user ? loadUserProfile(session.user) : buildDefaultProfile(session.user),
  );
  const [draftProfile, setDraftProfile] = useState(profile);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [profileFeedback, setProfileFeedback] = useState('');

  const hydrateThread = useCallback((thread) => {
    setMessages(thread.messages?.length ? thread.messages : [createWelcomeMessage()]);
    setMessage('');
    setSelectedFiles([]);
    setPendingAction(thread.pendingAction || null);
    setPendingConfirmation(thread.pendingConfirmation || null);
    setPendingSms(thread.pendingSms || null);
    setSmsCode(thread.smsCode || '');
    setSmsError(thread.smsError || '');
    setPendingGeneratedFile(thread.pendingGeneratedFile || null);
    setAgentContext(thread.agentContext || EMPTY_AGENT_CONTEXT);
    setAssistantActivity('');
    setActionLoadingText('');
  }, []);

  const updateCurrentThread = useCallback(
    (updates, { touch = true } = {}) => {
      if (!activeThreadId) return;

      setThreads((currentThreads) =>
        currentThreads.map((thread) => {
          if (thread.id !== activeThreadId) return thread;

          const nextMessages = updates.messages || thread.messages;
          const nextTitle =
            updates.title || getThreadTitleFromMessages(nextMessages || []);

          return {
            ...thread,
            ...updates,
            title: nextTitle,
            updatedAt: touch ? new Date().toISOString() : thread.updatedAt,
          };
        }),
      );
    },
    [activeThreadId],
  );

  const updateMessages = useCallback(
    (updater) => {
      setMessages((currentMessages) => {
        const nextMessages =
          typeof updater === 'function' ? updater(currentMessages) : updater;

        updateCurrentThread({
          messages: nextMessages,
          title: getThreadTitleFromMessages(nextMessages),
        });

        return nextMessages;
      });
    },
    [updateCurrentThread],
  );

  const updateThreadMetadata = useCallback(
    (updates) => {
      updateCurrentThread(updates, { touch: false });
    },
    [updateCurrentThread],
  );

  useEffect(() => {
    if (!token || !user) navigate('/login');
  }, [navigate, token, user]);

  useEffect(() => {
    if (user) saveChatThreads(user, threads);
  }, [threads, user]);

  useEffect(() => {
    if (!transcriptRef.current) return;
    transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [
    actionLoadingText,
    assistantActivity,
    messages,
    pendingAction,
    pendingConfirmation,
    pendingSms,
    pendingGeneratedFile,
  ]);

  const conversationHistory = useMemo(
    () =>
      messages.map((chatMessage) => ({
        role: chatMessage.sender === 'user' ? 'user' : 'assistant',
        content: chatMessage.text,
      })),
    [messages],
  );
  const isEmptyConversation = !messages.some(
    (chatMessage) => chatMessage.sender === 'user',
  );

  const handleLogout = () => {
    removeToken();
    removeUser();
    navigate('/login');
  };

  const handleNewThread = () => {
    const nextThread = createChatThread();
    setThreads((currentThreads) => [nextThread, ...currentThreads]);
    setActiveThreadId(nextThread.id);
    hydrateThread(nextThread);
  };

  const formatFileSize = (size) => {
    if (!Number.isFinite(size)) return '';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  };

  const buildFileAttachments = (files) =>
    files.map((file) => ({
      originalName: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
    }));

  const handlePickFiles = () => fileInputRef.current?.click();

  const handleFileChange = (event) => {
    const incomingFiles = Array.from(event.target.files || []);
    setSelectedFiles((currentFiles) => [...currentFiles, ...incomingFiles].slice(0, 5));
    event.target.value = '';
  };

  const handleRemoveSelectedFile = (indexToRemove) => {
    setSelectedFiles((currentFiles) =>
      currentFiles.filter((_, index) => index !== indexToRemove),
    );
  };

  const handleOpenProfile = () => {
    setDraftProfile(profile);
    setProfileFeedback('');
    setIsProfileOpen(true);
  };

  const handleCloseProfile = () => {
    setDraftProfile(profile);
    setProfileFeedback('');
    setIsProfileOpen(false);
  };

  const handleProfileFieldChange = (field, value) => {
    setDraftProfile((currentProfile) => ({ ...currentProfile, [field]: value }));
  };

  const handleSaveProfile = (event) => {
    event.preventDefault();
    const nextProfile = {
      fullName: draftProfile.fullName.trim(),
      email: draftProfile.email.trim(),
      phoneNumber: draftProfile.phoneNumber.trim(),
      rib: draftProfile.rib.trim(),
    };
    setProfile(nextProfile);
    saveUserProfile(user, nextProfile);
    setProfileFeedback('Profile saved');
    window.setTimeout(() => {
      setIsProfileOpen(false);
      setProfileFeedback('');
    }, 1000);
  };

  const handleSelectThread = (threadId) => {
    if (threadId === activeThreadId) return;
    const selectedThread = threads.find((thread) => thread.id === threadId);
    if (!selectedThread) return;
    setActiveThreadId(selectedThread.id);
    hydrateThread(selectedThread);
  };

  const handleDeleteThread = (threadId) => setThreadPendingDeleteId(threadId);
  const handleCancelDeleteThread = () => setThreadPendingDeleteId('');

  const handleConfirmDeleteThread = () => {
    if (!threadPendingDeleteId) return;

    setThreads((currentThreads) => {
      const remainingThreads = currentThreads.filter(
        (thread) => thread.id !== threadPendingDeleteId,
      );
      const nextThreads =
        remainingThreads.length > 0 ? remainingThreads : [createChatThread()];

      if (threadPendingDeleteId === activeThreadId) {
        setActiveThreadId(nextThreads[0].id);
        hydrateThread(nextThreads[0]);
      }

      return nextThreads;
    });

    setThreadPendingDeleteId('');
  };

  const appendMessage = (chatMessage) => {
    updateMessages((currentMessages) => [
      ...currentMessages,
      { id: `${Date.now()}-${Math.random()}`, ...chatMessage },
    ]);
  };

  const appendAssistantMessage = (chatMessage) => {
    appendMessage({ sender: 'assistant', ...chatMessage });
  };

  const buildAssistantDetails = (response) => {
    if (response.status === 'action_prepared') {
      return { summary: response.data?.preparation?.summary || [] };
    }
    return null;
  };

  const buildResultDetails = (data) => (data ? { result: data } : null);

  const clearPendingInteractionState = () => {
    setPendingAction(null);
    setPendingConfirmation(null);
    setPendingSms(null);
    setPendingGeneratedFile(null);
  };

  const setChatResponseState = (response) => {
    const agentMode = response.agentMode || 'informational_answer';

    if (response.status === 'action_prepared') {
      const nextPendingAction = response.data?.preparation || null;
      setPendingAction(nextPendingAction);
      setPendingConfirmation(null);
      setPendingSms(null);
      setPendingGeneratedFile(null);
      setSmsCode('');
      setSmsError('');
      updateThreadMetadata({
        pendingAction: nextPendingAction,
        pendingConfirmation: null,
        pendingSms: null,
        pendingGeneratedFile: null,
        smsCode: '',
        smsError: '',
      });
      return;
    }

    if (response.status === 'missing_fields') {
      setPendingAction(null);
      setPendingConfirmation(null);
      setPendingSms(null);
      setPendingGeneratedFile(null);
      updateThreadMetadata({
        pendingAction: null,
        pendingConfirmation: null,
        pendingSms: null,
        pendingGeneratedFile: null,
      });
      return;
    }

    if (response.status === 'file_generated' && agentMode === 'file_generation') {
      const generatedFile = response.data?.generatedFile || null;
      setPendingAction(null);
      setPendingConfirmation(null);
      setPendingSms(null);
      setPendingGeneratedFile(generatedFile);
      updateThreadMetadata({
        pendingAction: null,
        pendingConfirmation: null,
        pendingSms: null,
        pendingGeneratedFile: generatedFile,
      });
      return;
    }

    // Default: clear all pending interaction state
    updateThreadMetadata({
      pendingAction: null,
      pendingConfirmation: null,
      pendingSms: null,
      pendingGeneratedFile: null,
    });
    clearPendingInteractionState();
  };

  const handleExecutionResponse = (response) => {
    if (response.status === 'completed') {
      const executionMode =
        response.executionMode || response.data?.executionMode || 'sandbox';
      appendAssistantMessage({
        text: buildCompletionText(executionMode, response.data),
        status: response.status,
        details: buildResultDetails(response.data),
      });
      setPendingAction(null);
      setPendingConfirmation(null);
      setPendingSms(null);
      setSmsCode('');
      setSmsError('');
      setAgentContext(EMPTY_AGENT_CONTEXT);
      updateThreadMetadata({
        pendingAction: null,
        pendingConfirmation: null,
        pendingSms: null,
        smsCode: '',
        smsError: '',
        agentContext: EMPTY_AGENT_CONTEXT,
      });
      return;
    }

    if (response.status === 'confirmation_required') {
      appendAssistantMessage({
        text: 'Please review and confirm this banking action.',
        status: response.status,
      });
      setPendingAction(null);
      setPendingConfirmation(response.data);
      setPendingSms(null);
      updateThreadMetadata({
        pendingAction: null,
        pendingConfirmation: response.data,
        pendingSms: null,
      });
      return;
    }

    if (response.status === 'sms_required') {
      appendAssistantMessage({
        text: 'SMS verification is required before this secure action can continue.',
        status: response.status,
      });
      setPendingAction(null);
      setPendingConfirmation(null);
      setPendingSms(response.data);
      setSmsCode('');
      setSmsError('');
      updateThreadMetadata({
        pendingAction: null,
        pendingConfirmation: null,
        pendingSms: response.data,
        smsCode: '',
        smsError: '',
      });
      return;
    }

    if (response.status === 'high_risk_blocked') {
      appendAssistantMessage({
        text: 'This action requires SMS verification before execution.',
        status: response.status,
      });
      setPendingAction(null);
      setPendingConfirmation(null);
      setPendingSms(null);
      updateThreadMetadata({
        pendingAction: null,
        pendingConfirmation: null,
        pendingSms: null,
      });
      return;
    }

    appendAssistantMessage({
      text: response.message || 'The action could not be completed.',
      status: response.status || 'error',
    });
  };

  // Determine contextual activity label based on message + files
  const getActivityLabel = (hasFiles, messageText) => {
    if (hasFiles) return ACTIVITY_LABELS.reading_file;
    const lower = (messageText || '').toLowerCase();
    if (lower.includes('generate') || lower.includes('export') || lower.includes('csv') || lower.includes('report')) {
      return ACTIVITY_LABELS.generating_file;
    }
    return ACTIVITY_LABELS.understanding;
  };

  const sendMessage = async (messageOverride = '') => {
    const draftMessage = messageOverride || message;

    if ((!draftMessage.trim() && selectedFiles.length === 0) || isSending) return;

    const userMessage =
      draftMessage.trim() || 'Please review the uploaded file attachments.';
    const filesToSend = selectedFiles;
    const attachments = buildFileAttachments(filesToSend);

    setMessage('');
    setSelectedFiles([]);
    appendMessage({ sender: 'user', text: userMessage, attachments });

    setIsSending(true);
    setAssistantActivity(getActivityLabel(filesToSend.length > 0, userMessage));

    try {
      const response = filesToSend.length
        ? await sendChatMessageWithFiles({
            message: userMessage,
            conversationHistory,
            profileContext: profile,
            files: filesToSend,
            token,
          })
        : await sendChatMessage({
            message: userMessage,
            payload: {},
            conversationHistory,
            profileContext: profile,
            agentContext,
            token,
          });

      setChatResponseState(response);

      const nextAgentContext = deriveAgentContext(agentContext, response);
      setAgentContext(nextAgentContext);
      updateThreadMetadata({ agentContext: nextAgentContext });

      appendAssistantMessage({
        text: buildAssistantText(response),
        status: response.status,
        details: buildAssistantDetails(response),
        quickReplies: buildAssistantQuickReplies(response),
      });
    } catch {
      appendAssistantMessage({
        text: 'I could not reach the banking assistant right now. Please try again.',
        status: 'error',
      });
    } finally {
      setIsSending(false);
      setAssistantActivity('');
    }
  };

  const handleSend = async (event) => {
    event.preventDefault();
    await sendMessage();
  };

  const handleQuickAction = (quickAction) => {
    if (isSending) return;

    if (quickAction.type === 'upload') {
      handlePickFiles();
      return;
    }

    sendMessage(quickAction.prompt);
  };

  const buildContextualQuickReplyPrompt = (reply) => {
    const basePrompt = reply.prompt || reply.label;

    if (!agentContext?.suggestedAction || reply.action) {
      return basePrompt;
    }

    const contextFields = Object.entries(agentContext.extractedFields || {})
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([field, value]) => `${formatFieldLabel(field)} ${value}`)
      .join(', ');

    if (!contextFields) {
      return basePrompt;
    }

    return `${basePrompt}. Current request context: ${agentContext.suggestedAction}, ${contextFields}`;
  };

  const handleComposerKeyDown = (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    handleSend(event);
  };

  const handleContinueAction = async () => {
    if (!pendingAction || actionLoadingText) return;

    setActionLoadingText(ACTIVITY_LABELS.executing_action);

    try {
      const response = await executeAction({
        actionName: pendingAction.actionName,
        payload: pendingAction.payload,
        token,
      });
      handleExecutionResponse(response);
    } catch (error) {
      appendAssistantMessage({
        text:
          error.response?.data?.message ||
          'I could not execute this action. Please try again.',
        status: error.response?.data?.status || 'error',
      });
    } finally {
      setActionLoadingText('');
    }
  };

  const handleConfirmAction = async () => {
    if (!pendingConfirmation || actionLoadingText) return;

    setActionLoadingText(
      pendingConfirmation.riskLevel === 'high'
        ? ACTIVITY_LABELS.verifying_sms
        : ACTIVITY_LABELS.preparing_action,
    );

    try {
      const response = await confirmAction({
        confirmationId: pendingConfirmation.confirmationId,
        token,
      });
      handleExecutionResponse(response);
    } catch (error) {
      appendAssistantMessage({
        text:
          error.response?.data?.message ||
          'I could not confirm this action. Please try again.',
        status: error.response?.data?.status || 'error',
      });
    } finally {
      setActionLoadingText('');
    }
  };

  const handleVerifyAndExecute = async () => {
    if (!pendingSms || actionLoadingText) return;

    if (!smsCode.trim()) {
      setSmsError('Please enter the SMS code.');
      updateThreadMetadata({ smsError: 'Please enter the SMS code.' });
      return;
    }

    setSmsError('');
    updateThreadMetadata({ smsError: '' });
    setActionLoadingText(ACTIVITY_LABELS.verifying_sms);

    try {
      const response = await verifyAndExecuteAction({
        confirmationId: pendingSms.confirmationId,
        code: smsCode.trim(),
        token,
      });

      setActionLoadingText(ACTIVITY_LABELS.executing_action);
      handleExecutionResponse(response);
    } catch (error) {
      const status = error.response?.data?.status || 'error';
      const attemptsRemaining = error.response?.data?.data?.attemptsRemaining;
      let text =
        error.response?.data?.message ||
        'I could not verify the SMS code. Please try again.';

      if (status === 'sms_invalid' && attemptsRemaining !== undefined) {
        text = `Invalid SMS code. Attempts remaining: ${attemptsRemaining}.`;
      }
      if (status === 'sms_expired') text = 'The SMS code has expired. Please restart the action.';
      if (status === 'sms_failed') text = 'SMS verification failed. Please restart the action.';
      if (status === 'failed') {
        text = error.response?.data?.message || 'The secure action failed. Please restart the action.';
      }

      setSmsError(text);
      updateThreadMetadata({ smsError: text });
      appendAssistantMessage({ text, status });
    } finally {
      setActionLoadingText('');
    }
  };

  const handleCancelAction = async () => {
    if (actionLoadingText) return;

    setActionLoadingText('Cancelling action...');

    try {
      if (pendingConfirmation?.confirmationId) {
        await cancelAction({ confirmationId: pendingConfirmation.confirmationId, token });
      }
      if (pendingSms?.confirmationId) {
        await cancelAction({ confirmationId: pendingSms.confirmationId, token });
      }

      appendAssistantMessage({ text: 'Action cancelled.', status: 'cancelled' });
      setPendingAction(null);
      setPendingConfirmation(null);
      setPendingSms(null);
      setSmsCode('');
      setSmsError('');
      updateThreadMetadata({
        pendingAction: null,
        pendingConfirmation: null,
        pendingSms: null,
        smsCode: '',
        smsError: '',
      });
    } catch (error) {
      appendAssistantMessage({
        text:
          error.response?.data?.message ||
          'I could not cancel this action. Please try again.',
        status: error.response?.data?.status || 'error',
      });
    } finally {
      setActionLoadingText('');
    }
  };

  const handleMessageQuickReply = (reply) => {
    if (!reply || isSending || actionLoadingText) return;

    if (reply.action === 'upload') {
      handlePickFiles();
      return;
    }

    if (reply.action === 'continue') {
      if (pendingAction) {
        handleContinueAction();
        return;
      }
      sendMessage(buildContextualQuickReplyPrompt(reply));
      return;
    }

    if (reply.action === 'cancel') {
      if (pendingAction || pendingConfirmation || pendingSms) {
        handleCancelAction();
        return;
      }
      sendMessage(buildContextualQuickReplyPrompt(reply));
      return;
    }

    sendMessage(buildContextualQuickReplyPrompt(reply));
  };

  if (!user) return null;

  const renderComposer = (className = '') => (
    <form className={`chat-compose ${className}`.trim()} onSubmit={handleSend}>
      {selectedFiles.length ? (
        <div className="selected-file-list" aria-label="Selected files">
          {selectedFiles.map((file, index) => (
            <span
              key={`${file.name}-${file.size}-${file.lastModified}`}
              className="selected-file-chip"
            >
              <span>
                <strong>{file.name}</strong>
                <small>{formatFileSize(file.size)}</small>
              </span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() => handleRemoveSelectedFile(index)}
              >
                x
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="chat-input-row">
        <button
          type="button"
          className="composer-plus-button"
          aria-label="Attach files"
          onClick={handlePickFiles}
          disabled={isSending}
        >
          +
        </button>
        <input
          ref={fileInputRef}
          type="file"
          className="file-input"
          accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.csv,.docx"
          multiple
          onChange={handleFileChange}
        />
        <textarea
          value={message}
          placeholder="Ask about accounts, documents, bills, transfers, or upload a file"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          disabled={isSending}
          rows={1}
        />
        <Button
          type="submit"
          className="composer-send-button"
          disabled={isSending || (!message.trim() && selectedFiles.length === 0)}
        >
          Send
        </Button>
      </div>
    </form>
  );

  return (
    <section className="chat-workspace">
      <ChatSidebar
        activeThreadId={activeThreadId}
        onDeleteThread={handleDeleteThread}
        onLogout={handleLogout}
        onNewThread={handleNewThread}
        onOpenProfile={handleOpenProfile}
        onSelectThread={handleSelectThread}
        profile={profile}
        threads={threads}
        user={user}
      />

      <section className={`chat-main ${isEmptyConversation ? 'chat-main-empty' : ''}`}>
        {isEmptyConversation ? (
          <div className="chat-empty-state">
            <div className="chat-empty-content">
              <div className="chat-empty-copy">
                <p className="eyebrow">ATB Assistant</p>
                <h1>How can I help with your banking work today?</h1>
                <p>
                  Ask about accounts, documents, transfers, complaints,
                  appointments, or upload a file.
                </p>
              </div>

              {renderComposer('empty-state-composer')}

              <div className="quick-action-list" aria-label="Quick actions">
                {QUICK_ACTIONS.map((quickAction) => (
                  <button
                    type="button"
                    key={quickAction.label}
                    className="quick-action-pill"
                    onClick={() => handleQuickAction(quickAction)}
                    disabled={isSending}
                  >
                    {quickAction.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="chat-transcript" ref={transcriptRef}>
              <div className="message-list">
                {messages.map((chatMessage) => (
                  <ChatMessage
                    key={chatMessage.id}
                    formatStatus={formatStatus}
                    message={chatMessage}
                    onQuickReply={handleMessageQuickReply}
                    profile={profile}
                    statusTone={statusTone}
                    user={user}
                  />
                ))}

                {/* Banking action prepared card */}
                {pendingAction ? (
                  <InlineAssistantPanel className="action-prepared-card">
                <p className="eyebrow">Prepared action</p>
                <div className="action-card-header">
                  <h2>{pendingAction.displayName}</h2>
                  <Badge tone={riskTone(pendingAction.riskLevel)}>
                    {pendingAction.riskLevel || 'low'} risk
                  </Badge>
                </div>
                {pendingAction.executionMode ? (
                  <p className="execution-mode-line">
                    <Badge
                      tone={
                        pendingAction.executionMode === 'external'
                          ? 'success'
                          : 'warning'
                      }
                    >
                      {executionModeLabel(pendingAction.executionMode)}
                    </Badge>
                    <span>
                      {pendingAction.executionMode === 'external'
                        ? 'External connector configured.'
                        : 'External connector not configured — sandbox fallback for MVP demonstration.'}
                    </span>
                  </p>
                ) : null}
                <ul className="detail-list">
                  {pendingAction.summary.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <div className="action-button-row">
                  <Button
                    type="button"
                    onClick={handleContinueAction}
                    disabled={Boolean(actionLoadingText)}
                  >
                    Continue
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleCancelAction}
                    disabled={Boolean(actionLoadingText)}
                  >
                    Cancel
                  </Button>
                </div>
                  </InlineAssistantPanel>
                ) : null}

                {/* Confirmation card */}
                {pendingConfirmation ? (
                  <InlineAssistantPanel className="confirmation-card">
                <p className="eyebrow">Confirmation required</p>
                <div className="action-card-header">
                  <h2>{pendingConfirmation.actionName}</h2>
                  <Badge tone={riskTone(pendingConfirmation.riskLevel)}>
                    {pendingConfirmation.riskLevel} risk
                  </Badge>
                </div>
                {pendingConfirmation.executionMode ? (
                  <p className="execution-mode-line">
                    <Badge
                      tone={
                        pendingConfirmation.executionMode === 'external'
                          ? 'success'
                          : 'warning'
                      }
                    >
                      {executionModeLabel(pendingConfirmation.executionMode)}
                    </Badge>
                  </p>
                ) : null}
                <dl className="confirmation-meta">
                  <div>
                    <dt>Confirmation ID</dt>
                    <dd>{pendingConfirmation.confirmationId}</dd>
                  </div>
                  <div>
                    <dt>Expires at</dt>
                    <dd>{pendingConfirmation.expiresAt}</dd>
                  </div>
                </dl>
                {pendingConfirmation.summary?.length ? (
                  <ul className="detail-list">
                    {pendingConfirmation.summary.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : null}
                <div className="action-button-row">
                  <Button
                    type="button"
                    onClick={handleConfirmAction}
                    disabled={Boolean(actionLoadingText)}
                  >
                    Confirm
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleCancelAction}
                    disabled={Boolean(actionLoadingText)}
                  >
                    Cancel
                  </Button>
                </div>
                  </InlineAssistantPanel>
                ) : null}

                {/* SMS verification card */}
                {pendingSms ? (
                  <InlineAssistantPanel className="sms-card">
                <p className="eyebrow">SMS verification</p>
                <h2>Verify this secure banking action</h2>
                <dl className="confirmation-meta">
                  <div>
                    <dt>Action</dt>
                    <dd>{pendingSms.actionName}</dd>
                  </div>
                  <div>
                    <dt>Confirmation ID</dt>
                    <dd>{pendingSms.confirmationId}</dd>
                  </div>
                </dl>
                {pendingSms.maskedPhoneNumber ? (
                  <p>Code sent to: {pendingSms.maskedPhoneNumber}</p>
                ) : null}
                {pendingSms.expiresAt ? <p>Expires at: {pendingSms.expiresAt}</p> : null}
                <label className="sms-code-field">
                  SMS code
                  <input
                    type="text"
                    inputMode="numeric"
                    value={smsCode}
                    placeholder="123456"
                    maxLength={6}
                    onChange={(event) => {
                      setSmsCode(event.target.value);
                      updateThreadMetadata({ smsCode: event.target.value });
                    }}
                    disabled={Boolean(actionLoadingText)}
                  />
                </label>
                {smsError ? <p className="error-text">{smsError}</p> : null}
                <div className="action-button-row">
                  <Button
                    type="button"
                    onClick={handleVerifyAndExecute}
                    disabled={Boolean(actionLoadingText)}
                  >
                    Verify and Execute
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleCancelAction}
                    disabled={Boolean(actionLoadingText)}
                  >
                    Cancel
                  </Button>
                </div>
                  </InlineAssistantPanel>
                ) : null}

                {/* Generated file card */}
                {pendingGeneratedFile ? (
                  <GeneratedFileCard
                    generatedFile={pendingGeneratedFile}
                    token={token}
                  />
                ) : null}

                <ChatStatusSticker text={assistantActivity || actionLoadingText} />
              </div>
            </div>

            {renderComposer('workspace-composer')}
          </>
        )}
      </section>

      {/* Delete thread modal */}
      {threadPendingDeleteId ? (
        <div className="modal-overlay" role="presentation">
          <section
            className="confirmation-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-conversation-title"
          >
            <p className="eyebrow">Conversation history</p>
            <h2 id="delete-conversation-title">Delete conversation?</h2>
            <p>
              This conversation will be permanently removed from your local chat
              history.
            </p>
            <div className="modal-actions">
              <Button type="button" variant="secondary" onClick={handleCancelDeleteThread}>
                Cancel
              </Button>
              <Button type="button" onClick={handleConfirmDeleteThread}>
                Delete
              </Button>
            </div>
          </section>
        </div>
      ) : null}

      {/* Profile modal */}
      {isProfileOpen ? (
        <div className="modal-overlay" role="presentation">
          <section
            className="profile-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-title"
          >
            <p className="eyebrow">Account</p>
            <h2 id="profile-title">Profile</h2>
            <p className="profile-subtitle">
              Manage your assistant identity and banking context.
            </p>
            <form className="profile-form" onSubmit={handleSaveProfile}>
              <label>
                Full name
                <input
                  type="text"
                  value={draftProfile.fullName}
                  onChange={(event) =>
                    handleProfileFieldChange('fullName', event.target.value)
                  }
                />
              </label>
              <label>
                Email
                <input
                  type="email"
                  value={draftProfile.email}
                  onChange={(event) =>
                    handleProfileFieldChange('email', event.target.value)
                  }
                />
              </label>
              <label>
                Phone number
                <input
                  type="tel"
                  value={draftProfile.phoneNumber}
                  onChange={(event) =>
                    handleProfileFieldChange('phoneNumber', event.target.value)
                  }
                />
              </label>
              <label>
                Tunisian bank account RIB
                <input
                  type="text"
                  value={draftProfile.rib}
                  placeholder="TN59..."
                  onChange={(event) =>
                    handleProfileFieldChange('rib', event.target.value)
                  }
                />
              </label>

              {profileFeedback ? (
                <p className="profile-feedback">{profileFeedback}</p>
              ) : null}

              <div className="modal-actions">
                <Button type="button" variant="secondary" onClick={handleCloseProfile}>
                  Cancel
                </Button>
                <Button type="submit" className="profile-save-button">
                  Save
                </Button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </section>
  );
}

export default ChatPage;

