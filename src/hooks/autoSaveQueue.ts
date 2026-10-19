/** Debounce pending edits and serialize effects, including edits queued during a save. */
export class AutoSaveQueue {
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: () => Promise<void>;
  private running: Promise<void> = Promise.resolve();
  private sequence = 0;

  schedule(
    effect: () => Promise<unknown>,
    success: (value: unknown) => void,
    failure: (error: unknown) => void,
    delay: number,
    committed?: (value: unknown) => void,
  ) {
    this.cancel();
    const sequence = this.sequence;
    this.pending = async () => {
      if (sequence !== this.sequence) return;
      try {
        const value = await effect();
        committed?.(value);
        if (sequence === this.sequence) success(value);
      } catch (error) {
        if (sequence === this.sequence) failure(error);
      }
    };
    this.timer = setTimeout(() => {
      void this.flush();
    }, delay);
  }

  cancel() {
    this.sequence += 1;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) this.running = this.running.then(pending);
    return this.running;
  }
}
