import { useEffect, useState } from 'react';

// Reveals text left-to-right (ChatGPT style). The reveal step is sized so any message finishes
// within maxDurationMs regardless of length, so long answers don't crawl. When disabled it
// returns the full text immediately (used for history / already-seen messages).
export function useTypewriter(
  fullText,
  { enabled = true, tickMs = 18, maxDurationMs = 1400, minStep = 2 } = {},
) {
  const safeText = typeof fullText === 'string' ? fullText : '';
  const [count, setCount] = useState(enabled ? 0 : safeText.length);

  useEffect(() => {
    if (!enabled) {
      setCount(safeText.length);
      return undefined;
    }

    const total = safeText.length;
    setCount(0);
    if (!total) return undefined;

    const ticks = Math.max(1, Math.ceil(maxDurationMs / tickMs));
    const step = Math.max(minStep, Math.ceil(total / ticks));
    let current = 0;

    const timer = setInterval(() => {
      current += step;
      if (current >= total) {
        setCount(total);
        clearInterval(timer);
      } else {
        setCount(current);
      }
    }, tickMs);

    return () => clearInterval(timer);
  }, [safeText, enabled, tickMs, maxDurationMs, minStep]);

  const visible = enabled ? safeText.slice(0, count) : safeText;
  return { visible, done: visible.length >= safeText.length };
}

export default useTypewriter;
