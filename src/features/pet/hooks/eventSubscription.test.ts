import { describe, expect, it, vi } from "vitest";
import { disposeAsyncSubscriptions } from "./eventSubscription";

describe("asynchronous event subscriptions", () => {
  it("cleans up a registration that resolves after unmount", async () => {
    let resolve!: (cleanup: () => void) => void;
    const registration = new Promise<() => void>((done) => { resolve = done; });
    const cleanup = vi.fn();
    const dispose = disposeAsyncSubscriptions([registration]);
    dispose();
    resolve(cleanup);
    await registration;
    dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it("cleans up each mounted listener only once", async () => {
    const cleanup = vi.fn();
    const registration = Promise.resolve(cleanup);
    const dispose = disposeAsyncSubscriptions([registration]);
    await registration;
    dispose();
    dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
