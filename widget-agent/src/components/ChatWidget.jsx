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
  verifyAndExecuteAgentAction,
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
  smsSentPrefix: 'For your security, I sent an SMS code to',
  smsContinue: 'For your security, I sent an SMS code.',
  highRiskBlocked: 'This action requires SMS verification before execution.',
  actionCancelled: 'Action cancelled.',
  confirm: 'Confirm',
  cancel: 'Cancel',
  send: 'Send message',
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

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m7.4 6 10.6 10.6-1.4 1.4L6 7.4 7.4 6Zm10.6 1.4L7.4 18 6 16.6 16.6 6 18 7.4Z" />
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
  const [hasOpened, setHasOpened] = useState(false);
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [agentContext, setAgentContext] = useState(EMPTY_AGENT_CONTEXT);
  const [pendingAction, setPendingAction] = useState(null);
  const [pendingConfirmation, setPendingConfirmation] = useState(null);
  const [pendingSms, setPendingSms] = useState(null);
  const [smsCode, setSmsCode] = useState('');
  const [smsError, setSmsError] = useState('');
  const [pendingFieldAction, setPendingFieldAction] = useState(null);
  const conversationId = useMemo(() => createId('conversation'), []);
  const inputRef = useRef(null);
  const transcriptRef = useRef(null);
  const closeTimerRef = useRef(null);
  const launcherDragRef = useRef(null);
  const suppressLauncherClickRef = useRef(false);
  const text = UI_TEXT;
  const isEmbeddedWidget =
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('widget-embedded-document');

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

  useEffect(() => {
    if (!isEmbeddedWidget || window.parent === window) {
      return;
    }

    window.parent.postMessage(isOpen ? 'ATB_WIDGET_OPEN' : 'ATB_WIDGET_CLOSED', '*');
  }, [isEmbeddedWidget, isOpen]);

  useEffect(() => {
    if (!isEmbeddedWidget) {
      return;
    }

    const handleLayoutMessage = (event) => {
      const message = event.data || {};

      if (message.type !== 'ATB_WIDGET_LAYOUT') {
        return;
      }

      const root = document.documentElement;
      root.style.setProperty('--embed-launcher-left', `${message.launcherLeft}px`);
      root.style.setProperty('--embed-launcher-top', `${message.launcherTop}px`);
      root.style.setProperty('--embed-panel-left', `${message.panelLeft}px`);
      root.style.setProperty('--embed-panel-top', `${message.panelTop}px`);
      root.style.setProperty('--embed-panel-width', `${message.panelWidth}px`);
      root.style.setProperty('--embed-panel-height', `${message.panelHeight}px`);
    };

    window.addEventListener('message', handleLayoutMessage);
    return () => window.removeEventListener('message', handleLayoutMessage);
  }, [isEmbeddedWidget]);

  const appendAssistantMessage = ({
    text,
    quickActions = [],
    isError = false,
    actionContext = null,
    smsChallenge = null,
  }) => {
    setMessages((currentMessages) => [
      ...clearMessageActions(currentMessages),
      createMessage('bot', text || UI_TEXT.fallback, {
        quickActions,
        isError,
        actionContext,
        smsChallenge,
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
    setSmsCode('');
    setSmsError('');
  };

  const applyChatResponseState = (response) => {
    const raw = response.raw || {};
    const agentMode = raw.agentMode || 'informational_answer';

    if (raw.status === 'action_prepared') {
      setPendingAction(raw.data?.preparation || null);
      setPendingConfirmation(null);
      setPendingSms(null);
      setSmsCode('');
      setSmsError('');
      setPendingFieldAction(null);
      return;
    }

    if (raw.status === 'missing_fields') {
      const nextPendingFieldAction = raw.data?.pendingAction || {
        actionName: raw.data?.ai?.actionName || raw.data?.actionName || null,
        missingFields: raw.data?.missingFields || [],
        collectedFields: raw.data?.finalPayload || {},
      };
      setPendingAction(null);
      setPendingConfirmation(null);
      setPendingSms(null);
      setSmsCode('');
      setSmsError('');
      setPendingFieldAction(nextPendingFieldAction);
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
      setSmsCode('');
      setSmsError('');
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
      setSmsCode('');
      setSmsError('');
      appendAssistantMessage({
        text: raw.data?.maskedPhoneNumber
          ? `${text.smsSentPrefix} ${raw.data.maskedPhoneNumber}.`
          : text.smsContinue,
        smsChallenge: raw.data?.confirmationId
          ? {
              confirmationId: raw.data.confirmationId,
              actionName: raw.data.actionName,
              finalPayload: raw.data.finalPayload,
            }
          : null,
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
      setSmsCode('');
      setSmsError('');
      setPendingFieldAction(null);
      appendAssistantMessage({ text: text.actionCancelled });
    } catch (error) {
      appendErrorMessage(error);
    } finally {
      setIsTyping(false);
    }
  };

  const getSmsErrorMessage = (error) => {
    const status = error?.data?.status;
    const attemptsRemaining = error?.data?.data?.attemptsRemaining;

    if (status === 'sms_invalid' && attemptsRemaining !== undefined) {
      return `Invalid SMS code. Attempts remaining: ${attemptsRemaining}.`;
    }

    return error?.message || getAgentErrorMessage(error);
  };

  const handleSmsVerification = async (codeOverride = smsCode) => {
    const code = String(codeOverride || '').trim();

    if (!pendingSms?.confirmationId || isTyping) return;

    if (!code) {
      setSmsError('Please enter the SMS code.');
      return;
    }

    setSmsError('');
    setIsTyping(true);

    try {
      const response = await verifyAndExecuteAgentAction(
        pendingSms.confirmationId,
        code,
      );
      setSmsCode('');
      handleExecutionResponse(response);
    } catch (error) {
      setSmsError(getSmsErrorMessage(error));
    } finally {
      setIsTyping(false);
    }
  };

  const sendMessage = async (value = inputValue) => {
    const trimmedMessage = value.trim();

    if (!trimmedMessage || isTyping) {
      return;
    }

    if (pendingSms?.confirmationId && /^\d{4,8}$/.test(trimmedMessage)) {
      setInputValue('');
      await handleSmsVerification(trimmedMessage);
      return;
    }

    const conversationHistory = buildConversationHistory(messages);
    const outgoingAgentContext = {
      ...agentContext,
      extractedFields: stripPrivateResourceFields(agentContext?.extractedFields || {}),
      pendingAction: pendingFieldAction || agentContext?.pendingAction || null,
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

    if (action.action === 'update_sms_code') {
      setSmsCode(String(action.code || '').replace(/\D/g, '').slice(0, 8));
      setSmsError('');
      return;
    }

    if (action.action === 'verify_sms') {
      await handleSmsVerification(action.code);
      return;
    }

    await sendMessage(action.prompt || action.label);
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    sendMessage();
  };

  const handleLauncherPointerDown = (event) => {
    if (!isEmbeddedWidget || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    suppressLauncherClickRef.current = true;
    launcherDragRef.current = {
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      totalX: 0,
      totalY: 0,
      didDrag: false,
    };

    window.parent.postMessage(
      {
        type: 'ATB_WIDGET_DRAG_START',
        clientX: event.clientX,
        clientY: event.clientY,
      },
      '*',
    );
  };

  const handleLauncherPointerMove = (event) => {
    const dragState = launcherDragRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    const dx = event.clientX - dragState.lastX;
    const dy = event.clientY - dragState.lastY;

    dragState.lastX = event.clientX;
    dragState.lastY = event.clientY;
    dragState.totalX += dx;
    dragState.totalY += dy;

    if (!dragState.didDrag && Math.hypot(dragState.totalX, dragState.totalY) > 4) {
      dragState.didDrag = true;
    }

    if (!dragState.didDrag) {
      return;
    }

    event.preventDefault();

    if (isEmbeddedWidget) {
      window.parent.postMessage(
        {
          type: 'ATB_WIDGET_DRAG_MOVE',
          clientX: event.clientX,
          clientY: event.clientY,
          dx,
          dy,
        },
        '*',
      );
      return;
    }

    window.parent.postMessage(
      {
        type: 'ATB_WIDGET_DRAG_MOVE',
        clientX: event.clientX,
        clientY: event.clientY,
        dx,
        dy,
      },
      '*',
    );
  };

  const handleLauncherPointerUp = (event) => {
    const dragState = launcherDragRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    if (isEmbeddedWidget) {
      launcherDragRef.current = null;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      window.parent.postMessage({ type: 'ATB_WIDGET_DRAG_END' }, '*');
      return;
    }

    launcherDragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);

    if (dragState.didDrag) {
      suppressLauncherClickRef.current = true;
      window.parent.postMessage({ type: 'ATB_WIDGET_DRAG_END' }, '*');
      window.setTimeout(() => {
        suppressLauncherClickRef.current = false;
      }, 0);
    }
  };

  const handleLauncherClick = () => {
    if (suppressLauncherClickRef.current) {
      return;
    }

    if (isOpen) {
      closeWidget();
      return;
    }

    openWidget();
  };

  useEffect(() => {
    if (!isEmbeddedWidget) {
      return;
    }

    const handleLauncherControlMessage = (event) => {
      const message = event.data || {};

      if (message.type === 'ATB_WIDGET_LAUNCHER_CLICK') {
        launcherDragRef.current = null;
        suppressLauncherClickRef.current = false;

        if (isOpen) {
          closeWidget();
        } else {
          openWidget();
        }
        return;
      }

      if (message.type === 'ATB_WIDGET_DRAG_FINISHED') {
        launcherDragRef.current = null;
        window.setTimeout(() => {
          suppressLauncherClickRef.current = false;
        }, 0);
      }
    };

    window.addEventListener('message', handleLauncherControlMessage);
    return () => window.removeEventListener('message', handleLauncherControlMessage);
  }, [isEmbeddedWidget, isOpen]);

  return (
    <section
      className={[
        'chat-widget-shell',
        isOpen ? 'chat-widget-shell-open' : '',
        isEmbeddedWidget ? 'chat-widget-shell-embedded' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label={text.title}
    >
      {isOpen && (
        <div
          className={[
            'chat-window',
            isClosing ? 'chat-window-closing' : '',
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
                  message={{
                    ...message,
                    smsChallenge:
                      message.smsChallenge &&
                      pendingSms?.confirmationId === message.smsChallenge.confirmationId
                        ? {
                            ...message.smsChallenge,
                            code: smsCode,
                            error: smsError,
                            disabled: isTyping,
                          }
                        : null,
                  }}
                  onAction={handleMessageAction}
                />
              ))}
              {isTyping && <TypingIndicator />}
            </div>
          </div>

          <form className="chat-input-form" onSubmit={handleSubmit}>
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
        onClick={handleLauncherClick}
        onPointerDown={handleLauncherPointerDown}
        onPointerMove={handleLauncherPointerMove}
        onPointerUp={handleLauncherPointerUp}
        onPointerCancel={handleLauncherPointerUp}
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
