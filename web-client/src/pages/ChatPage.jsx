import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  cancelAction,
  confirmAction,
  executeAction,
  verifyAndExecuteAction,
} from '../api/actionApi';
import { downloadGeneratedFile, sendChatMessage, sendChatMessageWithFiles } from '../api/chatApi';
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
  reading_file: 'Reading uploaded file',
  extracting: 'Extracting information',
  generating_file: 'Generating document',
  preparing_action: 'Preparing request',
  executing_action: 'Calling internal service',
  verifying_sms: 'Verifying SMS',
  understanding: 'Thinking',
};

const EMPTY_AGENT_CONTEXT = { extractedFields: {}, suggestedAction: null };
const SUPPORTED_UPLOAD_EXTENSIONS = new Set([
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'txt',
  'csv',
  'json',
]);
const DOCX_UNSUPPORTED_MESSAGE =
  'DOCX files are not supported. Please upload a PDF, image, TXT, CSV, or JSON file.';
const UNSUPPORTED_FILE_MESSAGE =
  'Unsupported file type. Please upload a PDF, image, TXT, CSV, or JSON file.';

const QUICK_ACTIONS = [
  { label: 'Upload a bill', type: 'upload' },
  { label: 'Check balance', prompt: 'Check my account balance' },
  { label: 'Generate document', prompt: 'Generate my account statement' },
  { label: 'Create complaint', prompt: 'Create a complaint' },
  { label: 'Book appointment', prompt: 'Book an appointment' },
];

// Infers which banking action a remembered field set points to.
const inferActionFromFields = (fields = {}) => {
  if (fields.billReference || fields.provider) return 'pay_bill';
  if (fields.beneficiaryId) return 'make_transfer';
  if (fields.documentType || fields.period) return 'generate_document';
  if (fields.category) return 'create_complaint';
  if (fields.branch || fields.appointmentDate) return 'book_appointment';
  return null;
};

const stripPrivateResourceFields = (fields = {}) =>
  Object.fromEntries(
    Object.entries(fields || {}).filter(
      ([key]) => !String(key).toLowerCase().startsWith('_resource'),
    ),
  );

// Accumulates the context the assistant extracted so follow-up commands
// ("pay it", "continue", ...) can reuse it on the next turn.
const deriveAgentContext = (previousContext, response) => {
  const ai = response?.data?.ai || {};
  const finalPayload = response?.data?.finalPayload || {};
  const hasNewFileContext = Boolean(response?.data?.fileContext?.files?.length);
  const mergedFields = {
    ...(hasNewFileContext
      ? {}
      : stripPrivateResourceFields(previousContext?.extractedFields || {})),
    ...stripPrivateResourceFields(ai.extractedFields || {}),
    ...stripPrivateResourceFields(finalPayload),
  };
  const suggestedAction =
    ai.actionName ||
    response?.data?.actionName ||
    inferActionFromFields(mergedFields) ||
    previousContext?.suggestedAction ||
    null;

  return { extractedFields: mergedFields, suggestedAction };
};

const formatMoney = (amount, currency = 'TND') => {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount)) return amount ? `${amount} ${currency}` : '';
  return `${numericAmount.toFixed(3)} ${currency || 'TND'}`;
};

// Direct completion wording for chat results. Technical details stay out of chat.
const buildCompletionText = (_executionMode, data = {}) => {
  if (data.paymentReference) {
    return [
      'Payment completed.',
      '',
      `**Reference:** ${data.paymentReference}`,
      `**Amount:** ${formatMoney(data.amount, data.currency)}`,
      `**Provider:** ${data.provider || 'Provider'}`,
    ].join('\n');
  }

  if (data.transferReference) {
    return [
      'Transfer completed.',
      '',
      `**Reference:** ${data.transferReference}`,
      `**Amount:** ${formatMoney(data.amount, data.currency)}`,
      `**Beneficiary:** ${data.beneficiaryName || data.beneficiaryId || 'Beneficiary'}`,
    ].join('\n');
  }

  if (data.document) {
    return [
      'Document ready.',
      '',
      data.document.title || 'Your requested banking document is ready.',
    ].join('\n');
  }

  if (data.complaint) {
    return [
      'Complaint submitted.',
      '',
      `**Reference:** ${data.complaint.reference}`,
      `**Status:** ${data.complaint.status || 'Open'}`,
    ].join('\n');
  }

  if (data.appointment) {
    return [
      'Appointment booked.',
      '',
      `**Reference:** ${data.appointment.appointmentId}`,
      `**Branch:** ${data.appointment.branch}`,
      `**Date:** ${data.appointment.date}`,
      `**Time:** ${data.appointment.time}`,
    ].join('\n');
  }

  if (data.account?.balance !== undefined) {
    return [
      'Balance retrieved.',
      '',
      `**Account:** ${data.account.accountNumber || data.account.id}`,
      `**Balance:** ${formatMoney(data.account.balance, data.account.currency)}`,
      `**Status:** ${data.account.status || 'Active'}`,
    ].join('\n');
  }

  return 'Action completed.';
};

// The assistant text flows as Markdown, exactly as the backend phrases it.
const buildAssistantText = (response) =>
  response.assistantMessage || 'I reviewed your request.';

// The only inline controls left on assistant messages are the small
// Confirm / Cancel buttons for a prepared action. Missing fields are asked for
// in natural language, never as option chips.
const buildAssistantQuickReplies = (response) => {
  const resourceActions = response?.data?.ai?.toolInput?.quickActions || [];

  if (response.status === 'action_prepared') {
    return [
      { label: 'Confirm', action: 'continue' },
      { label: 'Cancel', action: 'cancel' },
      ...resourceActions.filter((action) => action.action === 'open_url').slice(0, 1),
    ];
  }

  return resourceActions;
};

const shouldAppendAssistantMessage = () => true;

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
  // Remembers an action whose fields are still being collected so the next
  // short reply ("acc_002", "10:00") continues it instead of starting over.
  const [pendingFieldAction, setPendingFieldAction] = useState(
    initialThread?.pendingFieldAction || null,
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
    setPendingFieldAction(thread.pendingFieldAction || null);
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

  const scrollToBottom = useCallback((behavior = 'smooth') => {
    const node = transcriptRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      scrollToBottom('smooth');
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [
    actionLoadingText,
    assistantActivity,
    messages,
    pendingConfirmation,
    pendingSms,
    pendingGeneratedFile,
    scrollToBottom,
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
    const acceptedFiles = [];

    incomingFiles.forEach((file) => {
      const extension = file.name.split('.').pop()?.toLowerCase() || '';

      if (extension === 'docx') {
        appendAssistantMessage({
          text: DOCX_UNSUPPORTED_MESSAGE,
          status: 'error',
        });
        return;
      }

      if (!SUPPORTED_UPLOAD_EXTENSIONS.has(extension)) {
        appendAssistantMessage({
          text: UNSUPPORTED_FILE_MESSAGE,
          status: 'error',
        });
        return;
      }

      acceptedFiles.push(file);
    });

    setSelectedFiles((currentFiles) => [...currentFiles, ...acceptedFiles].slice(0, 5));
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
    void response;
    return null;
  };

  const buildResultDetails = (data) => (
    data?.document?.downloadUrl ? { result: { document: data.document } } : null
  );

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
      setPendingFieldAction(null);
      setSmsCode('');
      setSmsError('');
      updateThreadMetadata({
        pendingAction: nextPendingAction,
        pendingConfirmation: null,
        pendingSms: null,
        pendingGeneratedFile: null,
        pendingFieldAction: null,
        smsCode: '',
        smsError: '',
      });
      return;
    }

    if (response.status === 'missing_fields') {
      const nextPendingFieldAction = {
        actionName: response.data?.ai?.actionName || response.data?.actionName || null,
        missingFields: response.data?.missingFields || [],
        collectedFields: response.data?.finalPayload || {},
      };
      setPendingAction(null);
      setPendingConfirmation(null);
      setPendingSms(null);
      setPendingGeneratedFile(null);
      setPendingFieldAction(nextPendingFieldAction);
      updateThreadMetadata({
        pendingAction: null,
        pendingConfirmation: null,
        pendingSms: null,
        pendingGeneratedFile: null,
        pendingFieldAction: nextPendingFieldAction,
      });
      return;
    }

    if (response.status === 'file_generated' && agentMode === 'file_generation') {
      const generatedFile = response.data?.generatedFile || null;
      setPendingAction(null);
      setPendingConfirmation(null);
      setPendingSms(null);
      setPendingGeneratedFile(generatedFile);
      setPendingFieldAction(null);
      updateThreadMetadata({
        pendingAction: null,
        pendingConfirmation: null,
        pendingSms: null,
        pendingGeneratedFile: generatedFile,
        pendingFieldAction: null,
      });
      return;
    }

    // Default: clear all pending interaction state
    setPendingFieldAction(null);
    updateThreadMetadata({
      pendingAction: null,
      pendingConfirmation: null,
      pendingSms: null,
      pendingGeneratedFile: null,
      pendingFieldAction: null,
    });
    clearPendingInteractionState();
  };

  const handleExecutionResponse = (response) => {
    if (response.status === 'completed') {
      const executionMode =
        response.executionMode ||
        response.data?.executionMode ||
        'internal_demo_service';
      appendAssistantMessage({
        text: buildCompletionText(executionMode, response.data),
        status: response.status,
        details: buildResultDetails(response.data),
      });
      setPendingAction(null);
      setPendingConfirmation(null);
      setPendingSms(null);
      setPendingFieldAction(null);
      setSmsCode('');
      setSmsError('');
      setAgentContext(EMPTY_AGENT_CONTEXT);
      updateThreadMetadata({
        pendingAction: null,
        pendingConfirmation: null,
        pendingSms: null,
        pendingFieldAction: null,
        smsCode: '',
        smsError: '',
        agentContext: EMPTY_AGENT_CONTEXT,
      });
      return;
    }

    if (response.status === 'confirmation_required') {
      appendAssistantMessage({
        text: 'Please confirm to continue.',
        status: response.status,
        quickReplies: [
          { label: 'Confirm', action: 'confirm_pending' },
          { label: 'Cancel', action: 'cancel' },
        ],
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
        text: response.data?.maskedPhoneNumber
          ? `Enter the SMS code sent to ${response.data.maskedPhoneNumber}.`
          : 'Enter the SMS code to continue.',
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

  const isCancelCommand = (text) =>
    ['cancel', 'cancel it', 'stop', 'never mind'].includes(
      String(text || '').trim().toLowerCase().replace(/[.!?]+$/g, ''),
    );

  const normalizedCommand = (text) =>
    String(text || '').trim().toLowerCase().replace(/[.!?]+$/g, '');

  const isProceedCommand = (text) =>
    [
      'pay it',
      'do it',
      'continue',
      'proceed',
      'confirm',
      'generate it',
      'book it',
      'submit it',
      'yes do it',
      'ok do it',
    ].includes(normalizedCommand(text));

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
    scrollToBottom();

    if (
      isCancelCommand(userMessage) &&
      (pendingAction || pendingConfirmation || pendingSms)
    ) {
      await handleCancelAction();
      return;
    }

    if (isProceedCommand(userMessage)) {
      if (pendingConfirmation) {
        await handleConfirmAction();
        return;
      }
      if (pendingAction) {
        await handleContinueAction();
        return;
      }
    }

    setIsSending(true);
    setAssistantActivity(getActivityLabel(filesToSend.length > 0, userMessage));

    // Carry the full context every turn: accumulated extracted fields, the
    // suggested action, and any action whose fields are still being collected.
    const outgoingAgentContext = {
      ...agentContext,
      extractedFields: stripPrivateResourceFields(agentContext?.extractedFields || {}),
      pendingAction: pendingFieldAction,
    };

    try {
      const response = filesToSend.length
        ? await sendChatMessageWithFiles({
            message: userMessage,
            conversationHistory,
            profileContext: profile,
            agentContext: outgoingAgentContext,
            files: filesToSend,
            token,
          })
        : await sendChatMessage({
            message: userMessage,
            payload: {},
            conversationHistory,
            profileContext: profile,
            agentContext: outgoingAgentContext,
            token,
          });

      setChatResponseState(response);

      const nextAgentContext = deriveAgentContext(agentContext, response);
      setAgentContext(nextAgentContext);
      updateThreadMetadata({ agentContext: nextAgentContext });

      if (shouldAppendAssistantMessage(response)) {
        appendAssistantMessage({
          text: buildAssistantText(response),
          status: response.status,
          details: buildAssistantDetails(response),
          quickReplies: buildAssistantQuickReplies(response),
        });
      }
    } catch (error) {
      appendAssistantMessage({
        text:
          error.response?.data?.message ||
          'I could not reach the banking assistant right now. Please try again.',
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

      if (response.status === 'confirmation_required' && response.data?.confirmationId) {
        const confirmationResponse = await confirmAction({
          confirmationId: response.data.confirmationId,
          token,
        });
        handleExecutionResponse(confirmationResponse);
        return;
      }

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
      setPendingFieldAction(null);
      setSmsCode('');
      setSmsError('');
      updateThreadMetadata({
        pendingAction: null,
        pendingConfirmation: null,
        pendingSms: null,
        pendingFieldAction: null,
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

    if (reply.action === 'open_url' && reply.url) {
      window.open(reply.url, '_blank', 'noopener,noreferrer');
      return;
    }

    if (reply.action === 'upload') {
      handlePickFiles();
      return;
    }

    if (reply.action === 'continue') {
      if (pendingAction) {
        handleContinueAction();
        return;
      }
      sendMessage(reply.prompt || reply.label);
      return;
    }

    if (reply.action === 'confirm_pending') {
      if (pendingConfirmation) {
        handleConfirmAction();
        return;
      }
      sendMessage(reply.prompt || reply.label);
      return;
    }

    if (reply.action === 'cancel') {
      if (pendingAction || pendingConfirmation || pendingSms) {
        handleCancelAction();
        return;
      }
      sendMessage(reply.prompt || reply.label);
      return;
    }

    sendMessage(reply.prompt || reply.label);
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
          accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.csv,.json"
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
            <div
              className="chat-transcript"
              ref={transcriptRef}
            >
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

                {/* SMS verification card */}
                {pendingSms ? (
                  <InlineAssistantPanel className="sms-card">
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
                        Verify
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
