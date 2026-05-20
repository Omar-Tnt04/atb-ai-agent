const isTableDivider = (line) =>
  /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);

const splitTableCells = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

const isSafeLink = (url) => /^https?:\/\//i.test(url) || /^mailto:/i.test(url);

function InlineMarkdown({ text }) {
  const parts = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(([^)\s]+)\))/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    const key = `${token}-${match.index}`;

    if (token.startsWith('**')) {
      parts.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      parts.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else {
      const [, label, url] = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/) || [];
      parts.push(
        isSafeLink(url) ? (
          <a key={key} href={url} target="_blank" rel="noreferrer">
            {label}
          </a>
        ) : (
          label || token
        ),
      );
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

function renderParagraph(lines, key) {
  return (
    <p key={key}>
      <InlineMarkdown text={lines.join(' ')} />
    </p>
  );
}

function renderList(items, ordered, key) {
  const Component = ordered ? 'ol' : 'ul';

  return (
    <Component key={key}>
      {items.map((item, index) => (
        <li key={`${item}-${index}`}>
          <InlineMarkdown text={item} />
        </li>
      ))}
    </Component>
  );
}

function renderTable(lines, key) {
  const header = splitTableCells(lines[0]);
  const rows = lines.slice(2).map(splitTableCells);

  return (
    <div key={key} className="markdown-table-wrapper">
      <table>
        <thead>
          <tr>
            {header.map((cell) => (
              <th key={cell}>
                <InlineMarkdown text={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`row-${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${cell}-${cellIndex}`}>
                  <InlineMarkdown text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MarkdownContent({ content = '' }) {
  const trimmedContent = String(content || '').trim();
  let technicalJson = null;

  if (
    (trimmedContent.startsWith('{') && trimmedContent.endsWith('}')) ||
    (trimmedContent.startsWith('[') && trimmedContent.endsWith(']'))
  ) {
    try {
      const parsed = JSON.parse(trimmedContent);
      technicalJson = JSON.stringify(parsed, null, 2);
    } catch {
      // Continue with normal Markdown rendering when the text is not valid JSON.
    }
  }

  if (technicalJson) {
    return (
      <details className="technical-details">
        <summary>Technical details</summary>
        <pre>{technicalJson}</pre>
      </details>
    );
  }

  const lines = String(content || '').split(/\r?\n/);
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.trim().startsWith('```')) {
      const codeLines = [];
      index += 1;

      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }

      blocks.push(
        <pre key={`code-${index}`}>
          <code>{codeLines.join('\n')}</code>
        </pre>,
      );
      index += 1;
      continue;
    }

    if (/^#{1,3}\s+/.test(line)) {
      const level = line.match(/^#{1,3}/)[0].length;
      const Heading = `h${Math.min(level + 2, 4)}`;
      blocks.push(
        <Heading key={`heading-${index}`}>
          <InlineMarkdown text={line.replace(/^#{1,3}\s+/, '')} />
        </Heading>,
      );
      index += 1;
      continue;
    }

    if (
      line.includes('|') &&
      lines[index + 1]?.includes('|') &&
      isTableDivider(lines[index + 1])
    ) {
      const tableLines = [line, lines[index + 1]];
      index += 2;

      while (index < lines.length && lines[index].includes('|')) {
        tableLines.push(lines[index]);
        index += 1;
      }

      blocks.push(renderTable(tableLines, `table-${index}`));
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];

      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ''));
        index += 1;
      }

      blocks.push(renderList(items, false, `list-${index}`));
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];

      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ''));
        index += 1;
      }

      blocks.push(renderList(items, true, `ordered-${index}`));
      continue;
    }

    const paragraphLines = [];

    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].trim().startsWith('```') &&
      !/^#{1,3}\s+/.test(lines[index]) &&
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !/^\s*\d+\.\s+/.test(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }

    blocks.push(renderParagraph(paragraphLines, `paragraph-${index}`));
  }

  return <div className="markdown-content">{blocks}</div>;
}

export default MarkdownContent;
