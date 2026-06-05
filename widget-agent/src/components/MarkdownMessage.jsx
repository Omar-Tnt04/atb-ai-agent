import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const isSafeHref = (href = '') =>
  /^https?:\/\//i.test(href) || /^mailto:/i.test(href) || href.startsWith('/');

const TABLE_SEPARATOR_RE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/;

const hasTableCells = (line = '') =>
  line
    .trim()
    .split('|')
    .filter((cell) => cell.trim()).length >= 2;

const isTableSeparator = (line = '') => TABLE_SEPARATOR_RE.test(line);

const normalizeMarkdownTables = (value = '') => {
  const lines = String(value || '').split(/\r?\n/);
  const normalized = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const nextLine = lines[index + 1] || '';
    const pipeIndex = line.indexOf('|');
    const hasInlineTableHeader =
      pipeIndex > 0 &&
      isTableSeparator(nextLine) &&
      hasTableCells(line.slice(pipeIndex));

    if (hasInlineTableHeader) {
      const prefix = line.slice(0, pipeIndex).trimEnd();
      const header = line.slice(pipeIndex).trim();

      if (prefix) {
        normalized.push(prefix, '');
      }

      normalized.push(header);
      continue;
    }

    const startsTable =
      hasTableCells(line) &&
      isTableSeparator(nextLine) &&
      normalized.length > 0 &&
      normalized[normalized.length - 1].trim() !== '';

    if (startsTable) {
      normalized.push('');
    }

    normalized.push(line);
  }

  return normalized.join('\n');
};

function MarkdownMessage({ content = '' }) {
  return (
    <div className="markdown-message">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href = '', children, ...props }) {
            if (!isSafeHref(href)) {
              return <span>{children}</span>;
            }

            return (
              <a href={href} target="_blank" rel="noreferrer" {...props}>
                {children}
              </a>
            );
          },
          table({ children, ...props }) {
            return (
              <div className="markdown-table-wrapper">
                <table {...props}>{children}</table>
              </div>
            );
          },
        }}
      >
        {normalizeMarkdownTables(content)}
      </ReactMarkdown>
    </div>
  );
}

export default MarkdownMessage;
