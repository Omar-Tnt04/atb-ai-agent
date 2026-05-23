import ResultCard from '../ResultCard.jsx';
import AssistantAvatar from './AssistantAvatar.jsx';
import MarkdownContent from './MarkdownContent.jsx';
import UserAvatar from './UserAvatar.jsx';

function ChatMessage({
  message,
  onQuickReply = () => {},
  profile,
  user,
}) {
  const isUser = message.sender === 'user';

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
  const inlineReplies = message.quickReplies || [];

  return (
    <div className={`chat-row ${isUser ? 'chat-row-user' : 'chat-row-assistant'}`}>
      {!isUser ? <AssistantAvatar /> : null}
      <div className={`message ${isUser ? 'message-user' : 'message-agent'}`}>
        {isUser ? <p>{message.text}</p> : <MarkdownContent content={message.text} />}

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
