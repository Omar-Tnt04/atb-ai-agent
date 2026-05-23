import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const isSafeHref = (href = '') =>
  /^https?:\/\//i.test(href) || /^mailto:/i.test(href) || href.startsWith('/');

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
        {String(content || '')}
      </ReactMarkdown>
    </div>
  );
}

export default MarkdownMessage;
