import AssistantAvatar from './AssistantAvatar.jsx';

function ChatStatusSticker({ text }) {
  if (!text) {
    return null;
  }

  return (
    <div className="chat-row chat-row-assistant">
      <AssistantAvatar />
      <div className="status-message">
        <span className="status-shimmer">{text}</span>
      </div>
    </div>
  );
}

export default ChatStatusSticker;
