import { useEffect, useRef } from 'react';

/**
 * Hook to automatically trigger an onIdle callback after period of inactivity.
 * @param {Function} onIdle - Callback when user is idle
 * @param {number} timeoutMs - Timeout in milliseconds (default: 15 minutes)
 */
export function useIdleTimeout(onIdle, timeoutMs = 15 * 60 * 1000) {
  const timerRef = useRef(null);

  useEffect(() => {
    if (!onIdle) return;

    const resetTimer = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        onIdle();
      }, timeoutMs);
    };

    // Events that signify user activity
    const events = ['mousemove', 'keydown', 'touchstart', 'scroll', 'click'];
    
    events.forEach(event => window.addEventListener(event, resetTimer));
    resetTimer();

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      events.forEach(event => window.removeEventListener(event, resetTimer));
    };
  }, [onIdle, timeoutMs]);
}
