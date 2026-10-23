/** Dispose exactly once, even if registration resolves after an unmount. */
export function disposeAsyncSubscriptions(registrations: Promise<() => void>[]) {
  let disposed = false;
  const cleanups = new Set<() => void>();
  for (const registration of registrations) {
    void registration.then((cleanup) => {
      if (disposed) cleanup();
      else cleanups.add(cleanup);
    }).catch((error: unknown) => console.error("Event subscription failed", error));
  }
  return () => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups) cleanup();
    cleanups.clear();
  };
}
