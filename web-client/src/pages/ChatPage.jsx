import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
            </div>
          ))}
        </div>
      </div>

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
          Temporary payload JSON
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
