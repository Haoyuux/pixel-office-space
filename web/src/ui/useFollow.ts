import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/**
 * Auto-scroll a scroll box to the bottom whenever `dep` changes, paused while the reader has scrolled up
 * (resumes once they scroll back to the bottom). Returns the ref, the paused flag and a jump-to-bottom action.
 */
export function useFollow<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (pausedRef.current !== !atBottom) { pausedRef.current = !atBottom; setPaused(!atBottom); }
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !pausedRef.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  const follow = useCallback(() => {
    const el = ref.current;
    pausedRef.current = false; setPaused(false);
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  return { ref, paused, onScroll, follow };
}
