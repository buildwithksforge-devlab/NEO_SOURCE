/** Uses the AbortController primitives supported by the deployed Worker runtime. */
export function managedRequestDeadline(caller: AbortSignal, timeoutMs = 45_000) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (caller.aborted) cancel();
  else caller.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      caller.removeEventListener("abort", cancel);
    },
  };
}

/** Never log raw errors: a network error can contain a secret callback URL. */
export function managedTransportFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/Illegal invocation/i.test(message)) return "illegal-invocation";
  if (/AbortSignal|abort.*function/i.test(message)) return "signal-runtime";
  if (/redirect/i.test(message)) return "redirect-rejected";
  if (/abort|timeout/i.test(message)) return "request-aborted";
  return error instanceof TypeError ? "transport-type-error" : "transport-unavailable";
}
