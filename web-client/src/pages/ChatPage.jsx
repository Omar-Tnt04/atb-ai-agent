function ChatPage() {
  return (
    <section className="chat-layout">
      <div className="chat-header">
        <p className="eyebrow">Agent Workspace</p>
        <h1>Banking assistant chat</h1>
      </div>

      <div className="chat-window">
        <div className="message message-agent">
          <p>Chat service is ready for the next implementation phase.</p>
        </div>
      </div>

      <div className="chat-input-row">
        <input type="text" placeholder="Chat input disabled" disabled />
        <button type="button" className="secondary-button" disabled>
          Send
        </button>
      </div>
    </section>
  );
}

export default ChatPage;
