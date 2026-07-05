import ResultCard from '../ResultCard.jsx';
import AssistantAvatar from './AssistantAvatar.jsx';
import MarkdownContent from './MarkdownContent.jsx';
import UserAvatar from './UserAvatar.jsx';
import { useTypewriter } from '../../hooks/useTypewriter.js';
import { balanceMarkdown } from '../../utils/markdownBalance.js';

const getQuickReplyUrl = (reply = {}) =>
  reply.url || reply.downloadUrl || reply.fileUrl || '';

const isDownloadLikeQuickReply = (reply = {}) => {
  const actionType = reply.action || reply.type || '';
  const label = String(reply.label || '').toLowerCase();
  const url = String(getQuickReplyUrl(reply) || '').toLowerCase();

  return (
    ['download', 'open_url'].includes(actionType) &&
    (
      label.includes('download pdf') ||
      label.includes('download document') ||
      label.includes('pdf') ||
      url.includes('/resources/download/') ||
      url.split(/[?#]/)[0].endsWith('.pdf')
    )
  );
};

const getQuickReplyKey = (reply = {}) => {
  if (reply.id) return `id:${reply.id}`;

  const actionType = reply.action || reply.type || '';
  const url = String(getQuickReplyUrl(reply) || '').trim();

  if (url) {
    return `${isDownloadLikeQuickReply(reply) ? 'download' : actionType || 'url'}:${url}`;
  }

  return `${actionType}:${reply.label || ''}:${reply.value || reply.prompt || ''}`;
};

const dedupeQuickReplies = (replies = []) => {
  const seen = new Set();

  return replies.filter((reply) => {
    if (!reply || !reply.label) return false;
    const key = getQuickReplyKey(reply);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

function ChatMessage({
  message,
  onQuickReply = () => {},
  profile,
  user,
  animate = false,
}) {
  const isUser = message.sender === 'user';
  const shouldAnimate = animate && !isUser && message.status !== 'error';
  const { visible, done } = useTypewriter(message.text, { enabled: shouldAnimate });
  const renderedText = shouldAnimate && !done ? balanceMarkdown(visible) : message.text;

  const formatFileSize = (size) => {
    if (!Number.isFinite(size)) {
      return '';
    }

    if (size < 1024) {
      return `${size} B`;
    }

    if (size < 1024 * 1024) {
      return `${(size / 1024).toFixed(1)} KB`;
    }

    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Only small inline controls survive: Confirm / Cancel for a prepared action.
  const inlineReplies = dedupeQuickReplies(message.quickReplies || []);
  const smsChallenge = !isUser ? message.smsChallenge : null;

  return (
    <div className={`chat-row ${isUser ? 'chat-row-user' : 'chat-row-assistant'}`}>
      {!isUser ? <AssistantAvatar /> : null}
      <div className={`message ${isUser ? 'message-user' : 'message-agent'}`}>
        {isUser ? <p>{message.text}</p> : <MarkdownContent content={renderedText} />}

        {message.attachments?.length ? (
          <div className="message-attachments">
            {message.attachments.map((attachment) => (
              <span
                key={`${attachment.originalName}-${attachment.size}`}
                className="message-attachment-chip"
              >
                <strong>{attachment.originalName}</strong>
                <small>{formatFileSize(attachment.size)}</small>
              </span>
            ))}
          </div>
        ) : null}

        {message.details?.result ? <ResultCard data={message.details.result} /> : null}

        {smsChallenge ? (
          <form
            className="message-sms-form"
            onSubmit={(event) => {
              event.preventDefault();
              onQuickReply({
                action: 'verify_sms',
                code: smsChallenge.code,
              });
            }}
          >
            <label className="message-sms-field">
              <span>Enter SMS code</span>
              <input
                type="password"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="Enter SMS code"
                maxLength={8}
                value={smsChallenge.code}
                onChange={(event) =>
                  onQuickReply({
                    action: 'update_sms_code',
                    code: event.target.value,
                  })
                }
                disabled={smsChallenge.disabled}
              />
            </label>
            {smsChallenge.error ? (
              <p className="error-text">{smsChallenge.error}</p>
            ) : null}
            <div className="message-sms-actions">
              <button
                type="submit"
                className="message-quick-reply message-sms-confirm"
                disabled={smsChallenge.disabled}
              >
                Confirm
              </button>
              <button
                type="button"
                className="message-quick-reply"
                onClick={() => onQuickReply({ action: 'cancel' })}
                disabled={smsChallenge.disabled}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        {!isUser && inlineReplies.length ? (
          <div className="message-quick-reply-actions">
            {inlineReplies.map((reply) => (
              <button
                key={`${reply.label}-${reply.action || ''}`}
                type="button"
                className="message-quick-reply"
                onClick={() => onQuickReply(reply)}
              >
                {reply.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {isUser ? <UserAvatar profile={profile} user={user} /> : null}
    </div>
  );
}

export default ChatMessage;
