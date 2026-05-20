import { useMemo, useState } from 'react';
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
  const [selectedReplies, setSelectedReplies] = useState({});
  const groupedQuickReplies = useMemo(() => {
    const selectable = (message.quickReplies || []).filter(
      (reply) => reply.selectable && reply.field,
    );
    const immediate = (message.quickReplies || []).filter(
      (reply) => !reply.selectable || !reply.field,
    );
    const groups = selectable.reduce((groupMap, reply) => {
      const groupKey = reply.field;
      return {
        ...groupMap,
        [groupKey]: {
          label: reply.fieldLabel || reply.field,
          options: [...(groupMap[groupKey]?.options || []), reply],
        },
      };
    }, {});

    return { groups: Object.entries(groups), immediate };
  }, [message.quickReplies]);
  const selectedReplyList = Object.values(selectedReplies);

  const handleToggleReply = (reply) => {
    setSelectedReplies((currentReplies) => {
      if (currentReplies[reply.field]?.label === reply.label) {
        const nextReplies = { ...currentReplies };
        delete nextReplies[reply.field];
        return nextReplies;
      }

      return { ...currentReplies, [reply.field]: reply };
    });
  };

  const handleSendSelectedReplies = () => {
    if (!selectedReplyList.length) return;

    onQuickReply({
      label: selectedReplyList.map((reply) => reply.label).join(', '),
      prompt: selectedReplyList.map((reply) => reply.prompt || reply.label).join('. '),
    });
    setSelectedReplies({});
  };

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

        {message.details?.summary?.length ? (
          <ul className="detail-list">
            {message.details.summary.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : null}

        {message.details?.result ? <ResultCard data={message.details.result} /> : null}

        {!isUser && message.quickReplies?.length ? (
          <div className="message-quick-replies" aria-label="Quick replies">
            {groupedQuickReplies.groups.length ? (
              <div className="message-quick-reply-groups">
                {groupedQuickReplies.groups.map(([field, group]) => (
                  <div key={field} className="message-quick-reply-group">
                    <span>{group.label}</span>
                    <div>
                      {group.options.map((reply) => {
                        const isSelected = selectedReplies[field]?.label === reply.label;

                        return (
                          <button
                            key={`${reply.label}-${reply.prompt || ''}`}
                            type="button"
                            className={`message-quick-reply ${
                              isSelected ? 'message-quick-reply-selected' : ''
                            }`.trim()}
                            aria-pressed={isSelected}
                            onClick={() => handleToggleReply(reply)}
                          >
                            {reply.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}

                <button
                  type="button"
                  className="message-quick-reply-submit"
                  disabled={!selectedReplyList.length}
                  onClick={handleSendSelectedReplies}
                >
                  Send selected
                </button>
              </div>
            ) : null}

            {groupedQuickReplies.immediate.length ? (
              <div className="message-quick-reply-actions">
                {groupedQuickReplies.immediate.map((reply) => (
                  <button
                    key={`${reply.label}-${reply.prompt || reply.action || ''}`}
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
        ) : null}
      </div>
      {isUser ? <UserAvatar profile={profile} user={user} /> : null}
    </div>
  );
}

export default ChatMessage;
