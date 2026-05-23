function TypingIndicator() {
  return (
    <div className="message-row message-row-bot typing-row" aria-label={'Assistant ATB \u00e9crit'}>
      <div className="typing-indicator" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

export default TypingIndicator;
