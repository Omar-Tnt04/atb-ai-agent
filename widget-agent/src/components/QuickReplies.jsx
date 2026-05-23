function QuickReplies({ replies, onSelect, disabled }) {
  return (
    <div className="suggestion-panel" aria-label="Suggestions">
      {replies.map((reply) => (
        <button
          key={reply}
          type="button"
          onClick={() => onSelect(reply)}
          disabled={disabled}
          className="suggestion-pill"
        >
          {reply}
        </button>
      ))}
    </div>
  );
}

export default QuickReplies;
