import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  cancelAction,
  confirmAction,
  executeAction,
  verifyAndExecuteAction,
} from '../api/actionApi';
import { sendChatMessage } from '../api/chatApi';
import {
  getToken,
  getUser,
  removeToken,
  removeUser,
} from '../utils/authStorage';

const payloadPlaceholder = `{
  "accountId": "acc_001",
  "documentType": "statement",
  "period": "April 2026"
}`;

const fieldLabels = {
  accountId: 'Account ID',
  sourceAccountId: 'Source Account ID',
  documentType: 'Document Type',
  period: 'Period',
  billReference: 'Bill Reference',
  beneficiaryId: 'Beneficiary',
  amount: 'Amount',
  category: 'Category',
  description: 'Description',
  branch: 'Branch',
  date: 'Date',
  time: 'Time',
};

const fieldPlaceholders = {
  accountId: 'acc_001',
  sourceAccountId: 'acc_001',
  documentType: 'statement',
  period: 'April 2026',
  billReference: 'OOREDOO-2026-001',
  beneficiaryId: 'ben_001',
  amount: '300',
  category: 'transfer',
  description: 'My transfer failed',
  branch: 'Tunis Centre',
  date: '2026-05-25',
  time: '10:00',
};

function ChatPage() {
  const navigate = useNavigate();
  const token = getToken();
  const user = getUser();
  const [messages, setMessages] = useState([
    {
      id: 'welcome',
      sender: 'assistant',
      text: 'How can I help with your ATB banking today?',
    },
  ]);
  const [message, setMessage] = useState('');
  const [payloadText, setPayloadText] = useState('');
  const [payloadError, setPayloadError] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [actionLoadingText, setActionLoadingText] = useState('');
  const [pendingAction, setPendingAction] = useState(null);
  const [pendingConfirmation, setPendingConfirmation] = useState(null);
  const [pendingSms, setPendingSms] = useState(null);
  const [smsCode, setSmsCode] = useState('');
  const [smsError, setSmsError] = useState('');
  const [missingFieldRequest, setMissingFieldRequest] = useState(null);
  const [missingFieldValues, setMissingFieldValues] = useState({});

  useEffect(() => {
    if (!token || !user) {
      navigate('/login');
    }
  }, [navigate, token, user]);

  const conversationHistory = useMemo(() => {
    return messages.map((chatMessage) => ({
      role: chatMessage.sender === 'user' ? 'user' : 'assistant',
      content: chatMessage.text,
    }));
  }, [messages]);

  const handleLogout = () => {
    removeToken();
    removeUser();
    navigate('/login');
  };

  const parsePayload = () => {
    if (!payloadText.trim()) {
      return {};
    }

    return JSON.parse(payloadText);
  };

  const appendMessage = (chatMessage) => {
    setMessages((currentMessages) => [
      ...currentMessages,
      {
        id: `${Date.now()}-${Math.random()}`,
        ...chatMessage,
      },
    ]);
  };

  const appendAssistantMessage = (chatMessage) => {
    appendMessage({
      sender: 'assistant',
      ...chatMessage,
    });
  };

  const buildAssistantDetails = (response) => {
    if (response.status === 'action_prepared') {
      return {
        summary: response.data?.preparation?.summary || [],
      };
    }

    if (response.status === 'missing_fields') {
      return {
        missingFields: response.data?.missingFields || [],
      };
    }

    return null;
  };

  const buildResultDetails = (data) => {
    if (!data) {
      return null;
    }

    return {
      result: data,
    };
  };

  const clearMissingFieldState = () => {
    setMissingFieldRequest(null);
    setMissingFieldValues({});
  };

  const clearPendingInteractionState = () => {
    setPendingAction(null);
    setPendingConfirmation(null);
    setPendingSms(null);
    clearMissingFieldState();
  };

  const setChatResponseState = (response, originalMessage) => {
    if (response.status === 'action_prepared') {
      setPendingAction(response.data?.preparation || null);
      setPendingConfirmation(null);
      setPendingSms(null);
      setSmsCode('');
      setSmsError('');
      clearMissingFieldState();
      return;
    }

    if (response.status === 'missing_fields') {
      setPendingAction(null);
      setPendingConfirmation(null);
      setPendingSms(null);
      setMissingFieldRequest({
        originalMessage,
        finalPayload: response.data?.finalPayload || {},
        missingFields: response.data?.missingFields || [],
      });
      setMissingFieldValues({});
      return;
    }

    clearPendingInteractionState();
  };

  const handleExecutionResponse = (response) => {
    if (response.status === 'completed') {
      appendAssistantMessage({
        text: 'Action completed successfully.',
        status: response.status,
        details: buildResultDetails(response.data),
      });
      setPendingAction(null);
      setPendingConfirmation(null);
      setPendingSms(null);
      setSmsCode('');
      setSmsError('');
      return;
    }

    if (response.status === 'confirmation_required') {
      appendAssistantMessage({
        text: 'This action needs your confirmation before it can continue.',
        status: response.status,
      });
      setPendingAction(null);
      setPendingConfirmation(response.data);
      setPendingSms(null);
      return;
    }

    if (response.status === 'sms_required') {
      appendAssistantMessage({
        text: 'SMS verification is required to complete this secure action.',
        status: response.status,
      });
      setPendingAction(null);
      setPendingConfirmation(null);
      setPendingSms(response.data);
      setSmsCode('');
      setSmsError('');
      return;
    }

    if (response.status === 'high_risk_blocked') {
      appendAssistantMessage({
        text: 'This action requires SMS verification. SMS UI will be added in the next step.',
        status: response.status,
      });
      setPendingAction(null);
      setPendingConfirmation(null);
      setPendingSms(null);
      clearMissingFieldState();
      return;
    }

    appendAssistantMessage({
      text: response.message || 'The action could not be completed.',
      status: response.status || 'error',
    });
  };

  const handleSend = async (event) => {
    event.preventDefault();

    if (!message.trim() || isSending) {
      return;
    }

    let payload;

    try {
      payload = parsePayload();
    } catch {
      setPayloadError('Invalid payload JSON');
      return;
    }

    setPayloadError('');

    const userMessage = message.trim();
    setMessage('');
    appendMessage({
      sender: 'user',
      text: userMessage,
    });

    const loadingMessageId = `loading-${Date.now()}`;
    setMessages((currentMessages) => [
      ...currentMessages,
      {
        id: loadingMessageId,
        sender: 'assistant',
        text: 'Analyzing your request...',
        isLoading: true,
      },
    ]);

    setIsSending(true);

    try {
      const response = await sendChatMessage({
        message: userMessage,
        payload,
        conversationHistory,
        token,
      });

      setChatResponseState(response, userMessage);

      setMessages((currentMessages) =>
        currentMessages
          .filter((chatMessage) => chatMessage.id !== loadingMessageId)
          .concat({
            id: `${Date.now()}-assistant`,
            sender: 'assistant',
            text:
              response.assistantMessage ||
              'I analyzed your request. Please review the details below.',
            status: response.status,
            details: buildAssistantDetails(response),
          }),
      );
    } catch {
      setMessages((currentMessages) =>
        currentMessages
          .filter((chatMessage) => chatMessage.id !== loadingMessageId)
          .concat({
            id: `${Date.now()}-error`,
            sender: 'assistant',
            text:
              'I could not reach the banking assistant right now. Please try again.',
            status: 'error',
          }),
      );
    } finally {
      setIsSending(false);
    }
  };

  const handleMissingFieldChange = (field, value) => {
    setMissingFieldValues((currentValues) => ({
      ...currentValues,
      [field]: value,
    }));
  };

  const handleSubmitMissingFields = async () => {
    if (!missingFieldRequest || actionLoadingText) {
      return;
    }

    const completedPayload = {
      ...missingFieldRequest.finalPayload,
      ...missingFieldValues,
    };

    setActionLoadingText('Preparing action...');

    try {
      const response = await sendChatMessage({
        message: missingFieldRequest.originalMessage,
        payload: completedPayload,
        conversationHistory,
        token,
      });

      setChatResponseState(response, missingFieldRequest.originalMessage);
      appendAssistantMessage({
        text:
          response.assistantMessage ||
          'I reviewed the additional information.',
        status: response.status,
        details: buildAssistantDetails(response),
      });
    } catch {
      appendAssistantMessage({
        text:
          'I could not submit the missing information right now. Please try again.',
        status: 'error',
      });
    } finally {
      setActionLoadingText('');
    }
  };

  const handleCancelMissingFields = () => {
    clearMissingFieldState();
    appendAssistantMessage({
      text: 'Action cancelled. You can start another request.',
      status: 'cancelled',
    });
  };

  const handleContinueAction = async () => {
    if (!pendingAction || actionLoadingText) {
      return;
    }

    setActionLoadingText('Executing action...');

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
    if (!pendingConfirmation || actionLoadingText) {
      return;
    }

    setActionLoadingText(
      pendingConfirmation.riskLevel === 'high'
        ? 'Sending SMS verification code...'
        : 'Waiting for confirmation...',
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
    if (!pendingSms || actionLoadingText) {
      return;
    }

    if (!smsCode.trim()) {
      setSmsError('Please enter the SMS code.');
      return;
    }

    setSmsError('');
    setActionLoadingText('Verifying SMS code...');

    try {
      const response = await verifyAndExecuteAction({
        confirmationId: pendingSms.confirmationId,
        code: smsCode.trim(),
        token,
      });

      setActionLoadingText('Executing secure action...');
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

      if (status === 'sms_expired') {
        text = 'The SMS code has expired. Please restart the action.';
      }

      if (status === 'sms_failed') {
        text = 'SMS verification failed. Please restart the action.';
      }

      if (status === 'failed') {
        text =
          error.response?.data?.message ||
          'The secure action failed. Please restart the action.';
      }

      setSmsError(text);
      appendAssistantMessage({
        text,
        status,
      });
    } finally {
      setActionLoadingText('');
    }
  };

  const handleCancelAction = async () => {
    if (actionLoadingText) {
      return;
    }

    setActionLoadingText('Cancelling action...');

    try {
      if (pendingConfirmation?.confirmationId) {
        await cancelAction({
          confirmationId: pendingConfirmation.confirmationId,
          token,
        });
      }

      if (pendingSms?.confirmationId) {
        await cancelAction({
          confirmationId: pendingSms.confirmationId,
          token,
        });
      }

      appendAssistantMessage({
        text: 'Action cancelled.',
        status: 'cancelled',
      });
      setPendingAction(null);
      setPendingConfirmation(null);
      setPendingSms(null);
      setSmsCode('');
      setSmsError('');
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

  if (!user) {
    return null;
  }

  return (
    <section className="chat-layout">
      <div className="chat-header">
        <div>
          <p className="eyebrow">Agent Workspace</p>
          <h1>Banking assistant chat</h1>
        </div>
        <button type="button" className="secondary-button" onClick={handleLogout}>
          Logout
        </button>
      </div>

      <div className="account-summary compact-summary">
        <h2>Welcome, {user.fullName}</h2>
        <p>Role: {user.role}</p>
        <p>Phone: {user.phoneNumber || 'Not registered'}</p>
      </div>

      <div className="chat-window">
        <div className="message-list">
          {messages.map((chatMessage) => (
            <div
              key={chatMessage.id}
              className={`message ${
                chatMessage.sender === 'user' ? 'message-user' : 'message-agent'
              }`}
            >
              <p>{chatMessage.text}</p>

              {chatMessage.status ? (
                <p className="status-text">status: {chatMessage.status}</p>
              ) : null}

              {chatMessage.details?.summary?.length ? (
                <ul className="detail-list">
                  {chatMessage.details.summary.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : null}

              {chatMessage.details?.missingFields?.length ? (
                <div className="missing-fields">
                  <p>Missing fields:</p>
                  <ul className="detail-list">
                    {chatMessage.details.missingFields.map((field) => (
                      <li key={field}>{field}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {chatMessage.details?.result ? (
                <pre className="result-box">
                  {JSON.stringify(chatMessage.details.result, null, 2)}
                </pre>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      {pendingAction ? (
        <div className="action-card">
          <p className="eyebrow">Prepared Action</p>
          <h2>{pendingAction.displayName}</h2>
          <p className="status-text">status: action_prepared</p>
          <ul className="detail-list">
            {pendingAction.summary.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div className="action-button-row">
            <button
              type="button"
              className="primary-button"
              onClick={handleContinueAction}
              disabled={Boolean(actionLoadingText)}
            >
              Continue
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={handleCancelAction}
              disabled={Boolean(actionLoadingText)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {missingFieldRequest ? (
        <div className="action-card missing-field-card">
          <p className="eyebrow">Missing Information</p>
          <h2>Complete the action details</h2>
          <div className="missing-field-grid">
            {missingFieldRequest.missingFields.map((field) => (
              <label key={field}>
                {fieldLabels[field] || field}
                <input
                  type={field === 'amount' ? 'number' : 'text'}
                  value={missingFieldValues[field] || ''}
                  placeholder={fieldPlaceholders[field] || field}
                  onChange={(event) =>
                    handleMissingFieldChange(field, event.target.value)
                  }
                  disabled={Boolean(actionLoadingText)}
                />
              </label>
            ))}
          </div>
          <div className="action-button-row">
            <button
              type="button"
              className="primary-button"
              onClick={handleSubmitMissingFields}
              disabled={Boolean(actionLoadingText)}
            >
              Submit missing information
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={handleCancelMissingFields}
              disabled={Boolean(actionLoadingText)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {pendingConfirmation ? (
        <div className="action-card">
          <p className="eyebrow">Confirmation Required</p>
          <h2>{pendingConfirmation.actionName}</h2>
          <p>Confirmation ID: {pendingConfirmation.confirmationId}</p>
          <p>Risk level: {pendingConfirmation.riskLevel}</p>
          <p>Expires at: {pendingConfirmation.expiresAt}</p>
          {pendingConfirmation.summary?.length ? (
            <ul className="detail-list">
              {pendingConfirmation.summary.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
          <div className="action-button-row">
            <button
              type="button"
              className="primary-button"
              onClick={handleConfirmAction}
              disabled={Boolean(actionLoadingText)}
            >
              Confirm
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={handleCancelAction}
              disabled={Boolean(actionLoadingText)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {pendingSms ? (
        <div className="action-card">
          <p className="eyebrow">SMS Verification</p>
          <h2>{pendingSms.actionName}</h2>
          <p>Confirmation ID: {pendingSms.confirmationId}</p>
          {pendingSms.maskedPhoneNumber ? (
            <p>Code sent to: {pendingSms.maskedPhoneNumber}</p>
          ) : null}
          {pendingSms.expiresAt ? <p>Expires at: {pendingSms.expiresAt}</p> : null}
          <label className="sms-code-field">
            6-digit SMS code
            <input
              type="text"
              inputMode="numeric"
              value={smsCode}
              placeholder="123456"
              maxLength={6}
              onChange={(event) => setSmsCode(event.target.value)}
              disabled={Boolean(actionLoadingText)}
            />
          </label>
          {smsError ? <p className="error-text">{smsError}</p> : null}
          <div className="action-button-row">
            <button
              type="button"
              className="primary-button"
              onClick={handleVerifyAndExecute}
              disabled={Boolean(actionLoadingText)}
            >
              Verify and Execute
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={handleCancelAction}
              disabled={Boolean(actionLoadingText)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {actionLoadingText ? (
        <p className="muted action-loading">{actionLoadingText}</p>
      ) : null}

      <form className="chat-compose" onSubmit={handleSend}>
        <label>
          Message
          <div className="chat-input-row">
            <input
              type="text"
              value={message}
              placeholder="Ask about your account, documents, bills, or transfers"
              onChange={(event) => setMessage(event.target.value)}
              disabled={isSending}
            />
            <button type="submit" className="primary-button" disabled={isSending}>
              {isSending ? 'Sending...' : 'Send'}
            </button>
          </div>
        </label>

        <label className="payload-editor">
          Advanced payload for testing (optional)
          <textarea
            value={payloadText}
            placeholder={payloadPlaceholder}
            onChange={(event) => setPayloadText(event.target.value)}
            rows={6}
          />
        </label>

        {payloadError ? <p className="error-text">{payloadError}</p> : null}
      </form>
    </section>
  );
}

export default ChatPage;
