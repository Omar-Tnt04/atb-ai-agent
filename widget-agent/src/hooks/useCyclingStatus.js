import { useEffect, useState } from 'react';

// Steps through a list of status strings while `active`, holding on the last one. Used to drive
// the "Searching resources... -> Reading document... -> Preparing answer..." loading text.
export function useCyclingStatus(active, sequence, intervalMs = 1100) {
  const steps = Array.isArray(sequence) && sequence.length ? sequence : [];
  const key = steps.join('|');
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!active || steps.length <= 1) {
      setIndex(0);
      return undefined;
    }

    setIndex(0);
    let current = 0;
    const timer = setInterval(() => {
      current += 1;
      setIndex(current);
      if (current >= steps.length - 1) {
        clearInterval(timer);
      }
    }, intervalMs);

    return () => clearInterval(timer);
    // steps identity is captured via `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, intervalMs, key]);

  if (!active || !steps.length) return '';
  return steps[Math.min(index, steps.length - 1)] || '';
}

export default useCyclingStatus;
