import { afterEach, describe, expect, it, vi } from "vitest";
import { managedRequestDeadline, managedTransportFailure } from "../managed-request-deadline";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("managed transport Worker compatibility", () => {
  it("does not require AbortSignal.any or AbortSignal.timeout", () => {
    const any = vi.spyOn(AbortSignal, "any").mockImplementation(() => { throw new Error("unsupported runtime"); });
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => { throw new Error("unsupported runtime"); });
    const deadline = managedRequestDeadline(new AbortController().signal);
    expect(deadline.signal.aborted).toBe(false); expect(any).not.toHaveBeenCalled(); expect(timeout).not.toHaveBeenCalled();
    deadline.dispose();
  });
  it("propagates caller cancellation", () => {
    const caller = new AbortController(); const deadline = managedRequestDeadline(caller.signal);
    caller.abort(); expect(deadline.signal.aborted).toBe(true); deadline.dispose();
  });
  it("bounds an upstream request even without caller cancellation", () => {
    vi.useFakeTimers(); const deadline = managedRequestDeadline(new AbortController().signal, 50);
    vi.advanceTimersByTime(50); expect(deadline.signal.aborted).toBe(true); deadline.dispose();
  });
  it("cleans up its timer and cancellation listener after completion", () => {
    vi.useFakeTimers(); const caller = new AbortController(); const deadline = managedRequestDeadline(caller.signal, 50);
    deadline.dispose(); caller.abort(); vi.advanceTimersByTime(100); expect(deadline.signal.aborted).toBe(false);
  });
  it("never returns a token-bearing network error in diagnostics", () => {
    expect(managedTransportFailure(new TypeError('fetch failed https://example.invalid/callback/secret-token'))).toBe('transport-type-error');
    expect(managedTransportFailure(new Error('AbortSignal.any is not a function'))).toBe('signal-runtime');
  });
});
