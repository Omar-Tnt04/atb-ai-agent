import MarkdownMessage from './MarkdownMessage.jsx';

const ACTION_LABELS = {
  confirm: 'Confirm',
  cancel: 'Cancel',
  downloadPdf: 'Download PDF',
  downloadDocument: 'Download document',
  openDocument: 'Open document',
};

function formatTime(timestamp) {
  if (!timestamp) {
    return '';
  }

  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function getActionLabel(action) {
  const labels = ACTION_LABELS;
  const actionType = action.action || '';
  const rawLabel = action.label || '';

  if (actionType === 'continue' || actionType === 'confirm_pending') {
    return labels.confirm;
  }

  if (actionType === 'cancel') {
    return labels.cancel;
  }

  if (actionType === 'download') {
    return /pdf/i.test(rawLabel) || /\.pdf(?:$|[?#])/i.test(action.url || '')
      ? labels.downloadPdf
      : labels.downloadDocument;
  }

  if (actionType === 'open_url') {
    if (/pdf/i.test(rawLabel) || /\.pdf(?:$|[?#])/i.test(action.url || '')) {
      return labels.downloadPdf;
    }

    return /document/i.test(rawLabel) ? labels.openDocument : rawLabel;
  }

  return rawLabel;
}

function MessageBubble({ message, onAction }) {
  const isUser = message.role === 'user';
  const quickActions = isUser ? [] : message.quickActions || [];

  return (
    <article className={`message-row ${isUser ? 'message-row-user' : 'message-row-bot'}`}>
      <div className="message-stack">
        <div
          className={[
            'message-bubble',
            isUser ? 'message-bubble-user' : 'message-bubble-bot',
            message.isError ? 'message-bubble-error' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <span className="message-content">
            {isUser ? message.content : <MarkdownMessage content={message.content} />}
          </span>
          <time className="message-time" dateTime={message.timestamp}>
            {formatTime(message.timestamp)}
          </time>
        </div>
        {quickActions.length ? (
          <div className="message-actions" aria-label="Message actions">
            {quickActions.map((action) => (
              <button
                key={`${action.label}-${action.action || ''}-${action.url || ''}`}
                type="button"
                className={[
                  'message-action-button',
                  action.action === 'cancel' ? 'message-action-secondary' : '',
                  action.action === 'download' || action.action === 'open_url'
                    ? 'message-action-download'
                    : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => onAction?.(action)}
              >
                {getActionLabel(action)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

export default MessageBubble;
