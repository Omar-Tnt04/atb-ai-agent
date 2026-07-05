import { useEffect, useMemo, useRef, useState } from 'react';
import atbLogo from '../assets/atb-logo.png';
import {
  EMPTY_AGENT_CONTEXT,
  cancelAgentAction,
  clearAllWidgetState,
  clearChatState,
  confirmAgentAction,
  deriveAgentContext,
  clearPageGoalResume,
  dispatchPageActions,
  executePreparedAction,
  fetchBrowserAgentJob,
  triggerBrowserAgentJobStart,
  getAgentErrorMessage,
  openDownloadUrl,
  readChatState,
  readPageGoalResume,
  requestPageSnapshot,
  requestSiteContext,
  savePageGoalResume,
  saveChatState,
  sendAgentMessage,
  stripPrivateResourceFields,
  verifyAndExecuteAgentAction,
} from '../services/agentApi.js';
import {
  buildCacheContext,
  getMode,
  getSiteContext,
  saveContactFacts,
  saveDocumentIndex,
  saveSiteContext,
  setMode,
} from '../services/widgetCache.js';
import MessageBubble from './MessageBubble.jsx';
import StatusIndicator from './StatusIndicator.jsx';
import { useCyclingStatus } from '../hooks/useCyclingStatus.js';
import { selectLoadingSequence, BROWSER_AGENT_SEQUENCE } from '../utils/loadingStatus.js';

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
  refresh: 'New conversation',
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
  return messages;
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
    'yes confirm',
    'ok confirm',
    'confirm it',
  ].includes(normalizedCommand(text));

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m7.4 6 10.6 10.6-1.4 1.4L6 7.4 7.4 6Zm10.6 1.4L7.4 18 6 16.6 16.6 6 18 7.4Z" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" />
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

// Max age for a saved pendingBrowserJob before it is discarded without backend verification.
const PENDING_JOB_TTL_MS = 10 * 60 * 1000; // 10 minutes

function ChatWidget() {
  // Restore any conversation stashed before the host page navigated (iframe reload resets React).
  const [restored] = useState(() => readChatState());
  // When a pendingBrowserJob exists in restored state, we NEVER blindly restore it — we verify
  // with the backend first. Until verification completes, start with clean defaults to avoid
  // showing stale failed/done messages to the user. Normal conversations (no pending job) restore
  // immediately as before.
  const hasPendingJob = Boolean(restored?.pendingBrowserJob?.jobId);
  const [isOpen, setIsOpen] = useState(() => hasPendingJob ? false : (restored?.isOpen ?? false));
  const [isClosing, setIsClosing] = useState(false);
  const [hasOpened, setHasOpened] = useState(() => hasPendingJob ? false : (restored?.hasOpened ?? false));
  const [messages, setMessages] = useState(() => hasPendingJob ? [] : (restored?.messages ?? []));
  const [agentMode, setAgentMode] = useState(() => getMode());
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [agentContext, setAgentContext] = useState(EMPTY_AGENT_CONTEXT);
  const [pendingAction, setPendingAction] = useState(null);
  const [pendingConfirmation, setPendingConfirmation] = useState(null);
  const [pendingSms, setPendingSms] = useState(null);
  const [smsCode, setSmsCode] = useState('');
  const [smsError, setSmsError] = useState('');
  const [pendingFieldAction, setPendingFieldAction] = useState(null);
  const [pendingBrowserJob, setPendingBrowserJob] = useState(null);
  const [animatingId, setAnimatingId] = useState(null);
  const [loadingSequence, setLoadingSequence] = useState([]);
  const loadingStatus = useCyclingStatus(isTyping, loadingSequence);
  const conversationId = useMemo(
    () => restored?.conversationId || createId('conversation'),
    [restored],
  );
  const browserPollRef = useRef(null);
  const abandonRef = useRef(false);
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
    animate = false,
  }) => {
    const botMessage = createMessage('bot', text || UI_TEXT.fallback, {
      quickActions,
      isError,
      actionContext,
      smsChallenge,
    });
    if (animate) {
      setAnimatingId(botMessage.id);
    }
    setMessages((currentMessages) => [...clearMessageActions(currentMessages), botMessage]);
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
      animate: true,
    });
  };

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  // Drive a backend browser-use job to completion. Keeps the typing/loading state up, polls for the
  // result, and renders the final answer. Survives a host-page navigation: the jobId is persisted in
  // sessionStorage and a freshly-injected widget resumes polling the same job on mount.
  const pollBrowserJob = async (jobId) => {
    if (!jobId || browserPollRef.current === jobId) {
      if (jobId && browserPollRef.current === jobId) console.log('[WIDGET] polling already active for job:', jobId);
      return;
    }
    browserPollRef.current = jobId;
    setIsTyping(true);
    setLoadingSequence(BROWSER_AGENT_SEQUENCE);

    const deadline = Date.now() + 270_000;
    try {
      while (Date.now() < deadline) {
        await sleep(2500);
        const data = await fetchBrowserAgentJob(jobId);
        const status = data?.status;

        if (status === 'browser_agent_done') {
          appendAssistantMessage({ text: data.assistantMessage || text.fallback, animate: true });
          return;
        }
        if (status === 'browser_agent_error' || status === 'not_found') {
          appendAssistantMessage({
            text: "I couldn't finish that on the ATB website. Please try again.",
            isError: true,
          });
          return;
        }
        // browser_agent_running → keep polling.
      }
      appendAssistantMessage({
        text: 'The website request is taking longer than expected. Please try again.',
        isError: true,
      });
    } finally {
      browserPollRef.current = null;
      setPendingBrowserJob(null);
      setIsTyping(false);
      // Clear bridge state from atb.tn localStorage — job is done.
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'ATB_WIDGET_CLEAR_BRIDGE' }, '*');
      }
    }
  };

  // Persist the conversation so a host-page navigation (which reloads the iframe) doesn't wipe it.
  // Force isOpen=true when a browser-use job is active so the widget always reopens after navigation.
  useEffect(() => {
    if (!hasOpened && messages.length === 0 && !pendingBrowserJob) {
      return;
    }
    const stateIsOpen = pendingBrowserJob ? true : isOpen;
    saveChatState({ isOpen: stateIsOpen, hasOpened, messages, conversationId, pendingBrowserJob });
  }, [isOpen, hasOpened, messages, conversationId, pendingBrowserJob]);

  // Mount-time browser-use job handling. Three paths:
  //
  // A) localStorage has a pendingBrowserJob → verify with backend before restoring.
  //    - TTL expired (>10 min): clear storage silently, start fresh.
  //    - Backend says running: restore messages + state, resume polling.
  //    - Backend says done/failed/not_found: clear storage, start fresh (no stale messages shown).
  //
  // B) localStorage had nothing BUT content.js bridge may have state → listen for
  //    ATB_WIDGET_BRIDGE_RESTORE (fired when browser-use just navigated the host tab).
  //    Bridge restore is trusted without backend re-check (it's an immediate-navigation path).
  //
  // C) Neither → widget starts clean.
  useEffect(() => {
    const job = restored?.pendingBrowserJob;
    console.log('[ATB_WIDGET_APP] mount: hasPendingJob =', Boolean(job?.jobId), job?.jobId ? '(jobId=' + job.jobId + ')' : '');

    const discardStaleJob = (reason) => {
      console.log('[ATB_WIDGET_APP] stale job cleared:', reason);
      clearChatState();
      setMessages([]);
      setPendingBrowserJob(null);
      setIsTyping(false);
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'ATB_WIDGET_CLEAR_BRIDGE' }, '*');
      }
    };

    if (job?.jobId) {
      // Path A — localStorage has a pending job. Verify before restoring.
      if (job.createdAt && Date.now() - job.createdAt > PENDING_JOB_TTL_MS) {
        discardStaleJob('TTL exceeded (' + Math.round((Date.now() - job.createdAt) / 60000) + ' min old)');
        return undefined;
      }
      let cancelled = false;
      (async () => {
        try {
          const data = await fetchBrowserAgentJob(job.jobId);
          if (cancelled || abandonRef.current) return;
          const status = data?.status;
          console.log('[ATB_WIDGET_APP] job verification: status =', status);
          if (status === 'browser_agent_running') {
            // Job still running — resume polling only. Do NOT call /start again;
            // the agent process is already running and a second /start spawns a duplicate.
            console.log('[ATB_WIDGET_APP] resumed polling for job:', job.jobId);
            console.log('[WIDGET] start ignored, job already running:', job.jobId);
            setMessages(restored.messages ?? []);
            setHasOpened(true);
            setIsOpen(true);
            setIsTyping(true);
            setLoadingSequence(BROWSER_AGENT_SEQUENCE);
            setPendingBrowserJob(job);
            pollBrowserJob(job.jobId);
          } else if (status === 'browser_agent_done') {
            // Job finished while the host page was navigating — show result, don't discard.
            console.log('[ATB_WIDGET_APP] job done at verification — showing result');
            setMessages(restored.messages ?? []);
            setHasOpened(true);
            setIsOpen(true);
            setIsTyping(false);
            appendAssistantMessage({ text: data?.assistantMessage || text.fallback, animate: true });
            clearChatState();
            if (window.parent !== window) {
              window.parent.postMessage({ type: 'ATB_WIDGET_CLEAR_BRIDGE' }, '*');
            }
          } else {
            discardStaleJob('job status = ' + status);
          }
        } catch {
          if (!cancelled) discardStaleJob('network error verifying job');
        }
      })();
      return () => { cancelled = true; };
    }

    // Path B — no localStorage pending job. Listen for bridge restore from content.js.
    console.log('[ATB_WIDGET_APP] no localStorage pending job — listening for bridge restore');
    const onBridgeRestore = (event) => {
      const msg = event.data || {};
      if (msg.type !== 'ATB_WIDGET_BRIDGE_RESTORE' || !msg.state?.pendingBrowserJob?.jobId) return;
      const bridgeJob = msg.state.pendingBrowserJob;
      console.log('[ATB_WIDGET_APP] bridge restore received, jobId:', bridgeJob.jobId);
      // Bridge restore means the host page just navigated — the agent is already running.
      // Resume polling only. Do NOT call /start again; that spawns a duplicate agent.
      if (browserPollRef.current === bridgeJob.jobId) {
        console.log('[WIDGET] polling already active for job:', bridgeJob.jobId);
        return;
      }
      console.log('[WIDGET] start ignored, job already running:', bridgeJob.jobId);
      setHasOpened(true);
      setIsOpen(true);
      setIsTyping(true);
      setLoadingSequence(BROWSER_AGENT_SEQUENCE);
      setPendingBrowserJob(bridgeJob);
      if (Array.isArray(msg.state.messages) && msg.state.messages.length > 0) {
        setMessages(msg.state.messages);
      }
      pollBrowserJob(bridgeJob.jobId);
    };
    window.addEventListener('message', onBridgeRestore);
    return () => window.removeEventListener('message', onBridgeRestore);
    // Run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dev reset: content.js sends ATB_WIDGET_DEV_RESET when __atbWidgetReset() is called from
  // the ATB page console. Clears all iframe-side widget localStorage keys.
  useEffect(() => {
    const onDevReset = (event) => {
      const msg = event.data || {};
      if (msg.type !== 'ATB_WIDGET_DEV_RESET') return;
      clearAllWidgetState();
      console.log('[ATB_WIDGET_APP] dev reset applied — reload page to start fresh');
    };
    window.addEventListener('message', onDevReset);
    return () => window.removeEventListener('message', onDevReset);
  }, []);

  // Fresh-tab reset: content.js sends ATB_WIDGET_FORCE_FRESH when the tab was closed and
  // reopened (not a same-tab navigation). Discard any pending job from a prior session.
  useEffect(() => {
    const onForceFresh = (event) => {
      if ((event.data || {}).type !== 'ATB_WIDGET_FORCE_FRESH') return;
      console.log('[WIDGET] force fresh — discarding pending job from prior session');
      abandonRef.current = true;
      clearChatState();
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'ATB_WIDGET_CLEAR_BRIDGE' }, '*');
      }
    };
    window.addEventListener('message', onForceFresh);
    return () => window.removeEventListener('message', onForceFresh);
  }, []);

  // Resume a navigation-based goal after the host page reloaded. If a fresh breadcrumb exists, the
  // widget re-evaluates the same customer goal on the page it just landed on and points out the
  // next relevant step (with navigated:true so the backend won't navigate again). Best-effort and
  // guarded — when there's no breadcrumb (the normal case) nothing happens.
  useEffect(() => {
    const resume = readPageGoalResume();
    if (!resume || !resume.message) return undefined;
    clearPageGoalResume();

    let cancelled = false;
    (async () => {
      // Give the freshly-loaded page a moment to render before snapshotting.
      await new Promise((resolve) => window.setTimeout(resolve, 600));
      if (cancelled) return;
      setIsTyping(true);
      try {
        const snapshot = await requestPageSnapshot();
        if (!snapshot || cancelled) return;
        const response = await sendAgentMessage({
          message: resume.message,
          conversationId: resume.conversationId || conversationId,
          conversationHistory: [],
          agentContext: {},
          profileContext: {},
          payload: {},
          pageSnapshot: snapshot,
          pageGoalState: { ...(resume.goalState || {}), navigated: true },
        });
        const actions = response.raw?.pagePlan?.actions;
        if (Array.isArray(actions) && actions.length) {
          await dispatchPageActions(actions);
        }
        if (!cancelled) appendNormalizedAssistantResponse(response);
      } catch {
        /* resume is best-effort; ignore failures */
      } finally {
        if (!cancelled) setIsTyping(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleExecutionResponse = (response) => {
    const raw = response.raw || {};

    if (raw.status === 'completed') {
      clearPendingInteractionState();
      setPendingFieldAction(null);
      setAgentContext(EMPTY_AGENT_CONTEXT);
      appendAssistantMessage({
        text: raw.data?.localSimulation && response.text
          ? response.text
          : buildCompletionText(raw.data || {}),
        quickActions: response.quickActions,
        actionContext: response.actionContext,
        animate: true,
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

  const refreshConversation = () => {
    console.log('[WIDGET] refresh conversation');
    browserPollRef.current = null;
    abandonRef.current = false;
    setIsTyping(false);
    setMessages([]);
    setPendingBrowserJob(null);
    setPendingAction(null);
    setPendingConfirmation(null);
    setPendingSms(null);
    setSmsCode('');
    setSmsError('');
    setPendingFieldAction(null);
    setLoadingSequence([]);
    clearAllWidgetState();
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'ATB_WIDGET_CLEAR_BRIDGE' }, '*');
    }
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

    // Create the message object once so we can reference it for the synchronous state save below.
    const userMessage = createMessage('user', trimmedMessage);
    setMessages((currentMessages) => [...clearMessageActions(currentMessages), userMessage]);
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

    setLoadingSequence(selectLoadingSequence({ message: trimmedMessage, hasFiles: false }));
    setIsTyping(true);

    // When we hand a browser-use job off to the polling loop, the poller owns the typing state — so
    // the finally below must NOT switch it off.
    let handedOffToPoll = false;

    try {
      // Multi-step same-page goal loop. Each step: snapshot → backend infers the customer goal and
      // returns a safe plan → run the actions (scroll/highlight/open document) and WAIT for the host
      // page to confirm before rendering. Loops only while the backend asks to ('continue'); stops
      // on a finished plan, on a safe navigation (the page reloads and the goal resumes), or after
      // MAX_STEPS. Returns null snapshot when not embedded → single normal/browser-use request.
      const MAX_STEPS = 4;
      let pageSnapshot = await requestPageSnapshot();
      let goalState = null;
      let response = null;

      // Ask mode: gather site context from cache or fresh DOM extraction.
      // Act mode skips this — it uses browser-use to interact with the page directly.
      let siteContext = null;
      if (agentMode === 'ask') {
        const cached = getSiteContext();
        if (cached) {
          siteContext = cached.ctx;
        } else {
          siteContext = await requestSiteContext();
          if (siteContext) saveSiteContext(siteContext);
        }
      }

      for (let step = 0; step < MAX_STEPS; step += 1) {
        response = await sendAgentMessage({
          message: trimmedMessage,
          conversationId,
          conversationHistory,
          profileContext: {},
          agentContext: outgoingAgentContext,
          payload: {},
          pageSnapshot,
          pageGoalState: goalState,
          mode: agentMode,
          cacheContext: buildCacheContext(),
          siteContext,
        });

        // Two-phase browser-use start. Backend returned a QUEUED job — python not running yet.
        // 1. Synchronously persist chat state to sessionStorage (isOpen, messages, jobId) BEFORE
        //    calling /start, because once python runs it can navigate the host tab immediately.
        // 2. Only after the persist call do we fire /start and begin polling.
        if (response.raw?.status === 'browser_agent_queued' && response.raw?.jobId) {
          const jobId = response.raw.jobId;
          const newBrowserJob = { jobId, message: trimmedMessage, createdAt: Date.now() };
          const stateToSave = {
            isOpen: true,
            hasOpened: true,
            messages: [...messages, userMessage],
            conversationId,
            pendingBrowserJob: newBrowserJob,
          };
          // `messages` is the stale pre-render closure value; include userMessage manually.
          saveChatState(stateToSave);
          // Also save via parent-page bridge (atb.tn localStorage via content.js).
          // Reliable fallback in case the iframe's partitioned localStorage is empty after reload.
          if (window.parent !== window) {
            window.parent.postMessage({
              type: 'ATB_WIDGET_SAVE_BRIDGE',
              state: { pendingBrowserJob: newBrowserJob, isOpen: true, messages: stateToSave.messages },
            }, '*');
          }
          setPendingBrowserJob(newBrowserJob);
          handedOffToPoll = true;
          await triggerBrowserAgentJobStart(jobId);
          pollBrowserJob(jobId);
          return;
        }

        const plan = response.raw?.pagePlan;
        const actions = plan?.actions;
        if (Array.isArray(actions) && actions.length) {
          await dispatchPageActions(actions);
        }

        // Safe navigation: the host page is about to reload. Save the goal so the widget resumes it
        // on the new page, then stop — this step's answer is already prepared.
        if (plan?.status === 'navigated') {
          savePageGoalResume({
            message: trimmedMessage,
            conversationId,
            goalState: plan.goalState || null,
          });
          break;
        }

        // Stop unless the backend explicitly wants another same-page step.
        if (!pageSnapshot || plan?.status !== 'continue') break;

        // Let the DOM settle, rebuild the snapshot, and continue the goal.
        await new Promise((resolve) => window.setTimeout(resolve, 350));
        pageSnapshot = await requestPageSnapshot();
        goalState = plan.goalState || null;
      }

      // Persist cache-worthy data returned by backend
      if (response.raw?.contactFacts) saveContactFacts(response.raw.contactFacts);
      if (response.raw?.documentIndex) saveDocumentIndex(response.raw.documentIndex);

      applyChatResponseState(response);
      setAgentContext((currentContext) => deriveAgentContext(currentContext, response));
      appendNormalizedAssistantResponse(response);
    } catch (error) {
      appendErrorMessage(error);
    } finally {
      if (!handedOffToPoll) {
        setIsTyping(false);
      }
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
                onClick={refreshConversation}
                aria-label={text.refresh}
                title={text.refresh}
              >
                <RefreshIcon />
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
                  animate={message.role === 'bot' && message.id === animatingId}
                />
              ))}
              {isTyping && <StatusIndicator status={loadingStatus} />}
            </div>
          </div>

          <form className="chat-input-form" onSubmit={handleSubmit}>
            <div className="mode-toggle" role="group" aria-label="Agent mode">
              <button
                type="button"
                className={`mode-toggle-btn${agentMode === 'ask' ? ' mode-toggle-active' : ''}`}
                onClick={() => { setAgentMode('ask'); setMode('ask'); }}
                disabled={isTyping}
              >
                Ask question
              </button>
              <button
                type="button"
                className={`mode-toggle-btn${agentMode === 'act' ? ' mode-toggle-active' : ''}`}
                onClick={() => { setAgentMode('act'); setMode('act'); }}
                disabled={isTyping}
              >
                Act on site
              </button>
            </div>
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
