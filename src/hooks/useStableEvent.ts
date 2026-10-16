import { useCallback, useLayoutEffect, useRef } from "react";

/** Stable subscription callback that always runs the latest committed implementation. */
export function useStableEvent<Args extends unknown[], Result>(handler: (...args: Args) => Result) {
  const ref = useRef(handler);
  useLayoutEffect(() => { ref.current = handler; });
  return useCallback((...args: Args) => ref.current(...args), []);
}
