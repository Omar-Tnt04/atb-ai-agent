// Closes dangling Markdown emphasis so a partially-revealed message still renders cleanly
// during the typing animation. Keeps **bold** working while characters stream in.
export function balanceMarkdown(text = '') {
  let result = String(text || '');
  if (!result) return result;

  // Close an unclosed inline code span.
  const backticks = (result.match(/`/g) || []).length;
  if (backticks % 2 === 1) {
    result += '`';
  }

  // Close an unclosed bold run, or drop a trailing lone '*' that only starts a token.
  const boldTokens = (result.match(/\*\*/g) || []).length;
  if (boldTokens % 2 === 1) {
    result += '**';
  } else if (/(^|[^*])\*$/.test(result)) {
    result = result.replace(/\*$/, '');
  }

  return result;
}

export default balanceMarkdown;
