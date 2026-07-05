// Replaces the three-dot typing indicator with smooth, route-aware "-ing" status text.
function StatusIndicator({ status }) {
  const label = status || 'Searching resources...';

  return (
    <div className="message-row message-row-bot status-row" aria-live="polite">
      <div className="status-indicator">
        <span className="status-indicator-text">{label}</span>
      </div>
    </div>
  );
}

export default StatusIndicator;
