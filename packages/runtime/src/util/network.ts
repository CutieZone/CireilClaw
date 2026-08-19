const SINGLE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const INITIAL_RESPONSE_TIMEOUT_MS = 30_000;
const STREAM_IDLE_TIMEOUT_MS = 120_000;
const WEBHOOK_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutError = new Error(`Request timed out after ${timeoutMs}ms`);
  let rejectTimeout: ((reason: Error) => void) | undefined = undefined;
  const timeout = new Promise<Response>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    controller.abort(timeoutError);
    rejectTimeout?.(timeoutError);
  }, timeoutMs);

  try {
    return await Promise.race([fetch(input, { ...init, signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export {
  fetchWithTimeout,
  INITIAL_RESPONSE_TIMEOUT_MS,
  SINGLE_REQUEST_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_MS,
  WEBHOOK_TIMEOUT_MS,
};
