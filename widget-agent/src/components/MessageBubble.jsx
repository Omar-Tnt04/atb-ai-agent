import MarkdownMessage from './MarkdownMessage.jsx';

const ACTION_LABELS = {
  confirm: 'Confirm',
  cancel: 'Cancel',
  downloadPdf: 'Download PDF',
  downloadDocument: 'Download document',
  openDocument: 'Open document',
};

const getQuickActionUrl = (action = {}) =>
  action.url || action.downloadUrl || action.fileUrl || '';

function isDownloadLikeAction(action = {}) {
  const actionType = action.action || action.type || '';
  const label = String(action.label || '').toLowerCase();
  const url = String(getQuickActionUrl(action) || '').toLowerCase();

  return (
    ['download', 'open_url', 'download_pdf'].includes(actionType) &&
    (
      label.includes('download pdf') ||
      label.includes('download document') ||
      label.includes('pdf') ||
      url.includes('/resources/download/') ||
      url.split(/[?#]/)[0].endsWith('.pdf')
    )
  );
}

function getQuickActionKey(action = {}) {
  if (action.id) return `id:${action.id}`;

  const actionType = action.action || action.type || '';
  const url = String(getQuickActionUrl(action) || '').trim();

  if (url) {
    return `${isDownloadLikeAction(action) ? 'download' : actionType || 'url'}:${url}`;
  }

  return `${actionType}:${action.label || ''}:${action.value || action.prompt || ''}`;
}

function dedupeQuickActions(actions = []) {
  const seen = new Set();

  return actions.filter((action) => {
    if (!action || !action.label) return false;
    const key = getQuickActionKey(action);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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
  const quickActions = isUser ? [] : dedupeQuickActions(message.quickActions || []);
  const smsChallenge = !isUser ? message.smsChallenge : null;

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
          <div className="message-content">
            {isUser ? message.content : <MarkdownMessage content={message.content} />}
          </div>
          {smsChallenge ? (
            <form
              className="message-sms-form"
              onSubmit={(event) => {
                event.preventDefault();
                onAction?.({
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
                    onAction?.({
                      action: 'update_sms_code',
                      code: event.target.value,
                    })
                  }
                  disabled={smsChallenge.disabled}
                />
              </label>
              {smsChallenge.error ? (
                <p className="message-sms-error">{smsChallenge.error}</p>
              ) : null}
              <div className="message-sms-actions">
                <button
                  type="submit"
                  className="message-action-button"
                  disabled={smsChallenge.disabled}
                >
                  Confirm
                </button>
                <button
                  type="button"
                  className="message-action-button message-action-secondary"
                  onClick={() => onAction?.({ action: 'cancel' })}
                  disabled={smsChallenge.disabled}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : null}
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
