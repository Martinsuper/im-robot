import { useState, useRef, useEffect, useCallback } from 'react';

interface UsePetNoticeReturn {
  notice: string;
  showNotice: (message: string, durationMs?: number) => void;
  clearNotice: () => void;
}

const DEFAULT_DURATION_MS = 2600;

/**
 * Hook to manage pet notice display logic.
 *
 * - Uses useState for current notice text.
 * - Uses refs for timer ID and request sequence counter to prevent race conditions.
 * - Automatically clears notice after a configurable duration.
 * - Cleans up timers on unmount.
 */
function usePetNotice(): UsePetNoticeReturn {
  const [notice, setNotice] = useState<string>('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeqRef = useRef<number>(0);

  // Clear any pending timer and reset state
  const clearNotice = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setNotice('');
  }, []);

  const showNotice = useCallback(
    (message: string, durationMs: number = DEFAULT_DURATION_MS) => {
      // Increment request sequence to handle race conditions
      requestSeqRef.current += 1;
      const currentSeq = requestSeqRef.current;

      // Clear any existing timer before showing new notice
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      // Show the new notice
      setNotice(message);

      // Set timer to auto-clear after durationMs
      timerRef.current = setTimeout(() => {
        // Only clear if this is still the latest request
        if (requestSeqRef.current === currentSeq) {
          setNotice('');
          timerRef.current = null;
        }
      }, durationMs);
    },
    [],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return {
    notice,
    showNotice,
    clearNotice,
  };
}

export { usePetNotice };
export type { UsePetNoticeReturn };
