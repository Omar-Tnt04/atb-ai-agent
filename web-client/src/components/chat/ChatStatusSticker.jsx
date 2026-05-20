import AssistantAvatar from './AssistantAvatar.jsx';

function ChatStatusSticker({ text }) {
  if (!text) {
    return null;
  }

  return (
    <div className="chat-row chat-row-assistant">
      <AssistantAvatar />
      <div className="status-sticker">
        <span>{text}</span>
        <span className="typing-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </div>
    </div>
  );
}

export default ChatStatusSticker;
