import { useEffect, useMemo, useRef, useState } from 'react';
import atbLogo from '../assets/atb-logo.png';
import {
  EMPTY_AGENT_CONTEXT,
  cancelAgentAction,
  confirmAgentAction,
  deriveAgentContext,
  executePreparedAction,
  getAgentErrorMessage,
  openDownloadUrl,
  sendAgentMessage,
  stripPrivateResourceFields,
} from '../services/agentApi.js';
import MessageBubble from './MessageBubble.jsx';
import TypingIndicator from './TypingIndicator.jsx';

const UI_TEXT = {
  title: 'Arab Tunisian Bank AI Agent',
  online: 'Online',
  welcome: 'Hello! How can I help you today?',
  placeholder: 'Write your message...',
  fallback: 'I reviewed your request.',
  confirmContinue: 'Please confirm to continue.',
  smsSent: 'Enter the SMS code sent to',
  smsContinue: 'Enter the SMS code to continue.',
  highRiskBlocked: 'This action requires SMS verification before execution.',
  actionCancelled: 'Action cancelled.',
  confirm: 'Confirm',
  cancel: 'Cancel',
  attachment: 'Add an attachment',
  send: 'Send message',
  maximize: 'Maximize panel',
  reduce: 'Reduce panel',
  close: 'Close widget',
  openLauncher: 'Open ATB Assistant',
  closeLauncher: 'Close ATB Assistant',
};

const COMPLETION_TEXT = {
  paymentCompleted: 'Payment completed.',
  transferCompleted: 'Transfer completed.',
  documentReady: 'Document ready.',
  documentFallback: 'Your requested banking document is ready.',
  complaintSubmitted: 'Complaint submitted.',
  appointmentBooked: 'Appointment booked.',
  balanceRetrieved: 'Balance retrieved.',
  actionCompleted: 'Action completed.',
  reference: 'Reference',
  amount: 'Amount',
  provider: 'Provider',
  beneficiary: 'Beneficiary',
  status: 'Status',
  branch: 'Branch',
  date: 'Date',
  time: 'Time',
  account: 'Account',
  balance: 'Balance',
};

function createId(prefix) {
  if (window.crypto?.randomUUID) {
    return `${prefix}-${window.crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createMessage(role, content, extra = {}) {
  return {
    id: createId(role),
    role,
    content,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

function buildConversationHistory(messages) {
  return messages
    .filter((message) => message.content && ['user', 'bot'].includes(message.role))
    .map((message) => ({
      role: message.role === 'user' ? 'user' : 'assistant',
      content: message.content,
    }));
}

function clearMessageActions(messages) {
  return messages.map((message) =>
    message.quickActions?.length ? { ...message, quickActions: [] } : message,
  );
}

function formatMoney(amount, currency = 'TND') {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount)) return amount ? `${amount} ${currency}` : '';
  return `${numericAmount.toFixed(3)} ${currency || 'TND'}`;
}

function buildCompletionText(data = {}) {
  const copy = COMPLETION_TEXT;

  if (data.paymentReference) {
    return [
      copy.paymentCompleted,
      '',
      `**${copy.reference}:** ${data.paymentReference}`,
      `**${copy.amount}:** ${formatMoney(data.amount, data.currency)}`,
      `**${copy.provider}:** ${data.provider || copy.provider}`,
    ].join('\n');
  }

  if (data.transferReference) {
    return [
      copy.transferCompleted,
      '',
      `**${copy.reference}:** ${data.transferReference}`,
      `**${copy.amount}:** ${formatMoney(data.amount, data.currency)}`,
      `**${copy.beneficiary}:** ${data.beneficiaryName || data.beneficiaryId || copy.beneficiary}`,
    ].join('\n');
  }

  if (data.document) {
    return [
      copy.documentReady,
      '',
      data.document.title || copy.documentFallback,
    ].join('\n');
  }

  if (data.complaint) {
    return [
      copy.complaintSubmitted,
      '',
      `**${copy.reference}:** ${data.complaint.reference}`,
      `**${copy.status}:** ${data.complaint.status || 'Open'}`,
    ].join('\n');
  }

  if (data.appointment) {
    return [
      copy.appointmentBooked,
      '',
      `**${copy.reference}:** ${data.appointment.appointmentId}`,
      `**${copy.branch}:** ${data.appointment.branch}`,
      `**${copy.date}:** ${data.appointment.date}`,
      `**${copy.time}:** ${data.appointment.time}`,
    ].join('\n');
  }

  if (data.account?.balance !== undefined) {
    return [
      copy.balanceRetrieved,
      '',
      `**${copy.account}:** ${data.account.accountNumber || data.account.id}`,
      `**${copy.balance}:** ${formatMoney(data.account.balance, data.account.currency)}`,
      `**${copy.status}:** ${data.account.status || 'Active'}`,
    ].join('\n');
  }

  return copy.actionCompleted;
}

const normalizedCommand = (text) =>
  String(text || '').trim().toLowerCase().replace(/[.!?]+$/g, '');

const isCancelCommand = (text) =>
  ['cancel', 'cancel it', 'stop', 'never mind'].includes(normalizedCommand(text));

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

function MaximizeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 4H4v4h2V6h2V4Zm8 0v2h2v2h2V4h-4ZM6 16H4v4h4v-2H6v-2Zm12 2h-2v2h4v-4h-2v2Z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m7.4 6 10.6 10.6-1.4 1.4L6 7.4 7.4 6Zm10.6 1.4L7.4 18 6 16.6 16.6 6 18 7.4Z" />
    </svg>
  );
}

function AttachmentIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M17.8 6.2a4.2 4.2 0 0 0-5.9 0L5.7 12.4a3 3 0 0 0 4.2 4.2l6.1-6.1-1.4-1.4-6.1 6.1a1 1 0 0 1-1.4-1.4l6.2-6.2a2.2 2.2 0 0 1 3.1 3.1l-6.3 6.3a4.7 4.7 0 0 1-6.6-6.6l5.7-5.7-1.4-1.4-5.7 5.7a6.7 6.7 0 0 0 9.5 9.5l6.3-6.3a4.2 4.2 0 0 0-.1-6Z" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 12.8h12.1l-4.8 4.8 1.3 1.4L20 11.6 12.6 4.2l-1.3 1.4 4.8 4.8H4v2.4Z" />
    </svg>
  );
}

function ChatWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [agentContext, setAgentContext] = useState(EMPTY_AGENT_CONTEXT);
  const [pendingAction, setPendingAction] = useState(null);
  const [pendingConfirmation, setPendingConfirmation] = useState(null);
  const [pendingSms, setPendingSms] = useState(null);
  const [pendingFieldAction, setPendingFieldAction] = useState(null);
  const conversationId = useMemo(() => createId('conversation'), []);
  const inputRef = useRef(null);
  const transcriptRef = useRef(null);
  const closeTimerRef = useRef(null);
  const text = UI_TEXT;

  useEffect(() => {
    if (!transcriptRef.current) return;
    transcriptRef.current.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages, isTyping]);

  useEffect(() => {
    if (!isOpen) return;
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 180);
    return () => window.clearTimeout(focusTimer);
  }, [isOpen]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  const appendAssistantMessage = ({
    text,
    quickActions = [],
    isError = false,
    actionContext = null,
  }) => {
    setMessages((currentMessages) => [
      ...clearMessageActions(currentMessages),
      createMessage('bot', text || UI_TEXT.fallback, {
        quickActions,
        isError,
        actionContext,
      }),
    ]);
  };

  const appendErrorMessage = (error) => {
    appendAssistantMessage({
      text: getAgentErrorMessage(error),
      isError: true,
    });
  };

  const clearPendingInteractionState = () => {
    setPendingAction(null);
    setPendingConfirmation(null);
    setPendingSms(null);
  };

  const applyChatResponseState = (response) => {
    const raw = response.raw || {};
    const agentMode = raw.agentMode || 'informational_answer';

    if (raw.status === 'action_prepared') {
      setPendingAction(raw.data?.preparation || null);
      setPendingConfirmation(null);
      setPendingSms(null);
      setPendingFieldAction(null);
      return;
    }

    if (raw.status === 'missing_fields') {
      setPendingAction(null);
      setPendingConfirmation(null);
      setPendingSms(null);
      setPendingFieldAction({
        actionName: raw.data?.ai?.actionName || raw.data?.actionName || null,
        missingFields: raw.data?.missingFields || [],
        collectedFields: raw.data?.finalPayload || {},
      });
      return;
    }

    if (raw.status === 'file_generated' && agentMode === 'file_generation') {
      setPendingFieldAction(null);
      clearPendingInteractionState();
      return;
    }

    setPendingFieldAction(null);
    clearPendingInteractionState();
  };

  const appendNormalizedAssistantResponse = (response) => {
    appendAssistantMessage({
      text: response.text || text.fallback,
      quickActions: response.quickActions,
      actionContext: response.actionContext,
    });
  };

  const handleExecutionResponse = (response) => {
    const raw = response.raw || {};

    if (raw.status === 'completed') {
      clearPendingInteractionState();
      setPendingFieldAction(null);
      setAgentContext(EMPTY_AGENT_CONTEXT);
      appendAssistantMessage({
        text: buildCompletionText(raw.data || {}),
        quickActions: response.quickActions,
        actionContext: response.actionContext,
      });
      return;
    }

    if (raw.status === 'confirmation_required') {
      setPendingAction(null);
      setPendingConfirmation(raw.data || null);
      setPendingSms(null);
      appendAssistantMessage({
        text: text.confirmContinue,
        quickActions: [
          { label: text.confirm, action: 'confirm_pending' },
          { label: text.cancel, action: 'cancel' },
        ],
        actionContext: response.actionContext,
      });
      return;
    }

    if (raw.status === 'sms_required') {
      setPendingAction(null);
      setPendingConfirmation(null);
      setPendingSms(raw.data || null);
      appendAssistantMessage({
        text: raw.data?.maskedPhoneNumber
          ? `${text.smsSent} ${raw.data.maskedPhoneNumber}.`
          : text.smsContinue,
        quickActions: [{ label: text.cancel, action: 'cancel' }],
        actionContext: response.actionContext,
      });
      return;
    }

    if (raw.status === 'high_risk_blocked') {
      clearPendingInteractionState();
      appendAssistantMessage({
        text: text.highRiskBlocked,
        isError: true,
        actionContext: response.actionContext,
      });
      return;
    }

    appendAssistantMessage({
      text: raw.message || response.text || text.fallback,
      isError: true,
      actionContext: response.actionContext,
    });
  };

  const openWidget = () => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }

    setIsClosing(false);
    setIsOpen(true);

    if (!hasOpened) {
      setMessages([createMessage('bot', text.welcome)]);
      setHasOpened(true);
    }
  };

  const closeWidget = () => {
    if (!isOpen || isClosing) {
      return;
    }

    setIsClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      setIsOpen(false);
      setIsClosing(false);
      setIsExpanded(false);
      closeTimerRef.current = null;
    }, 210);
  };

  const handleContinueAction = async ({ appendUser = false } = {}) => {
    if (!pendingAction || isTyping) return;

    if (appendUser) {
      setMessages((currentMessages) => [
        ...clearMessageActions(currentMessages),
        createMessage('user', text.confirm),
      ]);
    }

    setIsTyping(true);

    try {
      const response = await executePreparedAction(pendingAction);

      if (response.raw?.status === 'confirmation_required' && response.raw?.data?.confirmationId) {
        const confirmationResponse = await confirmAgentAction(
          response.raw.data.confirmationId,
        );
        handleExecutionResponse(confirmationResponse);
        return;
      }

      handleExecutionResponse(response);
    } catch (error) {
      appendErrorMessage(error);
    } finally {
      setIsTyping(false);
    }
  };

  const handleConfirmAction = async ({ appendUser = false } = {}) => {
    if (!pendingConfirmation?.confirmationId || isTyping) return;

    if (appendUser) {
      setMessages((currentMessages) => [
        ...clearMessageActions(currentMessages),
        createMessage('user', text.confirm),
      ]);
    }

    setIsTyping(true);

    try {
      const response = await confirmAgentAction(pendingConfirmation.confirmationId);
      handleExecutionResponse(response);
    } catch (error) {
      appendErrorMessage(error);
    } finally {
      setIsTyping(false);
    }
  };

  const handleCancelAction = async ({ appendUser = false } = {}) => {
    if (isTyping) return;

    if (appendUser) {
      setMessages((currentMessages) => [
        ...clearMessageActions(currentMessages),
        createMessage('user', text.cancel),
      ]);
    }

    setIsTyping(true);

    try {
      if (pendingConfirmation?.confirmationId) {
        await cancelAgentAction(pendingConfirmation.confirmationId);
      }

      if (pendingSms?.confirmationId) {
        await cancelAgentAction(pendingSms.confirmationId);
      }

      setPendingAction(null);
      setPendingConfirmation(null);
      setPendingSms(null);
      setPendingFieldAction(null);
      appendAssistantMessage({ text: text.actionCancelled });
    } catch (error) {
      appendErrorMessage(error);
    } finally {
      setIsTyping(false);
    }
  };

  const sendMessage = async (value = inputValue) => {
    const trimmedMessage = value.trim();

    if (!trimmedMessage || isTyping) {
      return;
    }

    const conversationHistory = buildConversationHistory(messages);
    const outgoingAgentContext = {
      ...agentContext,
      extractedFields: stripPrivateResourceFields(agentContext?.extractedFields || {}),
      pendingAction: pendingFieldAction,
    };

    setMessages((currentMessages) => [
      ...clearMessageActions(currentMessages),
      createMessage('user', trimmedMessage),
    ]);
    setInputValue('');

    if (
      isCancelCommand(trimmedMessage) &&
      (pendingAction || pendingConfirmation || pendingSms)
    ) {
      await handleCancelAction();
      return;
    }

    if (isProceedCommand(trimmedMessage)) {
      if (pendingConfirmation) {
        await handleConfirmAction();
        return;
      }

      if (pendingAction) {
        await handleContinueAction();
        return;
      }
    }

    setIsTyping(true);

    try {
      const response = await sendAgentMessage({
        message: trimmedMessage,
        conversationId,
        conversationHistory,
        profileContext: {},
        agentContext: outgoingAgentContext,
        payload: {},
      });

      applyChatResponseState(response);
      setAgentContext((currentContext) => deriveAgentContext(currentContext, response));
      appendNormalizedAssistantResponse(response);
    } catch (error) {
      appendErrorMessage(error);
    } finally {
      setIsTyping(false);
    }
  };

  const handleMessageAction = async (action) => {
    if (!action || isTyping) return;

    if (action.action === 'download' && action.url) {
      try {
        await openDownloadUrl(action.url);
      } catch (error) {
        appendErrorMessage(error);
      }
      return;
    }

    if (action.action === 'open_url' && action.url) {
      window.open(action.url, '_blank', 'noopener,noreferrer');
      return;
    }

    if (action.action === 'continue') {
      if (pendingAction) {
        await handleContinueAction({ appendUser: true });
        return;
      }
      await sendMessage(action.prompt || action.label);
      return;
    }

    if (action.action === 'confirm_pending') {
      if (pendingConfirmation) {
        await handleConfirmAction({ appendUser: true });
        return;
      }
      await sendMessage(action.prompt || action.label);
      return;
    }

    if (action.action === 'cancel') {
      if (pendingAction || pendingConfirmation || pendingSms) {
        await handleCancelAction({ appendUser: true });
        return;
      }
      await sendMessage(action.prompt || action.label);
      return;
    }

    await sendMessage(action.prompt || action.label);
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    sendMessage();
  };

  return (
    <section className="chat-widget-shell" aria-label={text.title}>
      {isOpen && (
        <div
          className={[
            'chat-window',
            isClosing ? 'chat-window-closing' : '',
            isExpanded ? 'chat-window-expanded' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          role="dialog"
          aria-label={text.title}
        >
          <header className="chat-header">
            <div className="chat-avatar" aria-hidden="true">
              <img src={atbLogo} alt="" />
            </div>
            <div className="chat-heading">
              <h1>{text.title}</h1>
              <div className="chat-status">
                <span aria-hidden="true" />
                {text.online}
              </div>
            </div>
            <div className="chat-header-actions">
              <button
                className="chat-icon-button"
                type="button"
                onClick={() => setIsExpanded((current) => !current)}
                aria-label={isExpanded ? text.reduce : text.maximize}
                aria-pressed={isExpanded}
              >
                <MaximizeIcon />
              </button>
              <button
                className="chat-icon-button"
                type="button"
                onClick={closeWidget}
                aria-label={text.close}
              >
                <CloseIcon />
              </button>
            </div>
          </header>

          <div className="chat-body">
            <div className="chat-transcript" ref={transcriptRef}>
              {messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  onAction={handleMessageAction}
                />
              ))}
              {isTyping && <TypingIndicator />}
            </div>
          </div>

          <form className="chat-input-form" onSubmit={handleSubmit}>
            <button
              className="chat-attachment-button"
              type="button"
              aria-label={text.attachment}
            >
              <AttachmentIcon />
            </button>
            <input
              ref={inputRef}
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              placeholder={text.placeholder}
              aria-label="Message"
              disabled={isTyping}
            />
            <button
              type="submit"
              className="chat-send-button"
              disabled={!inputValue.trim() || isTyping}
              aria-label={text.send}
            >
              <SendIcon />
            </button>
          </form>
        </div>
      )}

      <button
        type="button"
        className={`chat-launcher ${isOpen ? 'chat-launcher-open' : ''}`}
        onClick={isOpen ? closeWidget : openWidget}
        aria-label={isOpen ? text.closeLauncher : text.openLauncher}
        aria-expanded={isOpen}
      >
        <span className="chat-launcher-ring" aria-hidden="true" />
        <img src={atbLogo} alt="ATB" />
        {!isOpen && <span className="chat-launcher-badge">1</span>}
      </button>
    </section>
  );
}

export default ChatWidget;
